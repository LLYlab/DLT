// host.test.mjs — DLT Host 半区的回归冒烟测试
//
// 用真实 Cordis Context 装载插件，然后像 DSH 那样调用它注册的模型工具与 typert 端点。
// 覆盖：装载与注册、环境表、执行工具、文档读写、预览端点、定价与每轮成本、余额、相对路径解析。
//
// 必须放在 ancestors 里有 @deepseek-ai 与 dlt 的目录下运行（即 profile 目录）：
//     cd C:\Users\L2959\.dsh\profiles\web
//     node C:\Users\L2959\.dsh\plugins\dlt\tests\host.test.mjs
// 原因是 ESM 按导入方的**真实路径**解析裸包名，而 dlt 的真实路径在 plugins 下，
// 只有从 profile 里导入 dsh-light-tool 才能用上 junction。

import { Context, Service } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const dlt = await import('dsh-light-tool')

const WORK = join(os.tmpdir(), 'dlt-host-test')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

let pass = 0
let fail = 0
const fails = []
const section = (t) => console.log(`\n=== ${t} ===`)
const ok = (l, extra = '') => { console.log(`  [ ok ] ${l}${extra ? '  → ' + extra : ''}`); pass++ }
const bad = (l, why) => { console.log(`  [FAIL] ${l}  → ${why}`); fail++; fails.push(`${l}: ${why}`) }
async function check(label, fn) {
  try { const extra = await fn(); ok(label, extra || '') } catch (e) { bad(label, e && e.message ? e.message : String(e)) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

// ── 假服务（在根 context 上构造，兄弟插件才看得见） ─────────────────────────
class FakeTypert extends Service {
  constructor(ctx) { super(ctx, 'typert'); this.registrations = [] }
  register(spec) { this.registrations.push(spec) }
}
class FakeTools extends Service {
  constructor(ctx) { super(ctx, 'tools'); this.defs = new Map() }
  // 真实 dsh-tools 的 register() 返回 disposer（内部走 ctx.effect），所以假货也必须返回，
  // 否则「关掉开关卸工具」这条路在测试里根本走不到。
  register(def) {
    this.defs.set(def.name, def)
    const self = this
    return function () { if (self.defs.get(def.name) === def) self.defs.delete(def.name) }
  }
}
class FakeSystemPrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt'); this.sections = [] }
  section(entry) {
    this.sections.push(entry)
    const self = this
    return function () { const i = self.sections.indexOf(entry); if (i >= 0) self.sections.splice(i, 1) }
  }
}
class FakeCredentials extends Service {
  constructor(ctx, key) { super(ctx, 'credentials'); this.key = key }
  async resolve(ref) {
    return ref === 'DEEPSEEK_API_KEY' && this.key ? { value: this.key, source: 'credentials' } : undefined
  }
}
class FakeSessionQuery extends Service {
  constructor(ctx) { super(ctx, 'sessionQuery'); this.registry = new Map() }
  async readSession(id) {
    if (!this.registry.has(id)) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND: ' + id)
    return this.registry.get(id)
  }
}
class FakeSessions extends Service {
  constructor(ctx, cwd) { super(ctx, 'sessions'); this.cwd = cwd }
  get(id) { return { id, meta: { cwd: this.cwd } } }
  list() { return [] }
}

let apiKey = null
try {
  const text = readFileSync(join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const m = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text)
  apiKey = m ? m[1] : null
} catch { apiKey = null }

const app = new Context()
const services = {
  typert: new FakeTypert(app),
  tools: new FakeTools(app),
  systemPrompt: new FakeSystemPrompt(app),
  credentials: new FakeCredentials(app, apiKey),
  sessionQuery: new FakeSessionQuery(app),
  sessions: new FakeSessions(app, WORK),
}
assert(app.get('typert'), 'typert 假服务未注册到根')
assert(app.get('tools'), 'tools 假服务未注册到根')

const config = {
  cost: true, balance: true, documents: true, preview: true, environment: true, run: true,
  pythonEnv: 'python312', cacheDir: join(WORK, 'cache'), pricingMaxAgeMs: 24 * 3600 * 1000,
  balanceApiBase: 'https://api.deepseek.com', balanceApiKeyEnv: 'DEEPSEEK_API_KEY', balanceCacheMs: 0,
  docTimeoutMs: 300000, runTimeoutMs: 120000, maxOutputBytes: 262144,
  promptSection: true, promptOrder: 140,
  defaultSolution: '', defaultConfiguration: 'Debug', defaultPlatform: 'x64',
  previewMaxRows: 400, previewMaxCols: 40,
}

// 注意：ctx.plugin() 返回 Fiber（不是 thenable），必须显式 await fiber.await() 才算激活。
const fiber = app.plugin(dlt.default, config)
await fiber.await()
const service = app.get('dlt')
const tool = (n) => services.tools.defs.get(n)

// ── 装载 ────────────────────────────────────────────────────────────────────
section('装载与注册')
await check('apply 产出 Host 服务', () => {
  assert(service instanceof Service, '不是 Cordis Service')
  return service.constructor.name
})
await check('typert 端点齐全', () => {
  const specs = services.typert.registrations
  assert(specs.length, '没有 typert 注册')
  // namespace 在每条 invocation 上（与 dbs/topo 的写法一致），不在顶层 spec 上。
  const spec = specs[specs.length - 1]
  const methods = spec.invocations.map((i) => i.method)
  for (const w of ['status', 'balance', 'cost', 'office', 'pricingInfo', 'envs']) {
    assert(methods.includes(w), '缺少端点 ' + w)
  }
  const namespaces = [...new Set(spec.invocations.map((i) => i.namespace))]
  assert(namespaces.length === 1 && namespaces[0] === 'dlt', 'namespace 不是 dlt: ' + namespaces.join(','))
  assert(spec.invocations.every((i) => i.service === 'dlt'), 'service 不是 dlt')
  return `namespace=${namespaces[0]}，端点 ${methods.join(', ')}`
})
await check('6 个模型工具注册', () => {
  const names = [...services.tools.defs.keys()].sort()
  for (const w of ['dlt_build', 'dlt_doc_convert', 'dlt_doc_read', 'dlt_doc_write', 'dlt_env', 'dlt_run']) {
    assert(names.includes(w), '缺少 ' + w)
  }
  return names.join(', ')
})
await check('系统提示注入了环境表', () => {
  const sec = services.systemPrompt.sections.find((s) => s.name === 'tool:dlt')
  assert(sec, '没有 tool:dlt 段')
  assert(sec.text.includes('msvc-x64') && sec.text.includes('dlt_run'), '内容不完整')
  return `${sec.text.split('\n').length} 行`
})

// ── 环境表与执行 ────────────────────────────────────────────────────────────
section('环境表与执行工具')
await check('dlt_env 列表', async () => {
  const res = await tool('dlt_env').execute({})
  assert(res.ok && res.environments.length >= 10, '环境太少')
  return `${res.environments.length} 个，${res.environments.filter((e) => e.available).length} 可用`
})
await check('dlt_run env=git', async () => {
  const res = await tool('dlt_run').execute({ env: 'git', program: 'git', args: ['--version'] })
  assert(res.ok, res.stderr)
  return res.stdout.trim()
})
await check('dlt_run env=msvc-x64 真编译 C 程序', async () => {
  const c = join(WORK, 'host_hello.c')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(c, '#include <stdio.h>\nint main(void){printf("host-level msvc ok\\n");return 0;}\n', 'utf8')
  await tool('dlt_run').execute({ env: 'msvc-x64', program: 'cl', args: ['/nologo', 'host_hello.c', '/Fe:host_hello.exe'], cwd: WORK, timeoutMs: 180000 })
  assert(existsSync(join(WORK, 'host_hello.exe')), '没生成 exe')
  const run = await tool('dlt_run').execute({ env: 'cmd', program: join(WORK, 'host_hello.exe'), args: [] })
  assert(run.stdout.includes('host-level msvc ok'), '输出异常')
  return run.stdout.trim()
})
await check('dlt_build 无 target 给可读错误', async () => {
  const res = await tool('dlt_build').execute({})
  assert(res.ok === false && res.error.includes('defaultSolution'), '错误信息不到位')
  return res.error.slice(0, 50) + '…'
})

// ── 文档工具 ────────────────────────────────────────────────────────────────
section('文档读写工具')
const docx = join(WORK, 't.docx')
const xlsx = join(WORK, 't.xlsx')
const pdf = join(WORK, 't.pdf')
await check('建 docx / xlsx / pdf', async () => {
  const a = await tool('dlt_doc_write').execute({ path: docx, action: 'create', kind: 'docx', spec: { title: 'T', blocks: [{ type: 'p', text: '正文 English' }, { type: 'table', data: [['A', 'B'], ['1', '2']], style: 'Table Grid' }] } })
  const b = await tool('dlt_doc_write').execute({ path: xlsx, action: 'create', kind: 'xlsx', spec: { sheets: [{ name: '数据', rows: [['项', '值'], ['甲', 1]] }] } })
  const c = await tool('dlt_doc_write').execute({ path: pdf, action: 'create', kind: 'pdf', spec: { pages: [{ text: 'DLT host smoke PDF' }] } })
  for (const r of [a, b, c]) assert(r.ok, r.error)
  return 'docx / xlsx / pdf 全部创建成功'
})
await check('读回 docx（段落+表格）', async () => {
  const res = await tool('dlt_doc_read').execute({ path: docx })
  assert(res.ok && res.data.blocks.length && res.data.tables.length, '内容不完整')
  return `blocks=${res.data.blocks.length} tables=${res.data.tables.length}`
})
await check('改 docx 并自动备份', async () => {
  const res = await tool('dlt_doc_write').execute({ path: docx, ops: [{ op: 'replace_text', find: 'English', replace: '英文' }] })
  assert(res.ok && res.data.backup && existsSync(res.data.backup), '没有备份')
  return res.data.backup.split('\\').pop()
})
await check('PDF 渲成 PNG（给 read_image）', async () => {
  const res = await tool('dlt_doc_convert').execute({ path: pdf, to: 'png', dpi: 100 })
  assert(res.ok && existsSync(res.out), 'PNG 没生成')
  return res.out.split('\\').pop()
})
await check('Word → PDF（Office COM）', async () => {
  const res = await tool('dlt_doc_convert').execute({ path: docx, to: 'pdf' })
  assert(res.ok && existsSync(res.out), res.error || 'PDF 没生成')
  return res.summary.split('\n')[0]
})
await check('相对路径按会话工作区解析', async () => {
  const exec = { agent: { session: { meta: { cwd: WORK } } } }
  const res = await tool('dlt_doc_read').execute({ path: 't.xlsx', mode: 'info' }, exec)
  assert(res.ok && res.path === xlsx, '解析不对: ' + res.path)
  return res.path
})

// ── 预览端点 ────────────────────────────────────────────────────────────────
section('右栏预览数据端点')
await check('Word 结构化内容', async () => {
  const data = await service.office({ address: 'dsh-resource://file/session/sess-test/t.docx' })
  assert(data.ok && data.handled && data.document.blocks.length, '未处理')
  return `blocks=${data.document.blocks.length}`
})
await check('Excel 结构化内容', async () => {
  const data = await service.office({ address: 'dsh-resource://file/session/sess-test/t.xlsx' })
  assert(data.ok && data.workbook.sheets.length, '未处理')
  return `sheets=${data.workbook.sheets.map((s) => s.name).join(',')}`
})
await check('PDF 交回产品渲染器', async () => {
  const data = await service.office({ address: 'dsh-resource://file/session/sess-test/t.pdf' })
  assert(data.ok && data.handled === false, '应当交回产品')
  return data.reason
})

// ── 定价与成本 ──────────────────────────────────────────────────────────────
section('定价与每轮成本')
await check('抓取官网单价', async () => {
  const info = await service.pricingInfo({ force: true })
  const f = info.models['deepseek-flash']
  assert(f.output.off === 4 && f.output.peak === 8, '单价格式变了: ' + JSON.stringify(f.output))
  return `flash 输出 ${f.output.off}/${f.output.peak} 元`
})
const offPeakMonday = Date.UTC(2026, 8, 14, 4, 0) // 北京时间周一 12:00 → 空闲档
services.sessionQuery.registry.set('synthetic-1', [
  { seq: 0, time: offPeakMonday - 60000, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, time: offPeakMonday - 59000, type: 'step/start', data: { turn: 1, step: 1 } },
  {
    seq: 2, time: offPeakMonday - 50000, type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      usage: { inputTokens: 1000000, outputTokens: 1000000, totalTokens: 2000000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    },
  },
  { seq: 3, time: offPeakMonday - 40000, type: 'step/end', data: { turn: 1, step: 1 } },
  { seq: 4, time: offPeakMonday, type: 'turn/end', data: { turn: 1 } },
])
await check('折叠 + 计价：1M 未命中 + 1M 输出 @ 空闲 = 5 元', async () => {
  const res = await service.cost({ sessionId: 'synthetic-1' })
  const t = res.turns[0]
  assert(t.usage, '没折叠出用量')
  assert(t.band === 'off', '档位应为 off')
  assert(Math.abs(t.cost - 5) < 1e-9, '应为 5 元，实得 ' + t.cost)
  return `${t.cost} 元（${t.bandLabel} / ${t.billingModel}）`
})
await check('旧模型名映射到 flash', async () => {
  const legacy = services.sessionQuery.registry.get('synthetic-1').map((e) => e.type === 'assistant/message'
    ? { ...e, data: { ...e.data, message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' } } } }
    : e)
  services.sessionQuery.registry.set('legacy-1', legacy)
  const res = await service.cost({ sessionId: 'legacy-1' })
  assert(res.turns[0].billingModel === 'deepseek-flash', '未映射')
  return `${res.turns[0].billingModel} / ${res.turns[0].cost} 元`
})
await check('未结算轮次不编造数据', async () => {
  services.sessionQuery.registry.set('open-1', services.sessionQuery.registry.get('synthetic-1').slice(0, 4))
  const res = await service.cost({ sessionId: 'open-1' })
  assert(res.turns[0].open === true && res.turns[0].cost === null, '不应有成本')
  return 'open=True, cost=null'
})

// ── 余额与状态 ──────────────────────────────────────────────────────────────
section('余额与状态')
await check('balance() 调 /user/balance', async () => {
  if (!apiKey) return '（凭据文件里没有 DEEPSEEK_API_KEY，跳过）'
  const res = await service.balance({ force: true })
  assert(res.ok, '失败: ' + res.error)
  assert(typeof res.total === 'number', 'total 不是数字')
  return `币种 ${res.currency} 总余额 ${res.total}，可用=${res.available}`
})
await check('status() 汇总', async () => {
  const st = await service.status()
  assert(st.paths.pythonEngineExists, '找不到 python 引擎')
  assert(st.turnUsageFold, '没有加载 turn-usage 折叠模块')
  return `引擎✓ 折叠=${st.turnUsageFold} 高峰现在=${st.peakNow}`
})

// ── 运行期开关（总开关 + 分模块）────────────────────────────────────────────
section('运行期开关（DLT 管理器）')
const switchFile = join(WORK, 'cache', 'switch.json')
const toolNames = () => [...services.tools.defs.keys()].sort()
const dltSection = () => services.systemPrompt.sections.find((s) => s.name === 'tool:dlt')

await check('默认全开：6 个工具 + 系统提示 + switchGet 可用', async () => {
  const info = await service.switchGet()
  assert(info.ok && info.enabled === true, '总开关应默认开')
  assert(toolNames().length === 6, '工具数应为 6，实为 ' + toolNames().length)
  assert(info.promptSection === true && !!dltSection(), '系统提示应已注入')
  assert(info.source === 'config', '没有文件时应来自 config：' + info.source)
  return `${info.summary}；工具=${toolNames().join(',')}`
})

await check('关「执行与编译」→ 只卸 dlt_run/dlt_build，其余不动', async () => {
  const info = await service.switchSet({ modules: { run: false } })
  assert(info.modules.run === false, 'run 没关上')
  assert(!services.tools.defs.has('dlt_run') && !services.tools.defs.has('dlt_build'), 'run 工具还在：' + toolNames().join(','))
  assert(services.tools.defs.has('dlt_env') && services.tools.defs.has('dlt_doc_read'), '误伤了别的模块：' + toolNames().join(','))
  const sec = dltSection()
  assert(sec && !sec.text.includes('dlt_run') && !sec.text.includes('dlt_build'), '系统提示里还在教用已关掉的工具')
  assert(existsSync(switchFile), '没写 switch.json')
  return `工具=${toolNames().join(',')}`
})

await check('落盘内容可读、可用于重启复原', async () => {
  const raw = JSON.parse(readFileSync(switchFile, 'utf8'))
  assert(raw.version === 1 && raw.enabled === true && raw.modules.run === false, '落盘不对：' + JSON.stringify(raw))
  return 'version=1 run=false'
})

await check('总开关关 → 工具全撤 / 提示全撤 / 端点拒绝 / status 不联网', async () => {
  const info = await service.switchSet({ enabled: false })
  assert(info.enabled === false, '总开关没关')
  assert(services.tools.defs.size === 0, '还有工具没撤：' + toolNames().join(','))
  assert(!dltSection(), '系统提示没撤')
  const envs = await service.envs()
  assert(envs.ok === false && envs.disabled === true, 'envs 应当拒绝：' + JSON.stringify(envs))
  const cost = await service.cost({ sessionId: 'synthetic-1' })
  assert(cost.ok === false && cost.disabled === true, 'cost 应当拒绝')
  const office = await service.office({ address: 'dsh-resource://file/session/sess-test/t.docx' })
  assert(office.ok === false && office.disabled === true, 'office 应当拒绝')
  const st = await service.status()
  assert(st.ok === true && st.enabled === false, 'status 应仍可读且反映总开关')
  assert(st.pricing && st.pricing.skipped, '总开关关时不该再去抓定价：' + JSON.stringify(st.pricing))
  return '工具 0 个 · 端点拒绝 · status 仅本地事实'
})

await check('重新打开 → 只按分模块恢复（run 仍关，4 个工具）', async () => {
  await service.switchSet({ enabled: true })
  const names = toolNames()
  assert(!names.includes('dlt_run') && !names.includes('dlt_build'), 'run 关着却又挂上了：' + names.join(','))
  assert(names.length === 4, '应为 4 个工具，实为 ' + names.length + '：' + names.join(','))
  assert(!!dltSection(), '系统提示应重新注入')
  return names.join(',')
})

await check('重启语义：unload 后 loadSwitch() 按 switch.json 复原', async () => {
  await service.switchSet({ modules: { run: true, cost: false } })
  service.unloadRuntime()
  assert(services.tools.defs.size === 0, 'unloadRuntime 没清干净')
  const info = await service.loadSwitch()
  assert(info.enabled === true && info.modules.cost === false && info.modules.run === true, '没按文件复原：' + JSON.stringify(info.modules))
  assert(services.tools.defs.has('dlt_run'), 'run 没恢复')
  await service.switchSet({ modules: { cost: true } })
  assert(toolNames().length === 6, '复原成全开失败：' + toolNames().join(','))
  return info.summary
})

console.log(`\n=== 结果: pass=${pass} fail=${fail} ===`)
if (fails.length) { console.log('失败项:'); fails.forEach((x) => console.log('  - ' + x)) }
console.log('产物: ' + WORK)
process.exit(fail ? 1 : 0)
