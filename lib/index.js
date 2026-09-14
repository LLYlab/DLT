// dlt/lib/index.js — DLT (DeepSeek Light Tool) 的 Host 半区
//
// 一个永久 Cordis 插件：通过 profile 的 cordis.patch.yml 的 insert 挂载，重启后常驻。
// 六个模块（各自可在 config 里单独关掉）：
//   1. 每轮对话的人民币成本（抓官网定价 + 本地缓存 + 高峰/空闲判定）
//   2. DeepSeek 账户余额（凭据 seam + /user/balance）
//   3. PDF / Word / Excel / CSV 的直接读写工具（钉死的 Python 3.12 引擎）
//   4. 右栏文档预览所需的结构化数据端点
//   5. 硬编码的编译/运行环境表（env_info + 注入系统提示）
//   6. 直接执行程序 / 编译的工具（run_program / build）
//
// 所有副作用（工具、typert 端点、systemPrompt 段）都通过 ctx.register / ctx.get(...).register /
// ctx.typert.register 挂在当前 fiber 上 —— 插件被禁用时由 Cordis 自动回收，本文件顶层不做任何注册。

import z from '@deepseek-ai/schemastery'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { existsSync, promises as fsp } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  ENVIRONMENTS,
  OFFICE_BRIDGE,
  PY_ENGINE,
  PACKAGE_ROOT,
  describeEnvironments,
  docKindOf,
  dshHome,
  htmlToPdf,
  isAbsolutePath,
  loadPricing,
  officeConvert,
  parseResourceAddress,
  peakBand,
  priceUsage,
  runDocumentOp,
  runInEnvironment,
} from './core.js'
import {
  MODULE_KEYS,
  MODULE_META,
  describeSwitch,
  normalizeSwitch,
  readSwitch,
  switchDefaults,
  switchPath,
  writeSwitch,
} from './switch.js'

const name = 'dlt'
/** typert 是硬依赖（注册端点）；其余服务一律 ctx.get 可选读取。 */
const inject = ['typert']

const Config = z.object({
  /**
   * 总开关默认值（**只在没有 switch.json 时生效**）。
   * 运行期开关以 <DSH_HOME>/dlt/switch.json 为准，可在「设置 → DLT 管理器」里切换：
   * 关掉即卸下 DLT 的全部模型工具与系统提示注入，且不必重启。
   */
  enabled: z.boolean().default(true),
  /** 模块开关默认值（同上：只在没有 switch.json 时生效；默认全开）。 */
  cost: z.boolean().default(true),
  balance: z.boolean().default(true),
  documents: z.boolean().default(true),
  preview: z.boolean().default(true),
  environment: z.boolean().default(true),
  run: z.boolean().default(true),

  /** 文档引擎使用的 Python 环境名（见环境表）。 */
  pythonEnv: z.string().default('python312'),
  /** 定价/余额缓存目录；留空则用 <DSH_HOME>/dlt。 */
  cacheDir: z.string().default(''),
  /** 定价快照最长使用时间（毫秒），超过则重新抓官网。 */
  pricingMaxAgeMs: z.number().default(24 * 60 * 60 * 1000),
  /** 余额接口基址。 */
  balanceApiBase: z.string().default('https://api.deepseek.com'),
  /** 余额所用的凭据引用名（经凭据 seam 解析，再退回同名环境变量）。 */
  balanceApiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  /** 余额结果缓存时间（毫秒）——浏览器端按此节奏轮询。 */
  balanceCacheMs: z.number().default(60000),

  /** 文档操作默认超时（毫秒）。 */
  docTimeoutMs: z.number().default(300000),
  /** 执行程序默认超时（毫秒）。 */
  runTimeoutMs: z.number().default(120000),
  /** 单次执行捕获的输出上限（字符）。 */
  maxOutputBytes: z.number().default(262144),

  /** 是否把环境表注入系统提示（让模型不再自己探测工具链路径）。 */
  promptSection: z.boolean().default(true),
  promptOrder: z.number().default(140),

  /** build 工具的默认值。 */
  defaultSolution: z.string().default(''),
  defaultConfiguration: z.string().default('Debug'),
  defaultPlatform: z.string().default('x64'),
  /** 是否把右栏预览里 Excel 的返回行数限制提高（大表时用）。 */
  previewMaxRows: z.number().default(400),
  previewMaxCols: z.number().default(40),
})

// ── 小工具 ──────────────────────────────────────────────────────────────────

const text = (value) => [{ type: 'text', text: String(value) }]
const fail = (label, error) => text(`✗ ${label}：${error && error.message ? error.message : error}`)
const okText = (value) => text(value)

function shortPath(p) {
  const t = String(p || '')
  return t.length <= 72 ? t : '…' + t.slice(-68)
}

/** 备份文件名用的时间戳（与 Python 引擎的 .bak-YYYYmmdd-HHMMSS 风格一致）。 */
function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 当前工具调用的会话工作区（模型给相对路径时按它解析）。 */
function sessionCwdOf(exec) {
  try {
    const session = exec && exec.agent && exec.agent.session
    if (!session) return null
    const cwd = (session.meta && session.meta.cwd) || (session.header && session.header.cwd) || session.cwd
    return cwd ? String(cwd) : null
  } catch {
    return null
  }
}

/**
 * 把模型/UI 给的路径变成绝对路径。
 * 绝对路径原样用；相对路径优先按**会话工作区**解析（这样模型写 `docs/a.docx` 也能命中），
 * 没有会话信息再退回进程 cwd。
 */
function resolveInputPath(raw, exec) {
  const text = String(raw === undefined || raw === null ? '' : raw)
  if (text === '') throw new Error('缺少文件路径')
  if (parseResourceAddress(text).fromAddress) {
    const parsed = parseResourceAddress(text)
    return isAbsolutePath(parsed.path) ? resolve(parsed.path) : (sessionCwdOf(exec) ? resolve(sessionCwdOf(exec), parsed.path) : resolve(parsed.path))
  }
  if (isAbsolutePath(text)) return resolve(text)
  const cwd = sessionCwdOf(exec)
  return cwd ? resolve(cwd, text) : resolve(text)
}

