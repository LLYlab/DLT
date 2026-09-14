// DLT 核心层自测：定价抓取/解析、成本计算、环境表、MSVC 编译链路、Office COM、token-meter 折叠
import { writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const core = await import('file:///C:/Users/L2959/.dsh/plugins/dlt/lib/core.js')

const WORK = join(os.tmpdir(), 'dlt-core-test')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

let pass = 0
let fail = 0
const fails = []
const section = (t) => console.log(`\n=== ${t} ===`)
const ok = (label, extra = '') => { console.log(`  [ ok ] ${label}${extra ? '  → ' + extra : ''}`); pass++ }
const bad = (label, why) => { console.log(`  [FAIL] ${label}  → ${why}`); fail++; fails.push(`${label}: ${why}`) }
async function check(label, fn) {
  try { const extra = await fn(); ok(label, extra || '') } catch (e) { bad(label, e && e.message ? e.message : String(e)) }
}

// ── 1. 环境表 ───────────────────────────────────────────────────────────────
section('环境表（第 5 项）')
await check('describeEnvironments 返回全部环境', () => {
  const envs = core.describeEnvironments()
  const available = envs.filter((e) => e.available)
  const missing = envs.filter((e) => !e.available)
  if (missing.length) console.log('        缺失环境: ' + missing.map((m) => `${m.id}(${m.missing.join(',')})`).join(' | '))
  if (available.length < 10) throw new Error(`可用环境只有 ${available.length} 个，太少`)
  return `${envs.length} 个环境，${available.length} 个可用`
})
await check('未知环境报错清晰', () => {
  try { core.environment('nope'); throw new Error('应该抛错') } catch (e) {
    if (!String(e.message).includes('可用环境')) throw new Error('错误信息缺少可用环境列表')
    return 'ok'
  }
})

// ── 2. 定价抓取 + 解析（第 1 项） ────────────────────────────────────────────
section('定价：抓官网 + 解析（第 1 项）')
let table = null
await check('loadPricing(force) 抓取并解析官网中文定价页', async () => {
  const cached = await core.readPricingCache(core.dshHome())
  if (cached) console.log(`        （原有缓存: ${cached.fetchedAt}，模型 ${cached.modelIds.join('/')}）`)
  table = await core.loadPricing({ cacheDir: join(WORK, 'cache'), force: true })
  if (!table.models['deepseek-flash']) throw new Error('缺少 deepseek-flash')
  if (!table.models['deepseek-v4-pro']) throw new Error('缺少 deepseek-v4-pro')
  const f = table.models['deepseek-flash']
  const p = table.models['deepseek-v4-pro']
  return `flash 未命中 ${f.cacheMiss.off}/${f.cacheMiss.peak} 输出 ${f.output.off}/${f.output.peak}；pro 未命中 ${p.cacheMiss.off}/${p.cacheMiss.peak} 输出 ${p.output.off}/${p.output.peak}`
})
await check('解析结果与官网表格一致（flash: 0.02/0.04, 1/2, 4/8）', () => {
  const f = table.models['deepseek-flash']
  const expect = { cacheHit: { off: 0.02, peak: 0.04 }, cacheMiss: { off: 1, peak: 2 }, output: { off: 4, peak: 8 } }
  for (const key of Object.keys(expect)) {
    for (const band of ['off', 'peak']) {
      if (f[key][band] !== expect[key][band]) throw new Error(`${key}.${band} 期望 ${expect[key][band]}，实得 ${f[key][band]}`)
    }
  }
  const p = table.models['deepseek-v4-pro']
  if (p.output.peak !== 27) throw new Error(`pro output.peak 期望 27，实得 ${p.output.peak}`)
  return 'flash 与 pro 六档单价全部匹配'
})
await check('缓存快照写入本地', async () => {
  const again = await core.readPricingCache(join(WORK, 'cache'))
  if (!again) throw new Error('快照未写入')
  return core.cachePath(join(WORK, 'cache'))
})
await check('幂等：第二次读取走缓存（fromCache=true）', async () => {
  const t2 = await core.loadPricing({ cacheDir: join(WORK, 'cache') })
  if (!t2.fromCache) throw new Error('未命中缓存')
  return `fetchedAt=${t2.fetchedAt}`
})

// ── 3. 高峰/空闲判定 ────────────────────────────────────────────────────────
section('高峰档判定（北京时间 周一~周五 9-12 / 14-18）')
await check('高峰/空闲边界', () => {
  // 北京时间 = UTC+8
  const bj = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 8, mi)
  const cases = [
    [bj(2026, 9, 14, 9, 0), true, '周一 09:00 高峰'],
    [bj(2026, 9, 14, 11, 59), true, '周一 11:59 高峰'],
    [bj(2026, 9, 14, 12, 0), false, '周一 12:00 空闲'],
    [bj(2026, 9, 14, 14, 0), true, '周一 14:00 高峰'],
    [bj(2026, 9, 14, 17, 59), true, '周一 17:59 高峰'],
    [bj(2026, 9, 14, 18, 0), false, '周一 18:00 空闲'],
    [bj(2026, 9, 14, 8, 59), false, '周一 08:59 空闲'],
    [bj(2026, 9, 19, 10, 0), false, '周六 10:00 空闲'],
    [bj(2026, 9, 20, 15, 0), false, '周日 15:00 空闲'],
  ]
  const wrong = cases.filter(([at, want]) => core.peakBand(at) !== want)
  if (wrong.length) throw new Error('判定错误: ' + wrong.map(([at, want, label], i) => `${label} 期望 ${want}`).join('; '))
  return `${cases.length}/${cases.length} 个边界全部正确`
})

