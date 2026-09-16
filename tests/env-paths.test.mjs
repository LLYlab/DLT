// DLT 环境表路径解析自测：默认解析 / 显式覆盖 / VS 安装根推导 / 覆盖清除
//
// 这一套只依赖 node 标准库，不需要起 Cordis，也不需要真的编译什么：
// 它盯的是「换一台机器不再需要改源码」这条契约。
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const core = await import('file:///C:/Users/L2959/.dsh/plugins/dlt/lib/core.js')

let pass = 0
let fail = 0
const fails = []
const section = (t) => console.log(`\n=== ${t} ===`)
const ok = (label, extra = '') => { console.log(`  [ ok ] ${label}${extra ? '  → ' + extra : ''}`); pass++ }
const bad = (label, why) => { console.log(`  [FAIL] ${label}  → ${why}`); fail++; fails.push(`${label}: ${why}`) }
async function check(label, fn) {
  try { const extra = await fn(); ok(label, extra || '') } catch (e) { bad(label, e && e.message ? e.message : String(e)) }
}

const EXPECTED_IDS = [
  'msvc-x64', 'msvc-x86', 'msvc-x64-x86', 'msvc-x86-x64', 'msbuild', 'vs-cmake', 'vs-ninja',
  'python312', 'python39', 'py-launcher', 'node', 'npm', 'git', 'dotnet',
  'windows-powershell', 'cmd', 'office-com', 'edge-headless',
]

// ── 1. 默认（无覆盖）────────────────────────────────────────────────────────
section('默认解析（不配任何东西）')

core.configureEnvironments({})

await check('环境 id 集合稳定（18 个，一个不多一个不少）', () => {
  const ids = core.describeEnvironments().map((e) => e.id).sort()
  const want = [...EXPECTED_IDS].sort()
  if (ids.length !== want.length) throw new Error(`数量 ${ids.length} != ${want.length}`)
  const diff = want.filter((id) => !ids.includes(id))
  if (diff.length) throw new Error('缺少 ' + diff.join(','))
  return `${ids.length} 个`
})

await check('每个环境都解析到真实存在的路径（探测 + 默认值兜底）', () => {
  const missing = core.describeEnvironments().filter((e) => !e.available)
  if (missing.length) throw new Error('不可用: ' + missing.map((m) => `${m.id}(${m.missing.join('|')})`).join(', '))
  return '18/18 可用'
})

await check('msvc 系的 vcvars 落在探测到的 VS 安装根下', () => {
  const env = core.resolveEnvironment('msvc-x64')
  if (!env.vcvars || !existsSync(env.vcvars)) throw new Error(`vcvars 不存在: ${env.vcvars}`)
  if (!/vcvarsall\.bat$/i.test(env.vcvars)) throw new Error('vcvars 路径不像 vcvarsall.bat: ' + env.vcvars)
  return env.vcvars
})

await check('msbuild / vs-cmake / vs-ninja 的 program 由同一个 VS 根推出', () => {
  const rootOf = (p) => p.replace(/\\(MSBuild|Common7)\\.*$/i, '')
  const mb = core.resolveEnvironment('msbuild').program
  const cm = core.resolveEnvironment('vs-cmake').program
  const nj = core.resolveEnvironment('vs-ninja').program
  const roots = new Set([mb, cm, nj].map(rootOf))
  if (roots.size !== 1) throw new Error('三条路径不在同一个 VS 根下: ' + [...roots].join(' / '))
  return [...roots][0]
})

// ── 2. 显式覆盖 ─────────────────────────────────────────────────────────────
section('config.environments 覆盖')

await check('覆盖 program 立即生效（git → 指定的 exe）', () => {
  const target = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  core.configureEnvironments({ git: { program: target } })
  const got = core.resolveEnvironment('git').program
  if (got !== target) throw new Error(`覆盖没生效: ${got}`)
  core.configureEnvironments({})
  return target
})