function outputSchema(extra = {}) {
  return {
    type: 'object',
    additionalProperties: true,
    properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' }, ...extra },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Host 服务（同时是 typert 端点的实现）
// ═══════════════════════════════════════════════════════════════════════════

class DltService extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, 'dlt')
    this.config = config
    this.require = createRequire(import.meta.url)
    this._pricing = null
    this._pricingAt = 0
    this._balance = null
    this._balanceAt = 0
    this._deriveTurnUsage = undefined
    // 运行期开关（总开关 + 分模块）：首次 loadSwitch() 之前用 config 默认值。
    this._switchState = null
    this._switchSource = 'config'
    this._switchError = null
    this._switchPath = switchPath(this.cacheDir)
    // 当前已挂上的模型工具 / 系统提示注入（关闭开关时逐个撤下）。
    this._toolDisposers = []
    this._toolNames = []
    this._promptDisposer = null
  }

  // ── 路径与配置 ────────────────────────────────────────────────────────────
  get cacheDir() {
    return this.config.cacheDir && this.config.cacheDir.trim() !== ''
      ? this.config.cacheDir
      : join(dshHome(), 'dlt')
  }

  // ── 运行期开关（总开关 + 六个分模块）─────────────────────────────────────
  //
  // 语义：总开关关 → DLT 对 DSH 不留任何注入（模型工具 / 系统提示 / 端点行为），
  //       但**设置页的开关本身仍在**（它是重新打开 DLT 的唯一入口）。
  // 分模块关 → 只撤下那一块（工具 / 提示行 / 对应 UI），其余照常。
  // 状态落在 <DSH_HOME>/dlt/switch.json；config 里的六项只是首次运行的默认值。

  /** config 给出的默认开关。 */
  get switchDefaults() {
    return switchDefaults(this.config)
  }

  /** 当前生效的开关（未载入前 = config 默认值）。 */
  get switchState() {
    return this._switchState || this.switchDefaults
  }

  /** 总开关是否开。 */
  get masterOn() {
    return this.switchState.enabled !== false
  }

  /** 某个分模块是否生效（总开关关时一律 false）。 */
  moduleOn(key) {
    return this.masterOn && this.switchState.modules[key] !== false
  }

  /** 设置页/工具用的完整开关状态。 */
  switchInfo() {
    const state = this.switchState
    return {
      ok: true,
      enabled: this.masterOn,
      modules: { ...state.modules },
      defaults: this.switchDefaults,
      moduleKeys: MODULE_KEYS.slice(),
      moduleMeta: MODULE_META,
      source: this._switchSource,
      path: this._switchPath,
      error: this._switchError,
      tools: this._toolNames.slice(),
      promptSection: this._promptDisposer !== null,
      summary: describeSwitch(state),
    }
  }

  /** 端点：读开关。总开关关掉时这条仍然可用（设置页靠它把 DLT 重新打开）。 */
  async switchGet() {
    return this.switchInfo()
  }

  /**
   * 端点：改开关（局部合并：只传要改的字段）。
   * 顺序：合内存 → 落盘 → 立即装卸工具/提示 → 回状态（含写盘结果）。
   */
  async switchSet(args = {}) {
    const patch = args && typeof args === 'object' ? args : {}
    const next = normalizeSwitch(patch, this.switchState)
    this._switchState = next
    const saved = await writeSwitch(this.cacheDir, next)
    this._switchSource = saved.ok ? 'file' : this._switchSource
    this._switchPath = saved.path || this._switchPath
    this._switchError = saved.ok ? null : saved.error
    this.applyRuntime()
    return { ...this.switchInfo(), saved: saved.ok, saveError: saved.ok ? null : saved.error }
  }

  /** 端点被总开关挡住时的统一答复（说清原因，不假装成功）。 */
  disabledReply() {
    return { ok: false, disabled: true, error: 'DLT 总开关已关闭（设置 → DLT 管理器 里可重新打开）' }
  }

  /**
   * 按当前开关装卸 DLT 的宿主注入（模型工具 + 系统提示）。
   * 幂等：先全部撤下再按开关挂上；副作用 disposer 全部登记，可随时关掉。
   */
  applyRuntime() {
    this.unloadRuntime()
    if (!this.masterOn) {
      this.ctx.logger?.info?.('[dlt] 总开关已关闭：模型工具与系统提示注入已卸下')
      return { ok: true, enabled: false, tools: [] }
    }
    const tools = this.ctx.get('tools')
    if (tools && typeof tools.register === 'function') {
      const wanted = []
      if (this.moduleOn('environment')) wanted.push(envTool(this))
      if (this.moduleOn('run')) wanted.push(runTool(this), buildTool(this))
      if (this.moduleOn('documents')) wanted.push(docReadTool(this), docWriteTool(this), docConvertTool(this))
      for (const definition of wanted) {
        const disposer = tools.register(definition)
        this._toolDisposers.push(typeof disposer === 'function' ? disposer : () => {})
        this._toolNames.push(definition.name)
      }
    }
    this._promptDisposer = registerPromptSection(this.ctx, this) || null
    this.ctx.logger?.info?.('[dlt] 运行期开关 %s：工具 %d 个', describeSwitch(this.switchState), this._toolNames.length)
    return { ok: true, enabled: true, tools: this._toolNames.slice() }
  }

  /** 撤下全部宿主注入（工具 / 系统提示）。可重入。 */
  unloadRuntime() {
    for (let i = this._toolDisposers.length - 1; i >= 0; i--) {
      try { this._toolDisposers[i]() } catch { /* 单个失败不影响其余 */ }
    }
    this._toolDisposers = []
    this._toolNames = []
    if (this._promptDisposer) {
      try { this._promptDisposer() } catch { /* ignore */ }
      this._promptDisposer = null
    }
  }

  /** 从 switch.json 载入开关并应用（apply 时异步调用一次）。 */
  async loadSwitch() {
    const got = await readSwitch(this.cacheDir, this.switchDefaults)
    this._switchState = got.state
    this._switchSource = got.source
    this._switchPath = got.path
    this._switchError = got.error
    this.applyRuntime()
    return this.switchInfo()
  }

  // ── 定价（第 1 项） ───────────────────────────────────────────────────────
  async pricing(force = false) {
    const fresh = this._pricing && !force && Date.now() - this._pricingAt < this.config.pricingMaxAgeMs
    if (fresh) return this._pricing
    const table = await loadPricing({
      cacheDir: this.cacheDir,
      maxAgeMs: this.config.pricingMaxAgeMs,
      force,
    })
    this._pricing = table
    this._pricingAt = Date.now()
    return table
  }

  /**
   * 每轮用量折叠：直接复用 dsh-token-meter 自己的 turn-usage 模块，
   * 保证这里算出的 token 与 UI 用量胶囊完全一致（不去猜事件格式）。
   *
   * 这个模块不是 dlt 的依赖，所以按三条路依次尝试解析：
   *   1. 直接当包解析（dlt 的 node_modules 里若有链接）；
   *   2. 从 cordis 的位置推出同层的 dsh-token-meter —— 不依赖 dlt 自己的依赖声明，
   *      且解析到的是**同一个真实文件**（Node 按 realpath 缓存），不会出现双实例；
   *   3. createRequire 再试一次。
   */
  async deriveTurnUsage() {
    if (this._deriveTurnUsage !== undefined) return this._deriveTurnUsage
    const candidates = []
    const push = (url) => { if (url && !candidates.includes(url)) candidates.push(url) }

    try {
      push(new URL('lib/types/turn-usage.js', import.meta.resolve('@deepseek-ai/dsh-token-meter/package.json')).href)
    } catch { /* 试下一条 */ }
    try {
      const cordisPkg = this.require.resolve('@deepseek-ai/cordis/package.json')
      const sibling = join(dirname(dirname(cordisPkg)), 'dsh-token-meter', 'lib', 'types', 'turn-usage.js')
      if (existsSync(sibling)) push(pathToFileURL(sibling).href)
    } catch { /* 试下一条 */ }
    try {
      const pkg = this.require.resolve('@deepseek-ai/dsh-token-meter/package.json')
      push(new URL('lib/types/turn-usage.js', pathToFileURL(pkg)).href)
    } catch { /* 结束 */ }

    for (const url of candidates) {
      try {
        const mod = await import(url)
        if (typeof mod.deriveTurnTokenUsage === 'function') {
          this._deriveTurnUsage = mod.deriveTurnTokenUsage
          this._deriveTurnUsageSource = url
          return this._deriveTurnUsage
        }
      } catch { /* 试下一条 */ }
    }
    this._deriveTurnUsage = null
    this._deriveTurnUsageSource = null
    return null
  }

  /** 取某个会话的原始事件日志（优先 sessionQuery，退回 live session）。 */
  async sessionEvents(sessionId) {
    const query = this.ctx.get('sessionQuery')
    if (query && typeof query.readSession === 'function') {
      const events = await query.readSession(sessionId)
      if (Array.isArray(events)) return events
    }
    const sessions = this.ctx.get('sessions')
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
    if (live) {
      if (typeof live.ownEvents === 'function') {
        const own = live.ownEvents()
        if (Array.isArray(own)) return own
      }
      if (Array.isArray(live.events)) return live.events
    }
    throw new Error(`取不到会话 ${sessionId} 的事件日志（sessionQuery/sessions 都不可用）`)
  }

  /** 把事件流切成若干轮（turn/start … turn/end）。 */
  static groupTurns(events) {
    const turns = []
    let current = null
    for (const event of events) {
      const type = event && event.type
      if (type === 'turn/start') {
        current = { turn: event.data ? event.data.turn : undefined, startTime: event.time ?? null, events: [event] }
        continue
      }
      if (!current) continue
      current.events.push(event)
      if (type === 'turn/end') {
        current.endTime = event.time ?? null
        current.open = false
        turns.push(current)
        current = null
      }
    }
    if (current) turns.push({ ...current, open: true })
    return turns
  }

  /**
   * 一个会话每轮的人民币成本。
   * @returns {{ok:boolean, currency:string, turns:Array, sessionTotal:number, table:object, warnings:string[]}}
   */
  async cost(args = {}) {
    if (!this.masterOn) return this.disabledReply()
    const sessionId = args.sessionId || args.session
    if (!sessionId) throw new Error('cost 需要 sessionId')
    const table = await this.pricing(false)
    const events = await this.sessionEvents(sessionId)
    const groups = DltService.groupTurns(events)
    const derive = await this.deriveTurnUsage()

    const turns = []
    const warnings = []
    let sessionTotal = 0
    let priced = 0

    for (const group of groups) {
      const entry = {
        turn: group.turn,
        open: !!group.open,
        at: group.endTime || group.startTime || null,
        usage: null,
        cost: null,
      }
      if (!group.open && derive) {
        let usage = null
        try {
          usage = derive(group.events)
        } catch (error) {
          warnings.push(`第 ${group.turn} 轮用量折叠失败：${error.message}`)
        }
        if (usage) {
          entry.usage = usage
          const priced2 = priceUsage(usage, { routes: usage.routes, at: entry.at }, table)
          entry.cost = priced2.cost
          entry.band = priced2.band
          entry.bandLabel = priced2.bandLabel
          entry.billingModel = priced2.billingModel
          entry.model = priced2.model
          entry.routes = usage.routes || null
          entry.lines = priced2.lines
          entry.warnings = priced2.warnings
          if (typeof priced2.cost === 'number') {
            sessionTotal += priced2.cost
            priced++
          }
        }
      }
      turns.push(entry)
    }

    if (!derive) {
      warnings.push('未能加载 dsh-token-meter 的 turn-usage 模块，无法得到逐轮精确用量。')
    }

    return {
      ok: true,
      currency: table.currency || 'CNY',
      sessionId,
      turns,
      turnCount: turns.length,
      pricedTurns: priced,
      sessionTotal,
      peakNow: peakBand(Date.now()),
      pricing: {
        source: table.source,
        fetchedAt: table.fetchedAt,
        stale: !!table.stale,
        fromCache: !!table.fromCache,
        modelIds: table.modelIds,
        models: table.models,
        peakRule: table.peakRule,
        note: table.note,
      },
      warnings: [...warnings, ...(table.warning ? [table.warning] : [])],
    }
  }

  // ── 余额（第 2 项） ───────────────────────────────────────────────────────
  async resolveApiKey() {
    const ref = this.config.balanceApiKeyEnv
    const credentials = this.ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(ref)
        if (hit && typeof hit.value === 'string' && hit.value.trim() !== '') {
          return { key: hit.value, source: hit.source || 'credentials' }
        }
      } catch { /* 退回环境变量 */ }
    }
    const fromEnv = process.env[ref]
    if (fromEnv && fromEnv.trim() !== '') return { key: fromEnv, source: 'env' }
    return { key: null, source: null }
  }

  async balance(args = {}) {
    if (!this.masterOn) return this.disabledReply()
    const force = args.force === true
    if (!force && this._balance && Date.now() - this._balanceAt < this.config.balanceCacheMs) {
      return { ...this._balance, cached: true }
    }
    const { key, source } = await this.resolveApiKey()
    if (!key) {
      return { ok: false, error: `凭据 ${this.config.balanceApiKeyEnv} 未配置（凭据 seam 与环境变量都没有）`, ref: this.config.balanceApiKeyEnv }
    }
    const url = this.config.balanceApiBase.replace(/\/+$/, '') + '/user/balance'
    let response
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      return { ok: false, error: `请求余额失败：${error.message}`, url }
    }
    if (!response.ok) {
      return { ok: false, error: `余额接口返回 HTTP ${response.status}`, url }
    }
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      return { ok: false, error: `余额响应不是 JSON：${error.message}`, url }
    }
    const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
    const cny = infos.find((i) => String(i.currency || '').toUpperCase() === 'CNY') || infos[0] || null
    const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v))
    const result = {
      ok: true,
      ref: this.config.balanceApiKeyEnv,
      source,
      available: payload.is_available === true,
      currency: cny ? String(cny.currency || 'CNY') : 'CNY',
      total: cny ? num(cny.total_balance) : null,
      granted: cny ? num(cny.granted_balance) : null,
      toppedUp: cny ? num(cny.topped_up_balance) : null,
      all: infos.map((i) => ({
        currency: String(i.currency || ''),
        total: num(i.total_balance),
        granted: num(i.granted_balance),
        toppedUp: num(i.topped_up_balance),
      })),
      fetchedAt: new Date().toISOString(),
    }
    this._balance = result
    this._balanceAt = Date.now()
    return result
  }

  /** 按会话 id 查它的工作区根（预览端点用 address 里的 sessionId 反查）。 */
  async sessionCwdById(sessionId) {
    if (!sessionId) return null
    try {
      const sessions = this.ctx.get('sessions')
      const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
      if (live) {
        const cwd = (live.meta && live.meta.cwd) || (live.header && live.header.cwd) || live.cwd
        if (cwd) return String(cwd)
      }
    } catch { /* 继续试 sessionQuery */ }
    try {
      const query = this.ctx.get('sessionQuery')
      if (query && typeof query.listSessions === 'function') {
        const listed = await query.listSessions({ id: sessionId })
        const rows = Array.isArray(listed) ? listed : (listed && Array.isArray(listed.items) ? listed.items : [])
        for (const row of rows) {
          const cwd = (row && (row.cwd || (row.meta && row.meta.cwd) || (row.header && row.header.cwd))) || null
          if (cwd) return String(cwd)
        }
      }
    } catch { /* 放弃 */ }
    return null
  }

  /** 把预览传来的地址/路径还原成磁盘上的绝对路径。 */
  async resolvePreviewPath(args) {
    const raw = args.path || args.address || ''
    const parsed = parseResourceAddress(raw)
    const sessionId = args.sessionId || parsed.sessionId || null
    const candidate = parsed.path || String(raw)
    if (isAbsolutePath(candidate)) return { path: resolve(candidate), sessionId }
    // 相对路径：先按会话工作区补全，再退回进程 cwd
    const cwd = await this.sessionCwdById(sessionId)
    const joined = cwd ? resolve(cwd, candidate) : resolve(candidate)
    if (existsSync(joined)) return { path: joined, sessionId, resolvedFrom: cwd ? 'session-cwd' : 'process-cwd' }
    const fallback = resolve(candidate)
    if (existsSync(fallback)) return { path: fallback, sessionId, resolvedFrom: 'process-cwd' }
    return {
      path: joined,
      sessionId,
      resolvedFrom: null,
      error: `文件不存在: ${joined}${cwd ? '' : '（没有会话工作区信息，相对路径无法补全，请传绝对路径）'}`,
    }
  }

  // ── 预览数据（第 4 项） ───────────────────────────────────────────────────
  /** 给右栏预览返回结构化的 Word / Excel / CSV 内容（不返回原始二进制）。 */
  async office(args = {}) {
    if (!this.masterOn || !this.moduleOn('documents')) return this.disabledReply()
    const resolved = await this.resolvePreviewPath(args)
    const path = resolved.path
    if (resolved.error) throw new Error(resolved.error)
    if (!existsSync(path)) throw new Error(`文件不存在: ${path}`)
    const kind = docKindOf(path)
    if (kind === 'pdf' || kind === 'html') {
      return { ok: true, kind, path, handled: false, reason: `${kind} 由产品自带渲染器处理` }
    }
    if (kind === 'docx') {
      const data = await runDocumentOp('read', { path }, { pythonEnv: this.config.pythonEnv, timeoutMs: this.config.docTimeoutMs })
      return { ok: true, kind, path, handled: true, document: data, bytes: (await fsp.stat(path)).size }
    }
    if (kind === 'xlsx') {
      const data = await runDocumentOp('read', {
        path,
        formulas: args.formulas === true,
        maxRows: Math.min(Number(args.maxRows || this.config.previewMaxRows), 2000),
        maxCols: Math.min(Number(args.maxCols || this.config.previewMaxCols), 200),
      }, { pythonEnv: this.config.pythonEnv, timeoutMs: this.config.docTimeoutMs })
      return { ok: true, kind, path, handled: true, workbook: data, bytes: (await fsp.stat(path)).size }
    }
    if (kind === 'csv') {
      const data = await runDocumentOp('read', { path, maxRows: 2000 }, { pythonEnv: this.config.pythonEnv, timeoutMs: this.config.docTimeoutMs })
      return { ok: true, kind, path, handled: true, csv: data, bytes: (await fsp.stat(path)).size }
    }
    return { ok: false, kind, path, error: `不支持的预览类型 ${kind}` }
  }

  // ── 状态（给设置页/诊断用） ───────────────────────────────────────────────
  // 总开关关掉时**不再联网抓定价**（DLT 此时不该产生任何外部动作），只回本地事实。
  async status() {
    const table = this.masterOn
      ? await this.pricing(false).catch((error) => ({ error: error.message }))
      : null
    const derive = await this.deriveTurnUsage()
    return {
      ok: true,
      version: '0.1.0',
      enabled: this.masterOn,
      switch: this.switchInfo(),
      modules: { ...this.switchState.modules },
      paths: {
        packageRoot: PACKAGE_ROOT,
        pythonEngine: PY_ENGINE,
        pythonEngineExists: existsSync(PY_ENGINE),
        officeBridge: OFFICE_BRIDGE,
        officeBridgeExists: existsSync(OFFICE_BRIDGE),
        cacheDir: this.cacheDir,
        pricingCache: join(this.cacheDir, 'pricing.json'),
        switchFile: this._switchPath,
      },
      pythonEnv: this.config.pythonEnv,
      turnUsageFold: derive ? 'dsh-token-meter/turn-usage' : null,
      pricing: table === null
        ? { skipped: '总开关已关闭' }
        : (table.error ? { error: table.error } : {
          source: table.source, fetchedAt: table.fetchedAt, stale: !!table.stale,
          modelIds: table.modelIds, models: table.models,
        }),
      environments: describeEnvironments().map((e) => ({ id: e.id, available: e.available, label: e.label })),
      peakNow: peakBand(Date.now()),
    }
  }

  async pricingInfo(args = {}) {
    if (!this.masterOn) return this.disabledReply()
    const table = await this.pricing(args.force === true)
    return { ok: true, ...table }
  }

  async envs() {
    if (!this.masterOn) return this.disabledReply()
    return { ok: true, environments: describeEnvironments() }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// typert 端点声明（浏览器端 connection.rpc.call('/api', 'dlt/<method>')）
// ═══════════════════════════════════════════════════════════════════════════

const METHOD_NAMES = ['status', 'balance', 'cost', 'office', 'pricingInfo', 'envs', 'switchGet', 'switchSet']

function buildInvocations() {
  return METHOD_NAMES.map((method) => ({
    id: 'dlt-' + method,
    service: 'dlt',
    namespace: 'dlt',
    method,
    parameters: [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }],
    result: { mode: 'src-json' },
    invocation: { kind: 'direct' },
  }))
}