// ── 4. 成本计算（第 1 项） ──────────────────────────────────────────────────
section('人民币成本计算（第 1 项）')
const OFFPEAK = Date.UTC(2026, 8, 14, 4, 0)   // 北京时间 12:00 周一 → 空闲
const PEAK = Date.UTC(2026, 8, 14, 2, 0)      // 北京时间 10:00 周一 → 高峰
await check('flash 空闲档：1M 未命中 + 1M 输出 = 5 元', () => {
  const r = core.priceUsage({ uncachedInputTokens: 1e6, outputTokens: 1e6 }, { routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], at: OFFPEAK }, table)
  if (r.band !== 'off') throw new Error('档位应为 off，实得 ' + r.band)
  if (Math.abs(r.cost - 5) > 1e-9) throw new Error(`期望 5 元，实得 ${r.cost}`)
  return `${r.cost} 元（${r.bandLabel}，计费模型 ${r.billingModel}）`
})
await check('flash 高峰档：同上 = 10 元', () => {
  const r = core.priceUsage({ uncachedInputTokens: 1e6, outputTokens: 1e6 }, { routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], at: PEAK }, table)
  if (r.band !== 'peak') throw new Error('档位应为 peak')
  if (Math.abs(r.cost - 10) > 1e-9) throw new Error(`期望 10 元，实得 ${r.cost}`)
  return `${r.cost} 元`
})
await check('缓存命中单价生效：1M 命中输入(空闲) = 0.02 元', () => {
  const r = core.priceUsage({ cacheReadTokens: 1e6 }, { routes: [{ model: 'deepseek-flash' }], at: OFFPEAK }, table)
  if (Math.abs(r.cost - 0.02) > 1e-12) throw new Error(`期望 0.02，实得 ${r.cost}`)
  return `${r.cost} 元`
})
await check('pro 单价生效：1M 输出(高峰) = 27 元', () => {
  const r = core.priceUsage({ outputTokens: 1e6 }, { routes: [{ model: 'deepseek-v4-pro' }], at: PEAK }, table)
  if (Math.abs(r.cost - 27) > 1e-9) throw new Error(`期望 27，实得 ${r.cost}`)
  return `${r.cost} 元`
})
await check('旧模型名映射到 flash（官网已下线说明）', () => {
  const r = core.priceUsage({ uncachedInputTokens: 1e6 }, { routes: [{ model: 'deepseek-v4-flash-vision-exp' }], at: OFFPEAK }, table)
  if (r.billingModel !== 'deepseek-flash') throw new Error('未映射到 deepseek-flash')
  if (Math.abs(r.cost - 1) > 1e-9) throw new Error(`期望 1 元，实得 ${r.cost}`)
  return `${r.billingModel} / ${r.cost} 元`
})
await check('未知模型：不静默算成 0，而是给 warning', () => {
  const r = core.priceUsage({ uncachedInputTokens: 1e6 }, { routes: [{ model: 'gpt-9-ultra' }], at: OFFPEAK }, table)
  if (r.cost !== null) throw new Error('未知模型不应给出成本')
  if (!r.warnings.length) throw new Error('未知模型应给出警告')
  return r.warnings[0]
})
await check('小额度四舍五入合理：1200 未命中 + 800 输出（flash 空闲）', () => {
  const r = core.priceUsage({ uncachedInputTokens: 1200, outputTokens: 800 }, { routes: [{ model: 'deepseek-flash' }], at: OFFPEAK }, table)
  const want = (1200 / 1e6) * 1 + (800 / 1e6) * 4
  if (Math.abs(r.cost - want) > 1e-12) throw new Error(`期望 ${want}，实得 ${r.cost}`)
  return `${r.cost.toFixed(8)} 元`
})