await check('覆盖的路径即使不存在也优先（不偷偷退回探测结果）', () => {
  const ghost = 'Z:\\does\\not\\exist\\fake.exe'
  core.configureEnvironments({ git: { program: ghost } })
  const got = core.resolveEnvironment('git').program
  core.configureEnvironments({})
  if (got !== ghost) throw new Error(`被探测结果顶掉了: ${got}`)
  return 'ghost 路径被如实保留'
})

await check('覆盖 vsRoot 后，vcvars 与 msbuild 的 program 一起跟着走', () => {
  const fakeRoot = 'Z:\\FakeVS\\2022\\Community'
  core.configureEnvironments({ msbuild: { vsRoot: fakeRoot } })
  const env = core.resolveEnvironment('msbuild')
  const wantVcvars = join(fakeRoot, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
  const wantProgram = join(fakeRoot, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe')
  const gotVcvars = env.vcvars
  const gotProgram = env.program
  core.configureEnvironments({})
  if (gotVcvars !== wantVcvars) throw new Error(`vcvars 没跟着走: ${gotVcvars}`)
  if (gotProgram !== wantProgram) throw new Error(`program 没跟着走: ${gotProgram}`)
  return 'vcvars + program 同步'
})

await check('覆盖 arch / label 生效', () => {
  core.configureEnvironments({ 'msvc-x64': { arch: 'amd64_x86', label: '自定义标签' } })
  const env = core.resolveEnvironment('msvc-x64')
  const arch = env.arch
  const label = env.label
  const row = core.describeEnvironments().find((e) => e.id === 'msvc-x64')
  core.configureEnvironments({})
  if (arch !== 'amd64_x86') throw new Error('arch 没生效: ' + arch)
  if (label !== '自定义标签') throw new Error('label 没生效: ' + label)
  if (row.label !== '自定义标签') throw new Error('describeEnvironments 没反映 label')
  return 'arch + label + describe 一致'
})

await check('覆盖后 describeEnvironments 如实标 missing（不掩盖）', () => {
  core.configureEnvironments({ 'edge-headless': { program: 'Z:\\nope\\msedge.exe' } })
  const row = core.describeEnvironments().find((e) => e.id === 'edge-headless')
  const available = row.available
  const missing = [...row.missing]
  core.configureEnvironments({})
  if (available) throw new Error('不存在的覆盖路径被标成可用')
  if (!missing.includes('Z:\\nope\\msedge.exe')) throw new Error('missing 里没有那条路径: ' + missing.join(','))
  return 'available=false, missing 带原因'
})

// ── 3. 清除覆盖 ─────────────────────────────────────────────────────────────
section('清除覆盖')

await check('configureEnvironments({}) 后回到自动解析（全部可用）', () => {
  core.configureEnvironments({ git: { program: 'Z:\\ghost\\git.exe' } })
  core.configureEnvironments({})
  const missing = core.describeEnvironments().filter((e) => !e.available)
  if (missing.length) throw new Error('清除后仍有不可用: ' + missing.map((m) => m.id).join(','))
  return '18/18 恢复可用'
})

await check('传非法值（null / 数组 / 字符串）不炸，按空覆盖处理', () => {
  for (const junk of [null, undefined, [], 'nonsense', 42]) {
    core.configureEnvironments(junk)
    if (!core.resolveEnvironment('git').program) throw new Error('传入 ' + JSON.stringify(junk) + ' 后解析不出 git')
  }
  core.configureEnvironments({})
  return '5 种非法输入都安全'
})

await check('未知环境 id 仍然报清晰的错', () => {
  try {
    core.environment('no-such-env')
    throw new Error('居然没抛错')
  } catch (e) {
    if (!/未知环境/.test(e.message)) throw new Error('错误信息不对: ' + e.message)
    return '报错含「未知环境」'
  }
})

console.log(`\n=== 结果: pass=${pass} fail=${fail} ===`)
if (fails.length) {
  console.log('失败项:')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
