// 自测：不启动 DSH，直接跑 store 与插件 apply() 的逻辑。
// 运行：node test/store.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, LIMITS, decayed } from '../lib/store.js'
import { DocLibrary } from '../lib/l0.js'
import { Bridge, BRIDGE_LIMITS } from '../lib/l1.js'

const DAY = 86_400_000
const results = []
const test = (name, fn) => {
  try {
    fn()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}\n     ${error.message}`)
    process.exitCode = 1
  }
}

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-chain-'))
  return { dir, store: new MemoryStore(dir) }
}

const T0 = Date.UTC(2026, 9, 1)

test('新条目出现在提示里，带两位小数权重', () => {
  const { store } = fresh()
  store.note({ key: 'project', text: '这个项目叫 memory-chain', importance: 0.9 }, T0)
  const text = store.renderL2(T0)
  assert.match(text, /0\.\d\d · 这个项目/)
  assert.match(text, /共 1 条/)
})

test('同一 key 重复记录：权重抬高、半衰期变长、条目不重复', () => {
  const { store } = fresh()
  store.note({ key: '偏好', text: '喜欢直接说结论' }, T0)
  const before = store.l2().items[0]
  store.note({ key: '偏好', text: '喜欢直接说结论，不要铺垫' }, T0 + 1000)
  const after = store.l2().items[0]
  assert.equal(store.l2().items.length, 1)
  assert.ok(after.strength >= before.strength)
  assert.ok(after.halfLife > before.halfLife)
  assert.equal(after.hits, 2)
  assert.match(after.text, /不要铺垫/)
})

test('久不提起会衰减，30 天后掉到阈值以下', () => {
  const { store } = fresh()
  store.note({ key: '旧事', text: '曾经提过一次的小事' }, T0)
  const w0 = decayed(store.l2().items[0], T0)
  const w10 = decayed(store.l2().items[0], T0 + 10 * DAY)
  const w40 = decayed(store.l2().items[0], T0 + 40 * DAY)
  assert.ok(w0 > w10 && w10 > w40, `${w0} ${w10} ${w40}`)
  assert.ok(w40 < LIMITS.l2Threshold)
  assert.doesNotMatch(store.renderL2(T0 + 40 * DAY), /曾经提过一次的小事/)
})

test('常提起的条目比冷条目活得更久', () => {
  const { store } = fresh()
  store.note({ key: 'hot', text: '经常被提起的事' }, T0)
  store.note({ key: 'cold', text: '只提过一次的事' }, T0)
  for (let i = 1; i <= 6; i += 1) store.note({ key: 'hot', text: '经常被提起的事' }, T0 + i * 2 * DAY)
  const now = T0 + 20 * DAY
  const items = Object.fromEntries(store.l2().items.map((it) => [it.key, decayed(it, now)]))
  assert.ok(items.hot > items.cold, `${items.hot} vs ${items.cold}`)
})

test('权重只按两位小数桶参与提示，同桶不重排（保住缓存）', () => {
  const { store } = fresh()
  store.note({ key: 'a', text: '第一条' }, T0)
  const t1 = store.renderL2(T0)
  const t2 = store.renderL2(T0 + 60_000)
  assert.equal(t1, t2)
})

test('预算：条数与字数都有上限', () => {
  const { store } = fresh()
  for (let i = 0; i < 40; i += 1) store.note({ key: `k${i}`, text: `${'很长的记忆内容'.repeat(6)}${i}` }, T0)
  const { picked } = store.select(T0)
  assert.ok(picked.length <= LIMITS.l2MaxItems)
  const used = picked.reduce((n, p) => n + p.line.length + 1, 0)
  assert.ok(used <= LIMITS.l2BudgetChars, `用了 ${used} 字`)
})

test('forget 移入归档而不是删除', () => {
  const { store, dir } = fresh()
  store.note({ key: '错事', text: '记错的旧事实' }, T0)
  assert.equal(store.forget('错事', T0).removed, true)
  assert.equal(store.l2().items.length, 0)
  const archived = readFileSync(join(dir, 'L2', 'archived.jsonl'), 'utf8')
  assert.match(archived, /记错的旧事实/)
})

test('L4 窗口满时最旧的归档，计数递增', () => {
  const { store, dir } = fresh()
  for (let i = 0; i < LIMITS.l4MaxNotes + 5; i += 1) {
    store.appendNote(`第 ${i} 条自我叙述`, T0 + i * DAY)
  }
  const state = store.l4()
  assert.equal(state.notes.length, LIMITS.l4MaxNotes)
  assert.equal(state.archived, 5)
  assert.doesNotMatch(store.renderL4(), /第 0 条自我叙述/)
  const files = readdirSync(join(dir, 'L4', 'archive'))
  assert.ok(files.length > 0)
})

test('L4 重写会整份归档旧版本', () => {
  const { store, dir } = fresh()
  store.appendNote('旧的自我', T0)
  store.rewriteNotes(['新的自我：我发现自己更愿意先确认再动手'], T0 + DAY)
  assert.match(store.renderL4(), /新的自我/)
  assert.doesNotMatch(store.renderL4(), /旧的自我/)
  const files = readdirSync(join(dir, 'L4', 'archive')).map((f) => readFileSync(join(dir, 'L4', 'archive', f), 'utf8')).join('\n')
  assert.match(files, /旧的自我/)
})

test('每 N 回合触发一次整理提醒', () => {
  const { store } = fresh()
  store.note({ key: 'x', text: '一件值得记住的事' }, T0)
  for (let i = 0; i < 9; i += 1) store.tick(10)
  assert.doesNotMatch(store.renderL2(T0), /补一次/)
  store.tick(10)
  assert.match(store.renderL2(T0), /补一次/)
  assert.doesNotMatch(store.renderL2(T0), /补一次/)
})

test('插件 apply() 注册五个 section、七个工具、一个钩子', async () => {
  const sections = []
  const tools = []
  const hooks = []
  const ctx = {
    systemPrompt: { section: (s) => sections.push(s) },
    tools: { register: (t) => tools.push(t) },
    on: (event, handler) => hooks.push({ event, handler }),
  }
  const { dir } = fresh()
  const plugin = await import('../lib/index.js')
  plugin.apply(ctx, { dataDir: dir })
  assert.deepEqual(sections.map((s) => s.name), ['memory:l1', 'memory:l0', 'memory:l3', 'memory:l2', 'memory:l4'])
  assert.ok(sections.every((s) => s.interpolate === false && typeof s.text === 'function'))
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'memory_forget',
    'memory_note',
    'memory_read_doc',
    'memory_search',
    'memory_write_doc',
    'selfnote_append',
    'selfnote_rewrite',
  ])
  assert.equal(hooks[0].event, 'agent/pre-step')
})

test('工具端到端：note → 提示 → forget', async () => {
  const tools = {}
  const ctx = {
    systemPrompt: { section() {} },
    tools: { register: (t) => { tools[t.name] = t } },
    on() {},
  }
  const { dir } = fresh()
  const plugin = await import('../lib/index.js')
  plugin.apply(ctx, { dataDir: dir })
  const noted = await tools.memory_note.execute({ key: 'e2e', text: '端到端写入的记忆' }, {})
  assert.equal(noted.ok, true)
  const store = new MemoryStore(dir)
  assert.match(store.renderL2(Date.now()), /端到端写入的记忆/)
  const forgotten = await tools.memory_forget.execute({ key: 'e2e' }, {})
  assert.equal(forgotten.ok, true)
})


// ---------------- L0 原文库 ----------------

test('L0：写入落盘，索引里有标题、路径、字数', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  const res = lib.write({ title: '五层记忆的原始设计', body: 'L0 是原文库，L1 是桥接摘要。', tags: ['记忆'] }, T0)
  assert.equal(res.created, true)
  const entry = lib.index().docs[0]
  assert.equal(entry.title, '五层记忆的原始设计')
  assert.ok(entry.path.includes('L0/docs/'))
  assert.equal(entry.chars, 'L0 是原文库，L1 是桥接摘要。'.length)
  assert.match(readFileSync(entry.path, 'utf8'), /^# 五层记忆的原始设计/)
})

test('L0：同标题覆盖为同一篇，id 不变，revision 递增', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  const first = lib.write({ title: '同一篇', body: '第一版' }, T0)
  const second = lib.write({ title: '同一篇', body: '第二版' }, T0 + 1000)
  assert.equal(first.id, second.id)
  assert.equal(lib.index().docs.length, 1)
  assert.equal(lib.index().docs[0].revisions, 2)
  assert.match(readFileSync(second.path, 'utf8'), /第二版/)
})

test('L0：标题命中权重高于正文，返回片段与路径', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  lib.write({ title: '艾宾浩斯曲线参数', body: '半衰期三天，命中一次乘 1.8。' }, T0)
  lib.write({ title: '插件踩坑', body: '顺便提一句艾宾浩斯，但这里讲的是 inject。' }, T0 + 1000)
  const hits = lib.search('艾宾浩斯')
  assert.equal(hits.length, 2)
  assert.match(hits[0].title, /艾宾浩斯曲线参数/)
  assert.ok(hits[0].score > hits[1].score)
  assert.ok(hits[0].snippet !== '')
  assert.ok(hits[0].path.endsWith('.md'))
  assert.ok(!('body' in hits[0]))
})

test('L0：空查询按更新时间倒序', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  lib.write({ title: '旧的', body: 'x' }, T0)
  lib.write({ title: '新的', body: 'y' }, T0 + 10 * DAY)
  assert.equal(lib.search('')[0].title, '新的')
})

test('L0：分页读正文', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  const body = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行`).join('\n')
  const { id } = lib.write({ title: '长文', body }, T0)
  const page = lib.read(id, 10, 5)
  assert.equal(page.offset, 10)
  // 正文前是标题行和空行，所以文件第 10 行是正文第 8 行
  assert.match(page.text, /^第 8 行/)
  assert.equal(page.text.split('\n').length, 5)
  assert.ok(page.totalLines > 50)
})

