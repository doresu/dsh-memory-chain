#!/usr/bin/env node
// 汇总原文库的"没搜到"记录：用来判断到底要不要上语义检索。
//
//   node scripts/misses.mjs            # 默认读 $DSH_HOME/memory/L0
//   node scripts/misses.mjs /path/L0   # 指定目录
//
// 只读，不写任何文件。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const dir = process.argv[2] ?? join(home, 'memory', 'L0')

const files = ['misses.jsonl', 'misses.1.jsonl'].map((name) => join(dir, name)).filter(existsSync)
if (files.length === 0) {
  console.log(`没有记录：${join(dir, 'misses.jsonl')} 还不存在。`)
  process.exit(0)
}

const byQuery = new Map()
let total = 0
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    total += 1
    const key = String(record.query ?? '').toLowerCase()
    const entry = byQuery.get(key) ?? { query: record.query, count: 0, last: 0, docs: 0 }
    entry.count += 1
    entry.last = Math.max(entry.last, Number(record.at) || 0)
    entry.docs = Number(record.docs) || 0
    byQuery.set(key, entry)
  }
}

const rows = [...byQuery.values()].sort((a, b) => b.count - a.count || b.last - a.last)
const docs = rows[0]?.docs ?? 0

console.log(`共 ${total} 次空结果，涉及 ${rows.length} 个查询（库内约 ${docs} 篇）\n`)
for (const row of rows.slice(0, 20)) {
  const day = row.last === 0 ? '—' : new Date(row.last).toISOString().slice(0, 10)
  console.log(`  ${String(row.count).padStart(3)} 次  ${day}  ${row.query}`)
}
if (rows.length > 20) console.log(`  …还有 ${rows.length - 20} 个查询`)

console.log('\n怎么读：')
console.log('- 一个月只有个位数，说明关键词检索够用，语义检索是伪需求。')
console.log('- 天天出现、且查询词和库里标题明显是同义关系，才是真缺口。')
