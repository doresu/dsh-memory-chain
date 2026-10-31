// memory-chain · 五层记忆里的 L1（会话桥接）、L0（原文库）、L2（长期记忆权重）与 L4（自我叙述）
//
// 五个 systemPrompt section（每次组装重新求值，真正进系统提示词）+ 七个工具 + 一个
// 回合计数钩子。零依赖：本文件由 profile patch 按绝对路径加载，那里解析不到任何
// @deepseek-ai 包，所以只用 node: 内置模块。
//
// 数据：$DSH_HOME/memory/（可用 config.dataDir 覆盖）
//   L1/bridge.json      上一次对话的尾巴
//   L0/index.json       原文索引；L0/docs/<id>.md 是正文
//   L2/items.json       权重条目
//   L2/archived.jsonl   淡出或撤销的条目
//   L4/self.json        当前自我叙述窗口
//   L4/archive/*.md     归档的旧叙述

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Bridge, textOf } from './l1.js'
import { DocLibrary } from './l0.js'
import { MemoryStore } from './store.js'

export const name = 'memory-chain'

// cordis 要求声明依赖的服务：不声明就直接取 ctx.systemPrompt 会抛
// `cannot get property "systemPrompt" without inject`，插件静默不激活。
export const inject = ['systemPrompt', 'tools']

const OUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
    required: ['ok', 'summary'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.summary }],
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const root = config?.dataDir || join(home, 'memory')
  const nudgeEveryTurns = Number.isFinite(config?.nudgeEveryTurns) ? config.nudgeEveryTurns : 10
  const store = new MemoryStore(root)
  const library = new DocLibrary(root)
  const bridge = new Bridge(root)

  try {
    mkdirSync(join(root, 'L2'), { recursive: true })
    mkdirSync(join(root, 'L4', 'archive'), { recursive: true })
    library.ensure()
  } catch {
    /* 目录不可写就退化成只读，不影响对话 */
  }

  // ---- 提示词：三层都走 section，text 每次组装求值，真正写进系统提示词 ----
  const sections = [
    { name: 'memory:l1', order: 4950, text: (context) => bridge.render(context?.agent?.session) },
    { name: 'memory:l0', order: 5050, text: () => library.renderCatalog() },
    { name: 'memory:l3', order: 5075, text: () => library.renderArtifacts() },
    { name: 'memory:l2', order: 5100, text: () => store.renderL2() },
    { name: 'memory:l4', order: 5150, text: () => store.renderL4() },
  ]
  for (const section of sections) {
    ctx.systemPrompt.section({ ...section, interpolate: false })
  }

  // ---- 工具 ----
  ctx.tools.register({
    name: 'memory_note',
    description:
      '记录一条跨会话的长期记忆（偏好、约定、事实、关系）。同一个 key 再次记录会更新文本并抬高权重、拉长半衰期；不记录的事会随时间淡出。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '稳定的短标识，如"称呼"或"ml-preference"，重复使用同一个 key 才会累加权重' },
        text: { type: 'string', description: '要记住的具体内容，一行以内，240 字以内' },
        importance: { type: 'number', description: '0.1–1，越高衰减越慢；默认 0.6' },
      },
      required: ['key', 'text'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args) {
      const result = store.note(args)
      return { ok: true, summary: `已记住「${result.key}」，当前共 ${result.total} 条长期记忆。` }
    },
  })

  ctx.tools.register({
    name: 'memory_forget',
    description: '撤销一条长期记忆（被推翻或确认不再成立的旧事实）。条目会移入归档，不会真的消失。',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: '要撤销的条目 key' } },
      required: ['key'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args) {
      const result = store.forget(args.key)
      return {
        ok: result.removed,
        summary: result.removed ? `已撤销，剩 ${result.total} 条。` : '没有找到这个 key，未做改动。',
      }
    },
  })

  ctx.tools.register({
    name: 'selfnote_append',
    description:
      '给以后的自己留一条叙述：自己的判断、变化、在意的事。这是你写给自己的，不是设定。窗口满了最旧的会自动归档。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '一条自我叙述，500 字以内' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args) {
      const result = store.appendNote(args.text)
      return { ok: true, summary: `已写入自我叙述，窗口内 ${result.total} 条，累计归档 ${result.archived} 条。` }
    },
  })

  ctx.tools.register({
    name: 'selfnote_rewrite',
    description:
      '整体重写自我叙述：当现在这批记录已经不能代表你时使用。旧版本会整份归档，保留成长轨迹。',
    parameters: {
      type: 'object',
      properties: {
        notes: { type: 'array', items: { type: 'string' }, description: '新的叙述列表，从旧到新，建议 3–12 条' },
      },
      required: ['notes'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args) {
      const result = store.rewriteNotes(args.notes)
      return { ok: true, summary: `已重写自我叙述，窗口内 ${result.total} 条，累计归档 ${result.archived} 条。` }
    },
  })

  // ---- L0 原文库 ----
  ctx.tools.register({
    name: 'memory_write_doc',
    description:
      '把值得原文保留的长内容落盘成一篇文档（完整设计、长清单、原始数据、要反复引用的材料）。正文只进硬盘，上下文里只留标题和路径；同名标题视为同一篇、覆盖并保留 id。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题，80 字以内；同名即视为更新同一篇' },
        body: { type: 'string', description: '正文，markdown，20 万字以内' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，便于检索' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args) {
      const result = library.write(args)
      return {
        ok: true,
        summary: `${result.created ? '已新建' : '已更新'}《${args.title}》\nid：${result.id}\n路径：${result.path}`,
      }
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description:
      '在原文库里按关键词检索，返回标题、片段和文件路径，不返回全文。中文按子串匹配，空格分隔多个关键词。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔；留空则列出最近更新的几篇' },
        limit: { type: 'number', description: '返回条数，默认 5，最多 12' },
        tag: { type: 'string', description: '可选，只搜带这个标签的文档；产物用 artifact' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args) {
      const hits = library.search(args.query, args.limit, args.tag)
      if (hits.length === 0 && String(args.query ?? '').trim() !== '') library.logMiss(args.query, args.tag)
      if (hits.length === 0) return { ok: false, summary: '原文库里没有匹配的文档。' }
      const lines = hits.map((hit, i) => {
        const head = `${i + 1}. ${hit.title} · ${hit.id}`
        const snip = hit.snippet === '' ? '' : `\n   ${hit.snippet}`
        return `${head}${snip}\n   ${hit.path}`
      })
      return { ok: true, summary: `找到 ${hits.length} 篇：\n${lines.join('\n')}\n取全文用 memory_read_doc(id)。` }
    },
  })

  ctx.tools.register({
    name: 'memory_read_doc',
    description: '按 id 读原文库里的正文，可分页。默认读前 200 行。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'memory_search 或目录卡片里给出的 id' },
        offset: { type: 'number', description: '起始行，从 1 开始' },
        limit: { type: 'number', description: '读多少行，默认 200，最多 500' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args) {
      const doc = library.read(args.id, args.offset, args.limit)
      const head = `${doc.id}（第 ${doc.offset} 行起，共 ${doc.totalLines} 行）\n${doc.path}\n---\n`
      const budget = 3500
      const body = doc.text.length > budget ? `${doc.text.slice(0, budget)}\n…（还有 ${doc.totalLines - doc.offset - Math.ceil(budget / 40)} 行左右，用 offset 继续）` : doc.text
      return { ok: true, summary: `${head}${body}` }
    },
  })

  // ---- 每回合计数：只在回合的第一步（step===1）计数，攒够 N 轮就追加一行整理提醒 ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (payload?.step === 1) {
        store.tick(nudgeEveryTurns)
        bridge.observe(payload?.agent?.session)
        // 回忆事件：用户这句话里提到了哪条记忆，就算它被想起过一次。
        const lastUser = [...(payload?.messages ?? [])].reverse().find((message) => message?.role === 'user')
        if (lastUser !== undefined) store.recallFrom(textOf(lastUser))
      }
    } catch {
      /* 计数失败不影响本轮 */
    }
    return decision
  })

  // 注册全部成功后才写标记：这个文件存在 = 插件真的激活了。
  try {
    writeFileSync(
      join(root, 'state.json'),
      `${JSON.stringify({ loadedAt: new Date().toISOString(), pid: process.pid, version: 1, status: 'active', sections: 5, tools: 7 }, null, 2)}\n`,
    )
  } catch {
    /* ignore */
  }
}
