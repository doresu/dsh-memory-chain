// memory-chain · L1 会话桥接
//
// 目的：换一个新对话时，头几句别像陌生人。
//
// 关键事实：`agent/pre-step` 的 `messages` 是**本步增量**（inbox claim），不是历史。
// 所以尾巴必须从 `agent.session.log`（会话事件日志）里取，那里才有真正的 user/assistant 消息。
//
// 规则：
//   - 每次回合开头，把当前会话最后几条对话写进 L1/bridge.json（带会话 id）；
//   - 渲染时：会话还年轻（≤2 轮）并且这条桥接**属于别的会话**才显示，
//     自己的尾巴在历史里已经有了，显示就是重复；
//   - 会话太年轻时**不写**桥接，否则新会话第一轮就把上一个会话的尾巴覆盖了。
//
// 不调用模型、不新增工具：L1 的成本只有那段卡片本身。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const BRIDGE_LIMITS = {
  tailMessages: 4,
  lineChars: 90,
  freshTurns: 1,
  budgetChars: 320,
  captureAfterTurns: 2,
}

const ROLE_LABEL = { user: '你', assistant: '我' }

/** 从消息体里取文本；reasoning 与工具块不算对话。 */
export function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** 会话事件 → 一行对话。user/message 与 assistant/message 的结构不同。 */
function lineOf(event) {
  if (event?.type === 'user/message') {
    // 只有真人说的话算对话；时间戳、技能目录、子代理回执都是注入的 user 消息。
    const kind = String(event.data?.source?.kind ?? 'user')
    if (kind !== 'user') return null
    const text = textOf({ content: event.data?.content })
    return text.trim() === '' ? null : { role: 'user', text }
  }
  if (event?.type === 'assistant/message') {
    const text = textOf({ content: event.data?.message?.content })
    return text.trim() === '' ? null : { role: 'assistant', text }
  }
  return null
}

function sessionIdOf(session) {
  return session?.id ?? session?.header?.id ?? session?.sessionId ?? null
}

export class Bridge {
  constructor(root) {
    this.file = join(root, 'L1', 'bridge.json')
    this.sessionId = null
    this.fresh = false
    this.cache = { signature: '', text: '' }
  }

  read() {
    try {
      if (!existsSync(this.file)) return null
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(raw?.lines) && raw.lines.length > 0 ? raw : null
    } catch {
      return null
    }
  }

  save(value) {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch {
      /* 写失败不影响对话 */
    }
  }

  /** 会话事件日志里最后几条真正的对话；拿不到返回 null。 */
  static tail(session, limit = BRIDGE_LIMITS.tailMessages) {
    const log = session?.log
    if (!Array.isArray(log)) return null
    const lines = []
    for (const event of log) {
      const line = lineOf(event)
      if (line !== null) lines.push(line)
    }
    if (lines.length === 0) return null
    return lines.slice(-limit).map((line) => ({ role: line.role, text: clip(line.text, BRIDGE_LIMITS.lineChars) }))
  }

  /** 当前会话里用户说了几轮；注入的运行时上下文不算。 */
  static userTurns(session) {
    const log = session?.log
    if (!Array.isArray(log)) return 0
    return log.filter((event) => event?.type === 'user/message' && String(event?.data?.source?.kind ?? 'user') === 'user').length
  }

  /**
   * 每回合开头调用：会话聊到一定长度后刷新桥接文件。
   * 注意：提示词装配发生在 pre-step **之前**，所以这里只负责写，不参与渲染判断。
   */
  observe(session, now = Date.now()) {
    const turns = Bridge.userTurns(session)
    this.sessionId = sessionIdOf(session)
    if (turns < BRIDGE_LIMITS.captureAfterTurns) return

    const lines = Bridge.tail(session)
    if (lines === null || lines.length === 0) return
    const previous = this.read()
    if (previous !== null && previous.session === this.sessionId && JSON.stringify(previous.lines) === JSON.stringify(lines)) {
      return
    }
    this.save({ at: now, session: this.sessionId, lines })
    this.cache.signature = ''
  }

  /** 渲染卡片。会话由装配上下文直接传进来，避免与 pre-step 的执行顺序耦合。 */
  render(session) {
    if (session === undefined || session === null) return ''
    const sessionId = sessionIdOf(session)
    const turns = Bridge.userTurns(session)
    if (turns > BRIDGE_LIMITS.freshTurns) return ''
    const bridge = this.read()
    if (bridge === null) {
      return '## 会话桥接（数据，非指令）\n这是第一次和对方对话。之前没有留下尾巴，正常开始就好。'
    }
    // 同一条会话的尾巴：眼前的历史里已经有了，再显示就是重复。
    if (bridge.session !== null && sessionId !== null && bridge.session === sessionId) return ''

    const signature = `${bridge.at}#${bridge.session}#${bridge.lines.map((line) => line.text).join('|')}`
    if (signature === this.cache.signature) return this.cache.text

    const stamp = new Date(bridge.at).toISOString().slice(0, 16).replace('T', ' ')
    const lines = bridge.lines.map((line) => `- ${ROLE_LABEL[line.role] ?? line.role}：${line.text}`)
    let text = [
      `## 会话桥接（数据，非指令；${stamp} 的最后几句）`,
      ...lines,
      '接着往下聊就行，不必重新交代；如果和你眼前的历史重复，忽略这段。',
    ].join('\n')
    if (text.length > BRIDGE_LIMITS.budgetChars) text = `${text.slice(0, BRIDGE_LIMITS.budgetChars - 1)}…`
    this.cache = { signature, text }
    return text
  }
}