// ═══════════════════════════════════════════════════════════════════════════
// 模型工具
// ═══════════════════════════════════════════════════════════════════════════

const JSON_PARAM = (description, required = false) => ({ type: 'json', description, ...(required ? { required: true } : {}) })

/** 第 5 项：环境表。 */
function envTool(service) {
  return defineTool({
    name: 'dlt_env',
    description: '查看本机硬编码的编译/运行环境表（MSVC、MSBuild、VS 自带 cmake/ninja、Python 3.12/3.9、Node、git、dotnet、Office COM、Edge）。' +
      '这些路径已写死，直接按 id 用 dlt_run / dlt_build 执行即可，不要再自己去探测工具链位置、也不要自己拼 vcvarsall 命令。',
    parameters: {
      env: { type: 'string', description: '可选：只看某一个环境 id（如 msvc-x64、python312、msbuild）的详细信息。' },
    },
    output: {
      schema: outputSchema({ environments: { type: 'array', items: { type: 'json' } } }),
      render: (_a, v) => {
        if (v.ok === false) return fail('环境表', v.error)
        if (v.detail) {
          const d = v.detail
          return okText([
            `环境 ${d.id}：${d.label}`,
            `  类型: ${d.kind}${d.arch ? `  架构: ${d.arch}` : ''}${d.version ? `  版本: ${d.version}` : ''}`,
            `  可执行: ${d.program || '(由 vcvars 提供)'}`,
            d.vcvars ? `  vcvars: ${d.vcvars}` : null,
            d.tools && d.tools.length ? `  工具: ${d.tools.join(', ')}` : null,
            `  可用: ${d.available ? '是' : '否 缺失=' + (d.missing || []).join(', ')}`,
            d.note ? `  说明: ${d.note}` : null,
          ].filter(Boolean).join('\n'))
        }
        const rows = (v.environments || []).map((e) => `· ${e.id.padEnd(18)} ${e.available ? '✓' : '✗'}  ${e.label}`)
        return okText(`本机环境表（用 dlt_env env=<id> 看细节，用 dlt_run env=<id> 直接执行）：\n${rows.join('\n')}`)
      },
    },
    async execute(args) {
      const wanted = args && args.env ? String(args.env) : ''
      if (wanted) {
        const found = describeEnvironments().find((e) => e.id === wanted)
        if (!found) {
          const ids = Object.keys(ENVIRONMENTS).join(', ')
          return { ok: false, error: `未知环境 "${wanted}"。可用: ${ids}` }
        }
        return { ok: true, detail: found }
      }
      return { ok: true, environments: describeEnvironments() }
    },
  })
}

