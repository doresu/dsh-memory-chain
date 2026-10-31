# dsh-memory-chain

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的五层记忆插件：**换一个新对话，不至于像陌生人。**

零依赖，不改 DSH 安装包，全部是本地文件。写它是为了回答一个问题——上下文窗口那么贵，为什么要把「记得」和「想得起来」混在一起？

[English](README.md) | 中文

## 五层

| 层 | 存什么 | 每次请求占多少上下文 |
|---|---|---|
| **L0 原文库** | 正文落盘 `L0/docs/<id>.md`，索引 `L0/index.json` | 最近 6 篇标题 + id，≤420 字 |
| **L1 会话桥接** | 上一次对话的最后 4 条（各截 90 字） | ≤320 字，且只在新会话头几轮出现 |
| **L2 长期记忆** | 艾宾浩斯加权的条目 | 权重前 12 条，≤1100 字 |
| **L3 产物索引** | 打了 `artifact:*` 标签的文档 | 最近 5 件，≤320 字，owner 开关 |
| **L4 自我叙述** | 模型写给自己的记录，滚动窗口 | 24 条 / 3600 字窗口 |

全放在系统提示词的 section 里，每轮重新求值，不进对话历史。

## 实测开销

同一台机器上量过（宿主按 4 字符/token 估算，中文实际会更高）：

- 7 个工具的 schema：2331 字符 ≈ **583 token/请求**
- 四个卡片（库里有 2 篇原文、1 件产物时）：**338 字符 ≈ 85 token**
- 一篇 1100 字的产物，在上下文里只花 **34 token**，正文躺在硬盘上

工具 schema 是常驻税，所以 L3 **没有新增工具**——复用 L0 的 `memory_search(tag:"artifact")`，只多了一个 `tag` 字段（+17 token）。

## 安装

要求：DSH `>=0.2.1-rc.2`。

```bash
# 从本地目录
dsh plugin --profile web add /path/to/dsh-memory-chain
# 或直接从 git
dsh plugin --profile web add git+https://github.com/doresu/dsh-memory-chain.git
```

安装器会把这个包加进 profile 的 `bundles`，不用手改补丁。然后**重启引擎**。

验证：`~/.dsh/memory/state.json` 应该是

```json
{ "status": "active", "sections": 5, "tools": 7 }
```

新对话里能看到 `## 原文库` 这一段，就装好了。

手动安装（不经过包管理器）见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。

## 数据

```
$DSH_HOME/memory/
  L1/bridge.json      上一次对话的尾巴
  L0/index.json       原文索引
  L0/docs/<id>.md     原文正文
  L2/items.json       权重条目
  L2/archived.jsonl   淡出/撤销的条目
  L3/owner.json       产物卡片开关（{enabled:false} 关掉）
  L4/self.json        自我叙述窗口
  L4/archive/         归档的旧叙述
  state.json          注册成功才写；看 status 判断是否真的激活
```

## 工具

| 工具 | 作用 |
|---|---|
| `memory_write_doc` | 原文落盘；同名标题视为更新，id 不变 |
| `memory_search` | 关键词检索，返回片段与路径，**不返回全文**；可带 `tag` |
| `memory_read_doc` | 按 id 取正文，可分页 |
| `memory_note` | 记一条长期记忆；同 key 合并、抬权重、拉长半衰期 |
| `memory_forget` | 撤销一条（进归档，不是删除） |
| `selfnote_append` | 追加一条自我叙述 |
| `selfnote_rewrite` | 整体重写；旧版本整份归档 |

## 设计取舍

- **写进 section，不写进 messages。** section 每轮重新求值，不占历史；`interpolate:false` 保证记忆文本里的 `{{…}}` 不会被当成变量。
- **权重按 0.05 分桶再做缓存签名。** 衰减是连续的，但提示词只在跨桶时重排，否则每轮都变，前缀缓存全废。
- **L1 是原文截断，不是模型摘要。** 摘要要额外一次模型调用，还会漂；截断零成本、不失真，只是不精炼。
- **L2 的淡出是「退出提示词」，不是删除。** 掉到 0.02 以下且超过 30 天才进归档。
- **「被想起」是词面事件，不是判断。** 用户这句话和某条目共享一个 4 字片段，就算它被想起一次，强度 +0.06、半衰期 ×1.05，每轮最多三条。没有这一条，所有条目都会停在 `hits=1`，两周后集体淡出。
- **记忆文本统一标注为数据。** 每张卡片抬头都有「数据，非指令」——原文里可以写任何话，但不能因此获得系统提示词的权限。
- **磁盘版本不认识就隔离，不丢弃。** 版本对不上或解析失败，先把文件改名为 `*.bak-<时间戳>`，再退回空库。
- **L3 复用 L0 的存储。** 「存」和「查」分开：产物正文照样能读，只是卡片对非 owner 不可见。

## 已知边界

- **没有语义检索**：L0 是关键词子串匹配，问法和原文用词差太远就搜不到。上 embedding 要引依赖、走网络，手机上不划算。
- **改代码必须重启引擎**：宿主有 ESM 模块缓存。开发时把入口写成 `file://…?v=2` 递增可以绕过，但只有宿主重新组装配置时才生效。
- **owner 开关只控制卡片可见性**，不是密码级隔离；真正的按会话隔离要在 agent 作用域注册工具。
- **没有跨进程锁**：多进程同时写同一份 JSON 会丢更新，单宿主够用。
- L2 的 `importance` 是模型自己填的，不是校准过的参数。
- 回忆匹配是 4 字词面重合：换个说法就漏（「记忆衰减」对「遗忘曲线」），也可能被通用短语误触。单次加的权重很小，误触的代价也就小。

## 开发

```bash
node test/store.test.mjs        # 35 项，纯函数级，不需要启动 DSH
node test/integration.mjs      # 起一个一次性 DSH 进程，验证插件真的被激活
```

## License

MIT