test('L0：非法 id 拒绝读取（防目录穿越）', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  assert.throws(() => lib.read('../../etc/passwd'), /非法/)
  assert.throws(() => lib.read('a/b'), /非法/)
})

test('L0：目录卡片只放标题与 id，受预算约束且可缓存', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  for (let i = 0; i < 20; i += 1) lib.write({ title: `复盘第 ${i} 篇`, body: '很长的正文'.repeat(100) }, T0 + i * 1000)
  const text = lib.renderCatalog()
  assert.match(text, /共 20 篇/)
  assert.ok(text.length <= 421, `目录卡片 ${text.length} 字`)
  assert.doesNotMatch(text, /很长的正文/)
  assert.equal(text, lib.renderCatalog())
})

test('L0 工具端到端：写 → 搜 → 读', async () => {
  const tools = {}
  const ctx = { systemPrompt: { section() {} }, tools: { register: (t) => { tools[t.name] = t } }, on() {} }
  const { dir } = fresh()
  const plugin = await import('../lib/index.js')
  plugin.apply(ctx, { dataDir: dir })
  const wrote = await tools.memory_write_doc.execute({ title: '端到端原文', body: '这里有独一无二的关键词：蓝鲸' }, {})
  assert.equal(wrote.ok, true)
  const found = await tools.memory_search.execute({ query: '蓝鲸' }, {})
  assert.equal(found.ok, true)
  assert.match(found.summary, /端到端原文/)
  const id = found.summary.match(/· ([a-z0-9-]+)/)[1]
  const readBack = await tools.memory_read_doc.execute({ id }, {})
  assert.match(readBack.summary, /蓝鲸/)
})

