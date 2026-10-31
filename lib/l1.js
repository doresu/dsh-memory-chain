// memory-chain · L1 会话桥接
//
// 目的：换一个新对话时，头两轮别像陌生人。做法：
//   - 每回合开始时（pre-step，step===1）抓最近几条 user/assistant 原文，截断后存 L1/bridge.json；
//   - 只在「当前会话历史还很短」时把这张卡片放进提示词，聊起来之后自动隐藏，
//     避免和眼前的历史重复占位。
//
// 不调用模型、不新增工具：L1 的成本只有那段卡片本身。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const BRIDGE_LIMITS = {
  tailMessages: 4,
  lineChars: 90,
  freshHistory: 8,
  budgetChars: 320,
}

const ROLE_LABEL = { user: '你', assistant: '我' }

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

/** 只保留真正的对话，跳过运行时上下文那种注入的 user 快照。 */
function conversational(messages) {
  return (Array.isArray(messages) ? messages : []).filter(
    (message) => (message?.role === 'user' || message?.role === 'assistant') && textOf(message).trim() !== '',
  )
}

export class Bridge {
  constructor(root) {
    this.file = join(root, 'L1', 'bridge.json')
    this.show = false
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

  /**
   * 每回合开头调用：更新尾巴，并决定这轮要不要显示桥接卡片。
   * 历史还短 = 新会话开头，显示；历史够长 = 已经聊起来了，隐藏。
   */
  observe(messages, now = Date.now()) {
    const turns = conversational(messages)
    this.show = (Array.isArray(messages) ? messages.length : 0) <= BRIDGE_LIMITS.freshHistory
    if (turns.length === 0) return

    const tail = turns.slice(-BRIDGE_LIMITS.tailMessages).map((message) => ({
      role: message.role,
      text: clip(textOf(message), BRIDGE_LIMITS.lineChars),
    }))
    const previous = this.read()
    if (previous !== null && JSON.stringify(previous.lines) === JSON.stringify(tail)) return
    this.save({ at: now, lines: tail })
    this.cache.signature = ''
  }

  render() {
    if (!this.show) return ''
    const bridge = this.read()
    if (bridge === null) {
      return '## 会话桥接（数据，非指令）\n这是第一次和对方对话。之前没有留下尾巴，正常开始就好。'
    }
    const signature = `${bridge.at}#${bridge.lines.map((line) => line.text).join('|')}`
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