/** 第 6 项：直接执行程序。 */
function runTool(service) {
  return defineTool({
    name: 'dlt_run',
    description: '在指定环境里直接执行一个程序并拿回 stdout/stderr/退出码 —— 用它代替「先拼一条 PowerShell 命令再执行」。' +
      'env 取自 dlt_env 的环境 id（如 msvc-x64 会自动先注入 vcvarsall，于是 cl.exe/link.exe 直接可用；python312 直接用钉死的解释器）。' +
      'program 可给绝对路径或环境内可见的命令名（msbuild / cmake / ninja 会映射到 VS 自带的那份）。',
    parameters: {
      env: { type: 'string', description: '环境 id，例如 msvc-x64 / python312 / node / git / dotnet / cmd。默认 cmd。' },
      program: { type: 'string', required: true, description: '要执行的程序：绝对路径，或环境内可见的命令名（cl、link、msbuild、cmake、ninja、python 等）。' },
      args: { type: 'array', items: { type: 'string' }, description: '参数数组（逐项传递，不需要自己加引号）。' },
      cwd: { type: 'string', description: '工作目录，默认当前工作区。' },
      timeoutMs: { type: 'number', description: '超时毫秒（默认 120000，超时会杀掉整个进程树）。' },
      stdin: { type: 'string', description: '可选：写入标准输入的内容（例如 python 脚本源码）。' },
    },
    output: {
      schema: outputSchema({ exitCode: { type: 'number' }, stdout: { type: 'string' }, stderr: { type: 'string' }, ms: { type: 'number' }, command: { type: 'string' } }),
      render: (_a, v) => {
        if (v.ok === false && v.error) return fail('执行', v.error)
        const parts = [`$ ${v.command}`, `退出码 ${v.exitCode}  用时 ${v.ms}ms`]
        if (v.stdout && v.stdout.trim()) parts.push(`--- stdout ---\n${v.stdout.trimEnd()}`)
        if (v.stderr && v.stderr.trim()) parts.push(`--- stderr ---\n${v.stderr.trimEnd()}`)
        if (!v.stdout?.trim() && !v.stderr?.trim()) parts.push('（无输出）')
        return okText(parts.join('\n'))
      },
    },
    async execute(args) {
      const cfg = service.config
      const envId = (args && args.env) || 'cmd'
      const program = args && args.program
      if (!program) return { ok: false, error: '需要 program' }
      const res = await runInEnvironment({
        env: envId,
        program,
        args: Array.isArray(args.args) ? args.args.map(String) : [],
        cwd: args.cwd ? resolve(String(args.cwd)) : process.cwd(),
        timeoutMs: Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : cfg.runTimeoutMs,
        stdin: typeof args.stdin === 'string' ? args.stdin : null,
        maxOutput: cfg.maxOutputBytes,
      })
      return res
    },
  })
}