// ---------------- L3 产物索引 ----------------

test('L3：tag 过滤只返回产物，普通检索照旧', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  lib.write({ title: '一份交付物', body: '合同条款若干', tags: ['artifact:contract'] }, T0)
  lib.write({ title: '一篇笔记', body: '合同条款的思考', tags: ['note'] }, T0 + 1000)
  assert.equal(lib.search('合同', 5, 'artifact').length, 1)
  assert.equal(lib.search('合同').length, 2)
  assert.equal(lib.search('', 5, 'artifact')[0].title, '一份交付物')
})

test('L3：产物不从原文库卡片重复出现', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  lib.write({ title: '普通原文', body: '正文', tags: [] }, T0)
  lib.write({ title: '产物甲', body: '正文', tags: ['artifact:x'] }, T0 + 1000)
  const catalog = lib.renderCatalog()
  assert.match(catalog, /普通原文/)
  assert.doesNotMatch(catalog, /产物甲/)
  assert.match(lib.renderArtifacts(), /产物甲/)
})

test('L3：owner 关掉后产物卡片为空，正文仍可检索', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  lib.write({ title: '产物乙', body: '关键内容', tags: ['artifact:y'] }, T0)
  assert.match(lib.renderArtifacts(), /产物乙/)
  mkdirSync(join(dir, 'L3'), { recursive: true })
  writeFileSync(join(dir, 'L3', 'owner.json'), '{"enabled":false}\n')
  assert.equal(lib.renderArtifacts(), '')
  assert.equal(lib.search('关键内容', 5, 'artifact').length, 1)
})

