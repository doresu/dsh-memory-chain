// memory-chain · 可选 Git 同步
//
// 记忆目录本身就是一个 git 工作区。手机与 Mac 各 clone 一份同一个私有仓库：
//   - 插件加载时 pull 一次
//   - 每次写记忆后，去抖几秒再 commit + push
//   - 每轮对话前，距上次 pull 超过间隔就再 pull 一次
// 全部异步、尽力而为：同步失败绝不影响对话，错误只记在 lastError 里。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const GIT_TIMEOUT = 20000

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: error === null || error === undefined,
        out: String(stdout ?? '').trim(),
        err: String(stderr ?? '').trim() || String(error?.message ?? ''),
      })
    })
  })
}

export class GitSync {
  constructor(root, config = {}) {
    this.root = root
    this.remote = String(config?.remote ?? '').trim()
    this.branch = String(config?.branch ?? 'main').trim() || 'main'
    this.enabled = this.remote !== ''
    this.pushDelayMs = Number.isFinite(config?.pushDelayMs) ? config.pushDelayMs : 8000
    this.pullIntervalMs = Number.isFinite(config?.pullIntervalMs) ? config.pullIntervalMs : 5 * 60 * 1000
    this.timer = null
    this.lastPull = 0
    this.lastError = ''
    this.pushing = false
    this.pulling = false
  }

  get ready() {
    return this.enabled && existsSync(join(this.root, '.git'))
  }

  schedulePush() {
    if (!this.ready) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.push()
    }, this.pushDelayMs)
    this.timer.unref?.()
  }

  maybePull() {
    if (!this.ready) return
    if (Date.now() - this.lastPull < this.pullIntervalMs) return
    void this.pull()
  }

  async pull() {
    if (!this.ready || this.pulling) return
    this.pulling = true
    try {
      const r = await git(this.root, ['pull', '--rebase', '--autostash', 'origin', this.branch])
      if (!r.ok) {
        this.lastError = r.err || r.out
        await git(this.root, ['rebase', '--abort'])
      } else if (r.out !== '' && r.out !== 'Already up to date.') {
        this.lastError = ''
      }
      this.lastPull = Date.now()
    } catch (error) {
      this.lastError = String(error?.message ?? error)
    } finally {
      this.pulling = false
    }
  }

  async push() {
    if (!this.ready || this.pushing) return
    this.pushing = true
    try {
      await git(this.root, ['add', '-A'])
      const diff = await git(this.root, ['diff', '--cached', '--quiet'])
      if (diff.ok) return // 没有变化，不产生空提交
      await git(this.root, ['commit', '-m', `memory sync ${new Date().toISOString()}`])
      let r = await git(this.root, ['push', 'origin', this.branch])
      if (!r.ok) {
        // 远端有新提交：先 rebase 再试一次
        const pr = await git(this.root, ['pull', '--rebase', '--autostash', 'origin', this.branch])
        if (pr.ok) {
          r = await git(this.root, ['push', 'origin', this.branch])
        } else {
          await git(this.root, ['rebase', '--abort'])
          this.lastError = pr.err || pr.out
        }
      }
      if (!r.ok) this.lastError = r.err || r.out
      else this.lastError = ''
    } catch (error) {
      this.lastError = String(error?.message ?? error)
    } finally {
      this.pushing = false
    }
  }
}