/** 第 6 项：编译（MSBuild 一条龙）。 */
function buildTool(service) {
  return defineTool({
    name: 'dlt_build',
    description: '用 MSBuild（在 MSVC x64 环境里）编译解决方案或工程。不传 target 时用 config 里配置的默认解决方案。' +
      '这是「直接编译」的入口，不需要你自己写 vcvarsall + MSBuild 的命令行。',
    parameters: {
      target: { type: 'string', description: '要编译的 .sln / .vcxproj / .csproj 路径；留空用默认解决方案。' },
      configuration: { type: 'string', description: 'Configuration，默认 Debug。' },
      platform: { type: 'string', description: 'Platform，默认 x64。' },
      env: { type: 'string', description: '环境 id，默认 msbuild（= MSVC x64 + VS18 MSBuild）。' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: '附加 MSBuild 参数。' },
      rebuild: { type: 'boolean', description: 'true 时用 /t:Rebuild 完整重编。' },
    },
    output: {
      schema: outputSchema({ exitCode: { type: 'number' }, stdout: { type: 'string' }, stderr: { type: 'string' }, ms: { type: 'number' }, command: { type: 'string' } }),
      render: (_a, v) => {
        if (v.ok === false && v.error) return fail('编译', v.error)
        const head = v.ok ? `✓ 编译成功（用时 ${v.ms}ms）` : `✗ 编译失败（退出码 ${v.exitCode}，用时 ${v.ms}ms）`
        const body = [v.stdout, v.stderr].filter((s) => s && s.trim()).join('\n')
        return okText(body ? `${head}\n$ ${v.command}\n${body.trimEnd()}` : head)
      },
    },
    async execute(args) {
      const cfg = service.config
      const target = (args && args.target) || cfg.defaultSolution
      if (!target) {
        return { ok: false, error: '没有给 target，且 config.defaultSolution 为空。请传 target=.sln/.vcxproj 路径，或先在 cordis.patch.yml 里设置 defaultSolution。' }
      }
      const configuration = (args && args.configuration) || cfg.defaultConfiguration
      const platform = (args && args.platform) || cfg.defaultPlatform
      const msbuildArgs = [
        resolve(String(target)),
        `/p:Configuration=${configuration}`,
        `/p:Platform=${platform}`,
        '/nologo',
        '/v:minimal',
        ...(args && args.rebuild ? ['/t:Rebuild'] : []),
        ...(Array.isArray(args && args.extraArgs) ? args.extraArgs.map(String) : []),
      ]
      return await runInEnvironment({
        env: (args && args.env) || 'msbuild',
        program: 'msbuild',
        args: msbuildArgs,
        cwd: dirname(resolve(String(target))),
        timeoutMs: Number(args && args.timeoutMs) > 0 ? Number(args.timeoutMs) : 900000,
        maxOutput: cfg.maxOutputBytes,
      })
    },
  })
}