test('L3：产物卡片有预算上限', () => {
  const { dir } = fresh()
  const lib = new DocLibrary(dir)
  for (let i = 0; i < 20; i += 1) lib.write({ title: `产物第 ${i} 件`, body: 'x', tags: ['artifact'] }, T0 + i * 1000)
  const text = lib.renderArtifacts()
  assert.ok(text.length <= 321, `产物卡片 ${text.length} 字`)
  assert.match(text, /共 20 件/)
})

// ---------------- L1 会话桥接 ----------------

const msg = (role, text) => ({ role, content: [{ type: 'text', text }] })

test('L1：新会话历史短，显示上次的尾巴', () => {
  const { dir } = fresh()
  const bridge = new Bridge(dir)
  bridge.observe([msg('user', '先做 L2 和 L4'), msg('assistant', '好，我写插件'), msg('user', '重启好了'), msg('assistant', '记忆已在提示词里')], T0)
  const text = bridge.render()
  assert.match(text, /会话桥接/)
  assert.match(text, /你：重启好了/)
  assert.match(text, /我：记忆已在提示词里/)
  assert.ok(text.length <= BRIDGE_LIMITS.budgetChars + 1)
})

test('L1：历史变长后自动隐藏，不和眼前历史重复', () => {
  const { dir } = fresh()
  const bridge = new Bridge(dir)
  const short = [msg('user', 'a'), msg('assistant', 'b')]
  bridge.observe(short, T0)
  assert.match(bridge.render(), /会话桥接/)
  const long = Array.from({ length: BRIDGE_LIMITS.freshHistory + 2 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `第 ${i} 条`))
  bridge.observe(long, T0 + 1000)
  assert.equal(bridge.render(), '')
})

test('L1：只留最后 4 条，每条截断到 90 字', () => {
  const { dir } = fresh()
  const bridge = new Bridge(dir)
  const long = '很长的内容'.repeat(60)
  bridge.observe([msg('user', '一'), msg('assistant', '二'), msg('user', '三'), msg('assistant', '四'), msg('user', long), msg('assistant', '六')], T0)
  const saved = bridge.read()
  assert.equal(saved.lines.length, BRIDGE_LIMITS.tailMessages)
  assert.ok(saved.lines.every((line) => line.text.length <= BRIDGE_LIMITS.lineChars))
  assert.match(saved.lines.at(-1).text, /六/)
})

test('L1：跳过注入的运行时上下文与非文本块', () => {
  const { dir } = fresh()
  const bridge = new Bridge(dir)
  bridge.observe([
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: [{ type: 'image', data: 'x' }] },
    msg('user', '真正的对话'),
  ], T0)
  const saved = bridge.read()
  assert.equal(saved.lines.length, 1)
  assert.equal(saved.lines[0].text, '真正的对话')
})

