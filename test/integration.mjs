// 集成测试：把插件放进一个真实的 DSH 进程，确认它被真正激活。
//
// 单元测试全绿也证明不了「插件加载了」——`inject` 那个坑就是这么漏过去的：
// 宿主只打印一行 "1 entry did not activate"，然后照常运行。
//
// 这里起一个隔离的 DSH_HOME 跑 headless：它会在挂载完插件之后因为缺凭证退出，
// 那正是我们要的时点——只看插件有没有激活。
//
// 找不到 DSH 时直接跳过，所以 CI 里不需要 DSH。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..', 'lib', 'index.js')
const bin = process.env.DSH_BIN ?? '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

if (!existsSync(bin)) {
  console.log('skip: no DSH found; set DSH_BIN to a dsh bin.js to run this test')
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'memory-chain-it-'))
const dataDir = join(work, 'memory')
const patch = join(work, 'patch.yml')
writeFileSync(
  patch,
  ['- insert:', '    - id: memory-chain', `      name: file://${plugin}`, '      config:', `        dataDir: ${dataDir}`, ''].join('\n'),
)

const result = spawnSync(process.execPath, [bin, 'headless', '--patch', patch, 'x'], {
  cwd: work,
  env: { ...process.env, DSH_HOME: join(work, 'home') },
  encoding: 'utf8',
  timeout: 120_000,
})

const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
let failed = false
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failed = true
}

check(!/did not activate/.test(output), 'host activated the plugin (no "did not activate" warning)')

const stateFile = join(dataDir, 'state.json')
check(existsSync(stateFile), 'activation marker written to state.json')
if (existsSync(stateFile)) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  check(state.status === 'active', `state.status is active (got ${state.status})`)
  check(state.sections === 5, `5 sections registered (got ${state.sections})`)
  check(state.tools === 7, `7 tools registered (got ${state.tools})`)
}

if (failed) {
  console.log(`\nwork dir kept for inspection: ${work}`)
  process.exitCode = 1
} else {
  rmSync(work, { recursive: true, force: true })
}