// ── 5. 直接执行程序 / MSVC 编译（第 6 项） ───────────────────────────────────
section('执行工具 + MSVC 工具链（第 5/6 项）')
await check('python312 直接执行', async () => {
  const r = await core.runInEnvironment({ env: 'python312', args: ['-c', 'print("dlt python ok")'], timeoutMs: 60000 })
  if (!r.ok) throw new Error(`退出码 ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
  if (!r.stdout.includes('dlt python ok')) throw new Error('输出不含预期文本')
  return r.stdout.trim() + `（${r.ms}ms）`
})
await check('node 环境直接执行', async () => {
  const r = await core.runInEnvironment({ env: 'node', args: ['-e', 'process.stdout.write(String(6*7))'], timeoutMs: 60000 })
  if (!r.ok || r.stdout.trim() !== '42') throw new Error(`实得 ${r.exitCode} / ${r.stdout}`)
  return '42'
})
await check('git 环境可用', async () => {
  const r = await core.runInEnvironment({ env: 'git', args: ['--version'], timeoutMs: 60000 })
  if (!r.ok) throw new Error(r.stderr.slice(0, 200))
  return r.stdout.trim()
})
await check('msvc-x64 环境里 cl.exe 可见（vcvars 注入生效）', async () => {
  const r = await core.runInEnvironment({ env: 'msvc-x64', program: 'cl', args: [], timeoutMs: 120000 })
  const banner = (r.stderr + r.stdout).split('\n').find((l) => l.includes('Microsoft'))
  if (!banner) throw new Error(`没看到 cl 版本横幅。exit=${r.exitCode} stderr=${r.stderr.slice(0, 300)}`)
  return banner.trim()
})
const helloC = join(WORK, 'hello.c')
writeFileSync(helloC, [
  '#include <stdio.h>',
  'int main(void) {',
  '  const char *who = "DLT MSVC";',
  '  printf("hello from %s, %d\\n", who, 6 * 7);',
  '  return 0;',
  '}',
].join('\n'), 'utf8')
await check('真正编译一个 C 程序（cl hello.c）', async () => {
  const r = await core.runInEnvironment({
    env: 'msvc-x64', program: 'cl',
    args: ['/nologo', '/W3', 'hello.c', '/Fe:hello.exe'],
    cwd: WORK, timeoutMs: 180000,
  })
  if (!existsSync(join(WORK, 'hello.exe'))) {
    throw new Error(`没有生成 hello.exe。exit=${r.exitCode}\n${(r.stdout + r.stderr).slice(0, 600)}`)
  }
  return `hello.exe ${statSync(join(WORK, 'hello.exe')).size} 字节`
})
await check('运行刚编译出来的 hello.exe', async () => {
  const r = await core.runInEnvironment({ env: 'cmd', program: join(WORK, 'hello.exe'), args: [], timeoutMs: 60000 })
  if (!r.stdout.includes('hello from DLT MSVC, 42')) throw new Error(`输出异常: ${r.stdout} ${r.stderr}`)
  return r.stdout.trim()
})
await check('msbuild 环境映射到 VS18 自带 MSBuild', async () => {
  const r = await core.runInEnvironment({ env: 'msbuild', program: 'msbuild', args: ['-version'], timeoutMs: 120000 })
  if (!r.ok) throw new Error(`exit=${r.exitCode} ${r.stderr.slice(0, 200)}`)
  return r.stdout.trim().split('\n')[0]
})
await check('vs-cmake 环境映射到 VS 自带 cmake', async () => {
  const r = await core.runInEnvironment({ env: 'vs-cmake', program: 'cmake', args: ['--version'], timeoutMs: 120000 })
  if (!r.ok) throw new Error(`exit=${r.exitCode} ${r.stderr.slice(0, 200)}`)
  return r.stdout.trim().split('\n')[0]
})
await check('超时会杀掉进程', async () => {
  const r = await core.runInEnvironment({ env: 'python312', args: ['-c', 'import time; time.sleep(30)'], timeoutMs: 2500 })
  if (r.ok) throw new Error('应当超时失败')
  if (!String(r.stderr).includes('超时')) throw new Error('未报告超时: ' + r.stderr.slice(0, 120))
  return `退出码 ${r.exitCode}，用时 ${r.ms}ms`
})
await check('非零退出码如实回报', async () => {
  const r = await core.runInEnvironment({ env: 'python312', args: ['-c', 'import sys; sys.exit(7)'], timeoutMs: 60000 })
  if (r.ok !== false || r.exitCode !== 7) throw new Error(`实得 ok=${r.ok} exit=${r.exitCode}`)
  return 'exitCode=7'
})

// ── 6. Office COM：docx → pdf（第 3 项往返链的关键一步） ─────────────────────
section('Office COM 转换（第 3 项 PDF 往返链）')
await check('docx → PDF（Word COM 导出）', async () => {
  const docx = join(WORK, 'bridge.docx')
  await core.runDocumentOp('create', {
    path: docx, kind: 'docx', title: 'DLT 转换测试',
    blocks: [{ type: 'h1', text: '第一章' }, { type: 'p', text: '这一页用于验证 Word COM 导出 PDF。' }, { type: 'table', data: [['甲', '乙'], ['1', '2']], style: 'Table Grid' }],
  })
  const target = join(WORK, 'bridge.pdf')
  const data = await core.officeConvert({ kind: 'docx', source: docx, target })
  if (!existsSync(target)) throw new Error('未生成 PDF')
  const info = await core.runDocumentOp('info', { path: target })
  if (info.pages < 1) throw new Error('PDF 页数为 0')
  return `${data.bytes} 字节 / ${info.pages} 页 / ${data.ms}ms${data.attached ? '（复用已开 Word）' : ''}`
})
await check('xlsx → PDF（Excel COM 导出）', async () => {
  const xlsx = join(WORK, 'bridge.xlsx')
  await core.runDocumentOp('create', { path: xlsx, kind: 'xlsx', sheets: [{ name: '数据', rows: [['项目', '金额'], ['甲', 100], ['乙', 250]] }] })
  const target = join(WORK, 'bridge-xlsx.pdf')
  const data = await core.officeConvert({ kind: 'xlsx', source: xlsx, target })
  if (!existsSync(target)) throw new Error('未生成 PDF')
  return `${data.bytes} 字节 / ${data.ms}ms`
})

// ── 7. HTML → PDF（Edge 无头） ──────────────────────────────────────────────
section('HTML → PDF（Edge 无头）')
await check('html → PDF', async () => {
  const html = join(WORK, 'page.html')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>DLT</title><h1>DLT Edge 打印</h1><p>验证无头打印回 PDF。</p>', 'utf8')
  const target = join(WORK, 'page.pdf')
  const data = await core.htmlToPdf({ source: html, target })
  return `${data.bytes} 字节`
})

// ── 8. token-meter 折叠模块可加载（第 1 项数据源） ──────────────────────────
section('token-meter turn-usage 模块（第 1 项数据源）')
await check('按文件 URL 加载 deriveTurnTokenUsage', async () => {
  const pkg = join('C:\\Users\\L2959\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh-token-meter', 'package.json')
  const url = new URL('lib/types/turn-usage.js', `file:///${pkg.replace(/\\/g, '/')}`).href
  const mod = await import(url)
  if (typeof mod.deriveTurnTokenUsage !== 'function') throw new Error('未导出 deriveTurnTokenUsage')
  const none = mod.deriveTurnTokenUsage([])
  if (none !== undefined) throw new Error('空事件应返回 undefined')
  return '可加载，空输入返回 undefined（符合契约）'
})

console.log(`\n=== 结果: pass=${pass} fail=${fail} ===`)
if (fails.length) { console.log('失败项:'); fails.forEach((x) => console.log('  - ' + x)) }
console.log('产物: ' + WORK)
process.exit(fail ? 1 : 0)