test('L1：尾巴没变就不重写文件', () => {
  const { dir } = fresh()
  const bridge = new Bridge(dir)
  const history = [msg('user', '同一句'), msg('assistant', '同样的回复')]
  bridge.observe(history, T0)
  const first = bridge.read()
  bridge.observe(history, T0 + 60_000)
  assert.equal(bridge.read().at, first.at)
})

test('L1：完全没有对话时不写入、不报错', () => {
  const { dir } = fresh()
  const bridge = new Bridge(dir)
  bridge.observe([], T0)
  assert.equal(bridge.read(), null)
  assert.match(bridge.render(), /第一次和对方对话/)
})

// ---------------- 回忆事件 / 版本校验 / 数据标记 ----------------

test('L2：用户提到某条记忆时算一次回忆，权重回升', () => {
  const { store } = fresh()
  store.note({ key: 'five', text: '五层记忆包括原文库和长期记忆' }, T0)
  const at = T0 + 20 * DAY
  const before = decayed(store.l2().items[0], at)
  const touched = store.recallFrom('你说的那个五层记忆，原文库那层怎么样', at)
  assert.deepEqual(touched, ['five'])
  assert.ok(decayed(store.l2().items[0], at) > before)
  assert.equal(store.l2().items[0].hits, 2)
})

test('L2：不相关的话不触发回忆，一轮最多触发三条', () => {
  const { store } = fresh()
  store.note({ key: 'a', text: '五层记忆的设计' }, T0)
  store.note({ key: 'b', text: '五层记忆的存储' }, T0)
  store.note({ key: 'c', text: '五层记忆的预算' }, T0)
  store.note({ key: 'd', text: '五层记忆的边界' }, T0)
  assert.deepEqual(store.recallFrom('今天天气不错', T0), [])
  assert.equal(store.recallFrom('再聊聊五层记忆', T0).length, 3)
})

test('L2：版本不认识时先备份再重建，不静默吞掉', () => {
  const { store, dir } = fresh()
  mkdirSync(join(dir, 'L2'), { recursive: true })
  writeFileSync(join(dir, 'L2', 'items.json'), JSON.stringify({ version: 99, items: [{ key: 'x' }] }))
  assert.equal(store.l2().items.length, 0)
  const backups = readdirSync(join(dir, 'L2')).filter((f) => f.includes('.bak-'))
  assert.equal(backups.length, 1)
})

test('L4 与 L0：坏文件同样进隔离区', () => {
  const { store, dir } = fresh()
  const lib = new DocLibrary(dir)
  mkdirSync(join(dir, 'L4'), { recursive: true })
  writeFileSync(join(dir, 'L4', 'self.json'), '{ 这不是 json')
  assert.equal(store.l4().notes.length, 0)
  assert.ok(readdirSync(join(dir, 'L4')).some((f) => f.includes('.bak-')))
  mkdirSync(join(dir, 'L0'), { recursive: true })
  writeFileSync(join(dir, 'L0', 'index.json'), JSON.stringify({ version: 7, docs: [] }))
  assert.equal(lib.index().docs.length, 0)
  assert.ok(readdirSync(join(dir, 'L0')).some((f) => f.includes('.bak-')))
})

test('五张卡片都标明「数据，非指令」', () => {
  const { dir } = fresh()
  const store = new MemoryStore(dir)
  const lib = new DocLibrary(dir)
  const bridge = new Bridge(dir)
  store.note({ key: 'k', text: '一条记忆' }, T0)
  store.appendNote('一条自我叙述', T0)
  lib.write({ title: '一篇原文', body: '正文' }, T0)
  lib.write({ title: '一件产物', body: '正文', tags: ['artifact:x'] }, T0)
  bridge.observe([{ role: 'user', content: [{ type: 'text', text: '你好' }] }], T0)
  for (const text of [store.renderL2(T0), store.renderL4(), lib.renderCatalog(), lib.renderArtifacts(), bridge.render()]) {
    assert.match(text, /数据，非指令/)
  }
})

console.log(results.join('\n'))