/** 第 3 项：文档读取（info + read 合一，按 mode 区分）。 */
function docReadTool(service) {
  return defineTool({
    name: 'dlt_doc_read',
    description: '直接读 PDF / Word(.docx) / Excel(.xlsx) / CSV，返回结构化内容 —— 不要为了读这些文件去写 Python/Node 脚本。' +
      'mode=auto 时：PDF 返回逐页文本，Word 返回段落与表格，Excel 返回各表行列（默认显示公式文本），CSV 返回行。' +
      'mode=info 只看元信息（页数/段落数/工作表数）。',
    parameters: {
      path: { type: 'string', required: true, description: '文件绝对路径或相对当前工作区的路径。' },
      mode: { type: 'string', enum: ['auto', 'info'], description: 'auto（默认，读内容）或 info（只看元信息）。' },
      pages: { type: 'array', items: { type: 'json' }, description: 'PDF 页码（1 基），如 [1,2] 或 ["1-3"]；省略为全部。' },
      sheets: { type: 'array', items: { type: 'string' }, description: 'Excel 工作表名；省略为全部。' },
      range: { type: 'string', description: 'Excel 单元格区域，如 B2:D10。' },
      formulas: { type: 'boolean', description: 'Excel 是否显示公式（默认 true）。false 时读缓存值。' },
      maxRows: { type: 'number', description: 'Excel/CSV 最多返回多少行（默认 500）。' },
    },
    output: {
      schema: outputSchema({ kind: { type: 'string' }, data: { type: 'json' } }),
      render: (_a, v) => {
        if (v.ok === false) return fail('读取', v.error)
        return okText(v.summary || '（已读取）')
      },
    },
    async execute(args, exec) {
      const cfg = service.config
      const path = resolveInputPath(args.path, exec)
      if (!existsSync(path)) return { ok: false, error: `文件不存在: ${path}` }
      const kind = docKindOf(path)
      const timeoutMs = cfg.docTimeoutMs

      if ((args.mode || 'auto') === 'info') {
        const data = await runDocumentOp('info', { path }, { pythonEnv: cfg.pythonEnv, timeoutMs })
        return { ok: true, kind, path, data, summary: summariseInfo(kind, path, data) }
      }

      if (kind === 'pdf') {
        const data = await runDocumentOp('read', { path, pages: args.pages, mode: 'text' }, { pythonEnv: cfg.pythonEnv, timeoutMs })
        const body = data.content.map((p) => `── 第 ${p.page} 页（${p.chars} 字${p.truncated ? '，已截断' : ''}）──\n${p.text.trimEnd() || '（本页无可提取文本，可能是扫描件；用 dlt_doc_convert to=png 渲染成图后再用 read_image 看）'}`).join('\n\n')
        return {
          ok: true, kind, path, data,
          summary: summariseInfo(kind, path, data) + `\n共 ${data.pages} 页，返回 ${data.returned} 页\n\n${body}`,
        }
      }
      if (kind === 'docx') {
        const data = await runDocumentOp('read', { path }, { pythonEnv: cfg.pythonEnv, timeoutMs })
        const body = data.blocks.map((b) => (b.type === 'p' ? b.text : `【${b.type}】${b.text}`)).join('\n')
        const tables = (data.tables || []).map((t) => `表 ${t.index + 1}（${t.rows}×${t.cols}）:\n` + t.data.map((r) => '  | ' + r.join(' | ')).join('\n')).join('\n')
        return {
          ok: true, kind, path, data,
          summary: `${path}\n段落 ${data.paragraphs} 个（非空 ${data.blocks.length}），表格 ${(data.tables || []).length} 个\n\n${body}${tables ? '\n\n' + tables : ''}`,
        }
      }
      if (kind === 'xlsx') {
        const data = await runDocumentOp('read', {
          path,
          sheets: args.sheets,
          range: args.range,
          formulas: args.formulas !== false,
          maxRows: Number(args.maxRows) > 0 ? Number(args.maxRows) : 500,
        }, { pythonEnv: cfg.pythonEnv, timeoutMs })
        const body = data.sheets.map((s) => {
          const rows = s.rows.map((r, i) => `${String(i + 1).padStart(3)} | ` + r.map((c) => (c === null || c === undefined ? '' : String(c))).join(' | ')).join('\n')
          return `── 表「${s.name}」${s.totalRows ? `（共 ${s.totalRows} 行 × ${s.totalCols} 列${s.truncated ? '，已截断' : ''}）` : s.range ? `（区域 ${s.range}）` : ''} ──\n${rows}`
        }).join('\n\n')
        return {
          ok: true, kind, path, data,
          summary: `${path}\n工作表: ${data.sheets.map((s) => s.name).join(', ')}\n\n${body}`,
        }
      }
      const data = await runDocumentOp('read', { path, maxRows: Number(args.maxRows) > 0 ? Number(args.maxRows) : 500 }, { pythonEnv: cfg.pythonEnv, timeoutMs })
      const body = data.data.map((r, i) => `${String(i + 1).padStart(3)} | ` + r.join(' | ')).join('\n')
      return {
        ok: true, kind, path, data,
        summary: `${path}\n共 ${data.rows} 行${data.truncated ? '（已截断）' : ''}\n\n${body}`,
      }
    },
  })
}

function summariseInfo(kind, path, data) {
  if (kind === 'pdf') return `${path}\nPDF：${data.pages} 页，${data.bytes} 字节${data.metadata && data.metadata.title ? `，标题「${data.metadata.title}」` : ''}`
  if (kind === 'docx') return `${path}\nWord：段落 ${data.paragraphs}（非空 ${data.nonEmptyParagraphs}），表格 ${data.tables}，${data.bytes} 字节`
  if (kind === 'xlsx') return `${path}\nExcel：${data.sheets.length} 个工作表（${data.sheets.map((s) => `${s.name} ${s.rows}×${s.cols}`).join('；')}）`
  return `${path}`
}

