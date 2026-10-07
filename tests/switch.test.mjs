// switch.test.mjs — DLT 运行期开关持久层的单测（纯 Node，不需要 Cordis）
//
// 覆盖：默认值来自 config、合并语义、落盘/读回、文件缺失与损坏时的降级。
//     node C:\Users\L2959\.dsh\plugins\dlt\tests\switch.test.mjs

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

import {
  MODULE_KEYS,
  describeSwitch,
  normalizeSwitch,
  readSwitch,
  readSwitchSync,
  switchDefaults,
  switchPath,
  writeSwitch,
} from '../lib/switch.js'

const WORK = join(os.tmpdir(), 'dlt-switch-test')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

let pass = 0
let fail = 0
const fails = []
const check = async (label, fn) => {
  try {
    const extra = await fn()
    console.log(`  [ ok ] ${label}${extra ? '  → ' + extra : ''}`)
    pass++
  } catch (error) {
    console.log(`  [FAIL] ${label}  → ${error && error.message ? error.message : error}`)
    fail++
    fails.push(label)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

console.log('=== DLT 开关持久层 ===')

await check('switchDefaults 只认布尔 config（其它走默认）', () => {
  const d = switchDefaults({ enabled: false, cost: false, run: true, documents: 'yes' })
  assert(d.enabled === false, 'enabled 未生效')
  assert(d.modules.cost === false && d.modules.run === true, '分模块未生效')
  assert(d.modules.documents === true, '非布尔应按默认 true')
  return JSON.stringify(d)
})

await check('normalizeSwitch 局部合并（没给的保持原值）', () => {
  const base = { enabled: true, modules: { cost: true, balance: false, documents: true, preview: true, environment: true, run: true } }
  const next = normalizeSwitch({ modules: { run: false } }, base)
  assert(next.enabled === true, 'enabled 不该被改动')
  assert(next.modules.run === false && next.modules.balance === false, '合并不对: ' + JSON.stringify(next.modules))
  const next2 = normalizeSwitch({ enabled: false }, next)
  assert(next2.enabled === false && next2.modules.run === false, 'enabled 单向合并失败')
  return describeSwitch(next2)
})

await check('无文件 → 用 config 默认值（source=config，不算错误）', async () => {
  const got = await readSwitch(join(WORK, 'empty'), switchDefaults({ run: false }))
  assert(got.source === 'config' && got.error === null, '降级不正确: ' + JSON.stringify(got))
  assert(got.state.modules.run === false, '默认值没生效')
  return got.path.split('\\').pop()
})

await check('写盘 → 读回（含 enabled/分模块）', async () => {
  const dir = join(WORK, 'roundtrip')
  const state = { enabled: false, modules: { cost: false, balance: true, documents: true, preview: true, environment: false, run: true } }
  const saved = await writeSwitch(dir, state)
  assert(saved.ok && existsSync(saved.path), '写盘失败: ' + saved.error)
  const text = readFileSync(saved.path, 'utf8')
  assert(text.includes('"version": 1'), '没有版本号')
  const got = await readSwitch(dir, switchDefaults({}))
  assert(got.source === 'file', '应来自文件')
  assert(got.state.enabled === false && got.state.modules.cost === false && got.state.modules.run === true, '读回不一致: ' + JSON.stringify(got.state))
  const sync = readSwitchSync(dir, switchDefaults({}))
  assert(sync.source === 'file' && sync.state.enabled === false, '同步读不一致')
  return saved.path
})

await check('默认目录 = <cacheDir>/switch.json（空则 DSH_HOME/dlt）', () => {
  const p = switchPath('C:\\tmp\\x')
  assert(p.endsWith(join('C:\\tmp\\x', 'switch.json')), 'cacheDir 拼接不对: ' + p)
  const d = switchPath('')
  assert(d.endsWith(join('dlt', 'switch.json')), '退回目录不对: ' + d)
  return p
})

await check('文件损坏 → 退回默认值 + 带原因（不抛）', async () => {
  const dir = join(WORK, 'broken')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'switch.json'), '{ this is not json', 'utf8')
  const got = await readSwitch(dir, switchDefaults({}))
  assert(got.source === 'config', '损坏时应用默认值')
  assert(got.error && got.error.includes('JSON'), '应带可读原因: ' + got.error)
  return got.error.slice(0, 40) + '…'
})

await check('MODULE_KEYS 与 UI 顺序一致', () => {
  assert(MODULE_KEYS.length === 7, '模块数应为 7')
  assert(MODULE_KEYS.join(',') === 'cost,balance,documents,preview,environment,run,draft', '顺序变了: ' + MODULE_KEYS.join(','))
  return MODULE_KEYS.join('/')
})

console.log(`\n=== 结果: pass=${pass} fail=${fail} ===`)
if (fails.length) { console.log('失败项:'); fails.forEach((x) => console.log('  - ' + x)) }
process.exit(fail ? 1 : 0)