/** 第 3 项：文档写入（edit / create / PDF 往返编辑链）。 */
function docWriteTool(service) {
  return defineTool({
    name: 'dlt_doc_write',
    description: '直接修改 PDF / Word(.docx) / Excel(.xlsx) / CSV，或新建它们 —— 不要为了改这些文件去写脚本。' +
      '每次写操作默认先备份（同目录 .bak-时间戳 文件），写前会校验、写后回报实际生效的 operation 列表。' +
      'PDF 也可以用 chain=word|html 走「转成 Word/HTML → 编辑 → 转回 PDF」的往返链（复杂版面改动推荐）。',
    parameters: {
      path: { type: 'string', required: true, description: '目标文件路径（新建时也要给）。' },
      action: { type: 'string', enum: ['edit', 'create'], description: 'edit（默认，改现有文件）或 create（新建）。' },
      ops: JSON_PARAM('edit 的改动列表（数组）。各类型可用 op 见工具说明末尾。'),
      spec: JSON_PARAM('create 的规格：create 时用。PDF={pages:[{text,width,height,image}]}；Word={title,blocks:[{type:"h1|p|table|pagebreak",text,data,style}]}；Excel={sheets:[{name,rows:[[..]]}]}；CSV={rows:[[..]]}。'),
      kind: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'csv'], description: 'create 时的目标类型；省略则按 path 扩展名推断。' },
      out: { type: 'string', description: '另存到别的路径（edit 时）；省略则就地写。' },
      backup: { type: 'boolean', description: '是否备份，默认 true。' },
      chain: { type: 'string', enum: ['word', 'html'], description: '仅 PDF：走转换链编辑。word=PDF→docx 编辑→Word 导出 PDF；html=PDF→HTML→Edge 打印回 PDF。' },
      replacements: JSON_PARAM('chain=html 时的文本替换列表：[{find, replace}]（对中间 HTML 做替换）。'),
      keepIntermediate: { type: 'boolean', description: 'chain 编辑时是否保留中间文件（默认 false）。' },
    },
    output: {
      schema: outputSchema({ kind: { type: 'string' }, data: { type: 'json' } }),
      render: (_a, v) => {
        if (v.ok === false) return fail('写入', v.error)
        return okText(v.summary || '（已写入）')
      },
    },
    async execute(args, exec) {
      const cfg = service.config
      const path = resolveInputPath(args.path, exec)
      const action = args.action || 'edit'
      const pythonEnv = cfg.pythonEnv
      const timeoutMs = cfg.docTimeoutMs
      const backup = args.backup !== false

      if (action === 'create') {
        const kind = args.kind || docKindOf(path)
        const spec = args.spec || {}
        const payload = { path, kind, backup, ...spec }
        const data = await runDocumentOp('create', payload, { pythonEnv, timeoutMs })
        return { ok: true, kind, path: data.path, data, summary: `✓ 已新建 ${kind}: ${data.path}（${data.bytes} 字节）` }
      }

      const kind = docKindOf(path)
      if (!existsSync(path)) return { ok: false, error: `文件不存在: ${path}（新建请用 action=create）` }

      // ── PDF 往返编辑链 ───────────────────────────────────────────────────
      if (kind === 'pdf' && (args.chain === 'word' || args.chain === 'html')) {
        return await pdfRoundTrip(service, { path, args, chain: args.chain, pythonEnv, timeoutMs, backup })
      }

      const ops = Array.isArray(args.ops) ? args.ops : (args.ops ? [args.ops] : [])
      if (ops.length === 0) return { ok: false, error: 'edit 需要 ops（改动列表）' }
      const data = await runDocumentOp('edit', { path, ops, out: args.out, backup }, { pythonEnv, timeoutMs })
      const lines = (data.applied || []).map((a) => '  · ' + JSON.stringify(a, null, 0))
      return {
        ok: true, kind, path: data.path, data,
        summary: [
          `✓ 已写入 ${data.path}（${data.bytes} 字节）`,
          data.backup ? `  备份: ${data.backup}` : '  （未备份）',
          `  生效 ${(data.applied || []).length} 项:`,
          ...lines,
        ].join('\n'),
      }
    },
  })
}

/**
 * PDF → 中间格式 → 编辑 → 转回 PDF。
 * word 链：pdf2docx 转 docx，用 Word 的 op 编辑，再用 Word COM 导出 PDF（保真最高）。
 * html 链：pymupdf 转 HTML，做文本替换，再用 Edge 无头打印回 PDF（依赖少）。
 */
async function pdfRoundTrip(service, context) {
  const { path, args, chain, pythonEnv, timeoutMs, backup } = context
  const stem = path.slice(0, path.length - extname(path).length)
  const steps = []
  // 往返链最后会覆盖原 PDF，所以原文件必须在这里先备份（Office COM / Edge 不会替我们备份）。
  let backupPath = null
  if (backup) {
    backupPath = `${path}.bak-${stamp()}`
    await fsp.copyFile(path, backupPath)
    steps.push(`原文件已备份: ${backupPath}`)
  }

  if (chain === 'word') {
    const intermediate = `${stem}.dlt-edit.docx`
    await runDocumentOp('convert', { path, to: 'docx', out: intermediate, backup: false }, { pythonEnv, timeoutMs })
    steps.push(`PDF → Word: ${intermediate}`)

    const ops = Array.isArray(args.ops) ? args.ops : []
    if (ops.length > 0) {
      const edited = await runDocumentOp('edit', { path: intermediate, ops, backup: false }, { pythonEnv, timeoutMs })
      steps.push(`Word 编辑生效 ${(edited.applied || []).length} 项`)
    }
    const rendered = await officeConvert({ kind: 'docx', source: intermediate, target: path })
    steps.push(`Word → PDF: ${path}（${rendered.bytes} 字节${rendered.attached ? '，复用了已开的 Word' : ''}）`)
    if (!args.keepIntermediate) await fsp.rm(intermediate, { force: true })
    return {
      ok: true, kind: 'pdf', path, chain,
      data: { steps, bytes: rendered.bytes, backup: backupPath },
      summary: [`✓ PDF 往返编辑完成（Word 链）: ${path}`, ...steps.map((s) => '  · ' + s)].join('\n'),
    }
  }

  // html 链
  const intermediate = `${stem}.dlt-edit.html`
  await runDocumentOp('convert', { path, to: 'html', out: intermediate, backup: false }, { pythonEnv, timeoutMs })
  steps.push(`PDF → HTML: ${intermediate}`)

  const replacements = Array.isArray(args.replacements) ? args.replacements : []
  if (replacements.length > 0) {
    let html = await fsp.readFile(intermediate, 'utf8')
    let hits = 0
    for (const item of replacements) {
      const find = String(item && item.find !== undefined ? item.find : '')
      if (find === '') continue
      const replace = String((item && item.replace) || '')
      const parts = html.split(find)
      hits += parts.length - 1
      html = parts.join(replace)
    }
    await fsp.writeFile(intermediate, html, 'utf8')
    steps.push(`HTML 文本替换 ${replacements.length} 条规则，命中 ${hits} 处`)
  }
  const printed = await htmlToPdf({ source: intermediate, target: path })
  steps.push(`HTML → PDF: ${path}（${printed.bytes} 字节，Edge 无头打印）`)
  if (!args.keepIntermediate) await fsp.rm(intermediate, { force: true })
  return {
    ok: true, kind: 'pdf', path, chain,
    data: { steps, bytes: printed.bytes, backup: backupPath },
    summary: [`✓ PDF 往返编辑完成（HTML 链）: ${path}`, ...steps.map((s) => '  · ' + s)].join('\n'),
  }
}

/** 第 3/4 项：转换与栅格化。 */
function docConvertTool(service) {
  return defineTool({
    name: 'dlt_doc_convert',
    description: '文档格式转换与页面栅格化：PDF→Word/HTML（可编辑中间格式）、Word/Excel→PDF（Office COM，保真最高）、HTML→PDF（Edge 无头）。' +
      'to=png 把 PDF 某一页渲染成 PNG 图片文件；扫描件 PDF 没有文本层时，先用它出图，再用 read_image 亲眼看这一页。',
    parameters: {
      path: { type: 'string', required: true, description: '源文件路径。' },
      to: { type: 'string', required: true, enum: ['docx', 'html', 'pdf', 'png'], description: '目标格式。' },
      out: { type: 'string', description: '输出路径；省略时按源文件同名推断。' },
      page: { type: 'number', description: 'to=png 时的页码（1 基，默认 1）。' },
      dpi: { type: 'number', description: 'to=png 的分辨率，默认 150。' },
      firstPage: { type: 'number', description: 'PDF→Word 的起始页（0 基，可选）。' },
      lastPage: { type: 'number', description: 'PDF→Word 的结束页（0 基，可选）。' },
      range: { type: 'string', description: 'Excel→PDF 时只导出该区域（如 A1:F40）。' },
      backup: { type: 'boolean', description: '是否备份被覆盖的输出，默认 true。' },
    },
    output: {
      schema: outputSchema({ kind: { type: 'string' }, out: { type: 'string' }, data: { type: 'json' } }),
      render: (_a, v) => {
        if (v.ok === false) return fail('转换', v.error)
        return okText(v.summary)
      },
    },
    async execute(args, exec) {
      const cfg = service.config
      const path = resolveInputPath(args.path, exec)
      if (!existsSync(path)) return { ok: false, error: `文件不存在: ${path}` }
      const from = docKindOf(path)
      const to = String(args.to || '')
      const pythonEnv = cfg.pythonEnv
      const timeoutMs = cfg.docTimeoutMs

      if (to === 'png') {
        const data = await runDocumentOp('render', {
          path, page: Number(args.page) || 1, dpi: Number(args.dpi) || 150, out: args.out,
        }, { pythonEnv, timeoutMs })
        return {
          ok: true, kind: 'png', out: data.image, data,
          summary: `✓ 已渲染第 ${data.page} 页 → ${data.image}（${data.width}×${data.height}，${data.bytes} 字节，dpi ${data.dpi}）\n接着用 read_image 传这个路径就能看到这一页。`,
        }
      }
      if (to === 'pdf') {
        if (from === 'docx' || from === 'xlsx') {
          const out = resolve(String(args.out || `${path.slice(0, path.length - extname(path).length)}.pdf`))
          if (existsSync(out) && args.backup !== false) await fsp.copyFile(out, `${out}.bak-${Date.now()}`)
          const data = await officeConvert({ kind: from, source: path, target: out, range: args.range || '' })
          return { ok: true, kind: 'pdf', out, data, summary: `✓ ${from} → PDF（Office COM）: ${out}（${data.bytes} 字节，用时 ${data.ms}ms${data.attached ? '，复用了已开的 Office' : ''}）` }
        }
        if (from === 'html') {
          const out = resolve(String(args.out || `${path.slice(0, path.length - extname(path).length)}.pdf`))
          const data = await htmlToPdf({ source: path, target: out })
          return { ok: true, kind: 'pdf', out, data, summary: `✓ HTML → PDF（Edge 无头）: ${out}（${data.bytes} 字节）` }
        }
        return { ok: false, error: `不支持 ${from} → pdf` }
      }
      if (to === 'docx' || to === 'html') {
        if (from !== 'pdf') return { ok: false, error: `不支持 ${from} → ${to}（目前只支持 PDF → ${to}）` }
        const data = await runDocumentOp('convert', {
          path, to, out: args.out, firstPage: args.firstPage, lastPage: args.lastPage,
          backup: args.backup !== false,
        }, { pythonEnv, timeoutMs })
        return { ok: true, kind: to, out: data.path, data, summary: `✓ PDF → ${to.toUpperCase()}: ${data.path}（${data.bytes} 字节）` }
      }
      return { ok: false, error: `不支持的转换目标: ${to}` }
    },
  })
}

// 模型工具的注册已移进 DltService.applyRuntime()：那里按总开关 + 分模块开关
// 装卸，并登记每个 tools.register() 的 disposer（关掉开关就能立刻撤下）。

// ═══════════════════════════════════════════════════════════════════════════
// 系统提示注入（第 5 项）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 系统提示注入：只写「当前真的开着」的那几块，避免关掉 dlt_run 后提示里还在教模型用它。
 * @returns {Function|null} disposer（关开关时撤下）；无可写内容时返回 null。
 */
function registerPromptSection(ctx, service) {
  if (!service.masterOn || !service.config.promptSection) return null
  const prompt = ctx.get('systemPrompt')
  if (!prompt || typeof prompt.section !== 'function') return null

  const wantEnv = service.moduleOn('environment')
  const wantRun = service.moduleOn('run')
  const wantDocs = service.moduleOn('documents')
  if (!wantEnv && !wantRun && !wantDocs) return null

  const lines = ['# DLT 运行环境与执行工具']
  if (wantEnv || wantRun) {
    lines.push('本机工具链路径已硬编码在 DLT 里（cl / msbuild / cmake / ninja 都不在 PATH 上，必须靠环境注入）。')
    const howTo = []
    if (wantEnv) howTo.push('要看详细清单用 dlt_env')
    if (wantRun) howTo.push('要执行程序用 dlt_run（env 名 + program + args），不要在 pwsh 里自己拼 vcvarsall/命令字符串；要编译用 dlt_build')
    lines.push(howTo.join('；') + '。')
  }
  if (wantEnv) {
    // 标题里也别提已经关掉的工具，否则模型会照着提示去调不存在的东西。
    lines.push(wantRun ? '可用环境（dlt_run/dlt_build 的 env 参数）：' : '可用环境：')
    for (const e of describeEnvironments().filter((x) => x.available)) lines.push(`  · ${e.id} — ${e.label}`)
  }
  if (wantDocs) {
    lines.push(
      '',
      '# DLT 文档工具',
      '读/写 PDF、Word、Excel、CSV 一律用 dlt_doc_read / dlt_doc_write / dlt_doc_convert，不要为了这些文件去写 Python 或 Node 脚本、也不要用 bash/pwsh 拼命令行。',
      '扫描件 PDF 没有文本层时：dlt_doc_convert to=png 渲染该页，再用 read_image 看它。改动复杂版面时可用 dlt_doc_write 的 chain=word（PDF→Word→编辑→Word 导出 PDF）。',
      '所有写操作默认先备份。',
    )
  }

  return prompt.section({
    name: 'tool:dlt',
    order: service.config.promptOrder,
    text: lines.join('\n'),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// apply
// ═══════════════════════════════════════════════════════════════════════════

function apply(ctx, config) {
  const service = new DltService(ctx, config)

  ctx.typert.register({
    package: 'dlt',
    face: 'host',
    model: {},
    schemas: [],
    invocations: buildInvocations(),
  })

  // 先用 config 默认值即时挂上（不等磁盘 IO），随后异步读 switch.json 再重挂一次：
  // 于是「重启后开关仍然记得」，而启动那一刻也不会因为 IO 而少挂工具。
  service.applyRuntime()
  service.loadSwitch().catch((error) => {
    ctx.logger?.warn?.('[dlt] 载入运行期开关失败：%s', error && error.message ? error.message : error)
  })

  // 插件被停用（loader 禁用 dlt）时把注入收干净；平时开关由 switchSet 自己装卸。
  ctx.effect(() => () => service.unloadRuntime(), 'dlt: runtime switch teardown')

  ctx.logger?.info?.('[dlt] 已挂载：工具 %d 个，端点 %d 个', service._toolNames.length, METHOD_NAMES.length)
  return service
}

export { Config, DltService, apply, inject, name }
export default { name, inject, Config, apply }
