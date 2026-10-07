// dlt/lib/client.js — DLT (DeepSeek Light Tool) 的 Client 半区
//
// 浏览器端四块 UI：
//   1. 每轮对话末尾的「本轮人民币成本」小签（挂在 conversation.chat.turnTail 链槽上，紧挨用量胶囊）
//   2. 右下角的 DeepSeek 账户余额（挂在 shell.overlay，可拖动、位置跨会话记忆）
//   3. 输入框「+」旁的草图按钮（挂在 conversation.input.left，现画一张并导入）
//   4. 右栏文档预览：给 .docx / .xlsx / .csv 注册渲染器（PDF 由产品自带渲染器负责）
//
// 与 Host 的通信：connection.rpc.call('/api', 'dlt/<method>', { args: { args } }) → { ok, value }。
// 约定：所有副作用都通过 ctx.effect / ctx.slots.inject 登记，插件停用即可完全回收。
// 上级（DET）全面接管时（Host 的 switchGet 回报 detTakeover=true），本文件所有界面
// 注入连同「DLT 管理器」设置页入口一起不注册 —— DLT 本体整体停摆，界面归 DET。

window.__ModuleLoader__.load({
  id: 'dsh-light-tool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    // react-dom 只用于把草图弹窗 portal 到 body（避开输入框的 overflow 裁切）；
    // 拿不到就退回原地渲染 —— 面板本身仍可用，绝不能因为一次 require 失败而整个半区不加载。
    var ReactDOM = null
    try { ReactDOM = require('react-dom') } catch (e) { ReactDOM = null }

    var LOG = '[dlt]'
    function warn() {
      try { console.warn.apply(console, [LOG].concat([].slice.call(arguments))) } catch (e) { /* ignore */ }
    }

    var CSS = '' +
      // ── 通用 ──────────────────────────────────────────────────────────────
      '.dlt-mono{font-family:ui-monospace,Consolas,"Courier New",monospace}' +
      '.dlt-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;' +
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);' +
      'color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px;cursor:default;user-select:none}' +
      '.dlt-pill:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}' +
      '.dlt-pill-strong{color:var(--dsw-alias-label-primary);font-weight:600}' +
      '.dlt-pill-warn{color:var(--dsw-alias-state-error-primary)}' +
      // ── 每轮成本小签：右对齐贴在轮次尾部 ──────────────────────────────────
      '.dlt-costrow{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:4px}' +
      '.dlt-cost-chip{cursor:pointer}' +
      '.dlt-cost-detail{margin-top:4px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);' +
      'background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-secondary);' +
      'display:grid;grid-template-columns:auto 1fr;gap:3px 12px;max-width:420px}' +
      '.dlt-cost-detail b{color:var(--dsw-alias-label-primary);font-weight:600}' +
      // ── 右下角余额 ────────────────────────────────────────────────────────
      '.dlt-balance{position:fixed;z-index:9990;pointer-events:auto;display:flex;align-items:center;gap:6px;' +
      'padding:5px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);' +
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.22);user-select:none;cursor:grab}' +
      '.dlt-balance:hover{border-color:var(--dsw-alias-brand-primary)}' +
      '.dlt-balance-error{color:var(--dsw-alias-state-error-primary)}' +
      '.dlt-balance-busy{opacity:.65}' +
      '.dlt-balance-sub{color:var(--dsw-alias-label-tertiary);font-size:10.5px}' +
      // ── 右栏文档预览 ──────────────────────────────────────────────────────
      '.dlt-doc{padding:12px 14px;font-size:12.5px;color:var(--dsw-alias-label-primary);line-height:1.65}' +
      '.dlt-doc h1,.dlt-doc h2,.dlt-doc h3,.dlt-doc h4{margin:14px 0 6px;font-weight:600;line-height:1.35}' +
      '.dlt-doc h1{font-size:17px}.dlt-doc h2{font-size:15px}.dlt-doc h3{font-size:13.5px}.dlt-doc h4{font-size:12.5px}' +
      '.dlt-doc p{margin:6px 0;white-space:pre-wrap;word-break:break-word}' +
      '.dlt-doc table{border-collapse:collapse;margin:8px 0;font-size:12px;max-width:100%}' +
      '.dlt-doc th,.dlt-doc td{border:1px solid var(--dsw-alias-border-l1);padding:3px 7px;text-align:left;' +
      'vertical-align:top;white-space:pre-wrap;word-break:break-word;max-width:420px}' +
      '.dlt-doc th{background:var(--dsw-alias-bg-layer-2);font-weight:600}' +
      '.dlt-doc-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:8px}' +
      '.dlt-doc-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}' +
      '.dlt-doc-tab{padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);' +
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}' +
      '.dlt-doc-tab-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}' +
      '.dlt-doc-err{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word}' +
      '.dlt-doc-empty{color:var(--dsw-alias-label-tertiary)}' +
      '.dlt-doc-note{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:10px}' +
      // ── 设置页「DLT 管理器」───────────────────────────────────────────────
      '.dlt-set{padding:2px 0;font-size:12.5px;color:var(--dsw-alias-label-primary)}' +
      '.dlt-set-note{color:var(--dsw-alias-label-secondary);margin:0 0 10px;line-height:1.6}' +
      '.dlt-set-master{display:flex;align-items:center;gap:10px;padding:10px 12px;margin:0 0 10px;' +
      'border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2);' +
      'cursor:pointer;transition:border-color .15s,background .15s}' +
      '.dlt-set-master:hover{background:var(--dsw-alias-bg-layer-1)}' +
      '.dlt-set-master-off{border-style:dashed;border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}' +
      '.dlt-set-master-main{flex:1;min-width:0}' +
      '.dlt-set-master-name{font-weight:600;font-size:12.5px}' +
      '.dlt-set-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.6;margin-top:2px;word-break:break-word}' +
      '.dlt-set-rows{display:flex;flex-direction:column;gap:6px}' +
      '.dlt-set-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;' +
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer}' +
      '.dlt-set-row:hover{border-color:var(--dsw-alias-brand-primary)}' +
      '.dlt-set-row-muted{cursor:default;opacity:.55}' +
      '.dlt-set-row-main{flex:1;min-width:0}' +
      '.dlt-set-row-name{font-size:12.5px}' +
      '.dlt-set-switch{flex:none;width:34px;height:18px;border-radius:999px;position:relative;' +
      'background:var(--dsw-alias-border-l1);transition:background .15s}' +
      '.dlt-set-switch:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;' +
      'background:var(--dsw-alias-bg-layer-1);transition:left .15s}' +
      '.dlt-set-switch-on{background:var(--dsw-alias-brand-primary)}' +
      '.dlt-set-switch-on:after{left:18px}' +
      '.dlt-set-foot{margin-top:12px;display:flex;flex-direction:column;gap:4px}' +
      '.dlt-set-err{color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:1.6}' +
      '.dlt-set-msg{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6}' +
      '.dlt-set-btns{display:flex;gap:6px;margin-top:6px}' +
      '.dlt-set-btn{padding:3px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);' +
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11.5px;cursor:pointer}' +
      '.dlt-set-btn:hover{border-color:var(--dsw-alias-brand-primary)}' +
      '.dlt-set-diag{margin-top:6px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);' +
      'border:1px solid var(--dsw-alias-border-l1);display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11.5px}' +
      '.dlt-set-diag b{font-weight:600;color:var(--dsw-alias-label-secondary)}' +
      // ── 草图（draft）：输入框「+」旁的按钮 + 画布弹窗 ──────────────────────
      '.dlt-draft-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;' +
      'border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
      '.dlt-draft-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
      '.dlt-draft-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.dlt-sk-mask{position:fixed;inset:0;z-index:9997;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}' +
      '.dlt-sk-panel{width:min(920px,94vw);max-height:92vh;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;' +
      'border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);' +
      'color:var(--dsw-alias-label-primary);box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
      '.dlt-sk-head{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600}' +
      '.dlt-sk-hint{margin-left:auto;font-weight:400;font-size:11px;color:var(--dsw-alias-label-tertiary);max-width:64%;text-align:right}' +
      '.dlt-sk-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
      '.dlt-sk-sw{width:20px;height:20px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer}' +
      '.dlt-sk-sw-on{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
      '.dlt-sk-btn{padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);' +
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer}' +
      '.dlt-sk-btn:hover{border-color:var(--dsw-alias-brand-primary)}' +
      '.dlt-sk-btn:disabled{opacity:.5;cursor:default}' +
      '.dlt-sk-stage{display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);' +
      'border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}' +
      '.dlt-sk-canvas{display:block;width:100%;height:auto;max-height:60vh;background:#fff;touch-action:none;cursor:crosshair}' +
      '.dlt-sk-foot{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}' +
      '.dlt-sk-err{color:var(--dsw-alias-state-error-primary);word-break:break-word}' +
      '.dlt-sk-note{color:var(--dsw-alias-label-tertiary)}'

    // ══ 与 Host 的 RPC ═════════════════════════════════════════════════════
    function makeCaller(getConnection) {
      return function call(method, args) {
        var connection = getConnection()
        if (!connection || typeof connection.rpc !== 'object' || typeof connection.rpc.call !== 'function') {
          return Promise.reject(new Error('connection 服务不可用（dlt）'))
        }
        return connection.rpc.call('/api', 'dlt/' + method, { args: { args: args || {} } }).then(function (r) {
          if (r && r.ok) return r.value
          var err = (r && r.error) || {}
          throw new Error(err.message || ('调用失败: ' + method))
        })
      }
    }

    // ══ 格式化 ═════════════════════════════════════════════════════════════
    function money(value) {
      if (value === null || value === undefined || !isFinite(value)) return '—'
      var v = Number(value)
      if (v === 0) return '0'
      var abs = Math.abs(v)
      if (abs < 0.01) return v.toFixed(5)
      if (abs < 1) return v.toFixed(4)
      if (abs < 100) return v.toFixed(3)
      return v.toFixed(2)
    }

    function kmb(n) {
      var v = Number(n || 0)
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
      return String(v)
    }

    function clock(iso) {
      if (!iso) return '—'
      try {
        var d = new Date(iso)
        var p = function (x) { return String(x).padStart(2, '0') }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      } catch (e) { return String(iso) }
    }

    function shortPath(p) {
      var t = String(p || '')
      return t.length <= 60 ? t : '…' + t.slice(-56)
    }

    // ══ 1) 每轮人民币成本 ═════════════════════════════════════════════════
    // 同一会话的逐轮成本只请求一次，短 TTL 内复用；多个 turnTail 实例共享。
    function createCostStore(call) {
      var cache = { key: null, at: 0, data: null }
      var inflight = {}
      var TTL = 5000

      function fetchCost(sessionId, force) {
        var now = Date.now()
        if (!force && cache.data && cache.key === sessionId && now - cache.at < TTL) {
          return Promise.resolve(cache.data)
        }
        // 按会话去重：多个轮次尾部同时挂载时只发一次请求。
        if (inflight[sessionId]) return inflight[sessionId]
        var promise = call('cost', { sessionId: sessionId }).then(function (data) {
          cache.key = sessionId
          cache.data = data
          cache.at = Date.now()
          delete inflight[sessionId]
          return data
        }).catch(function (error) {
          delete inflight[sessionId]
          throw error
        })
        inflight[sessionId] = promise
        return promise
      }

      return {
        fetchCost: fetchCost,
        invalidate: function () { cache.at = 0 },
      }
    }

    function createTurnCostChip(call, store, switchStore) {
      return function TurnCostChip(props) {
        // 订阅开关 store：DET 的接管声明变化时本组件要重渲染，
        // 否则展开详情里的「重复行已隐去」要等到下次开合才生效。
        var sw = useSwitch(switchStore)
        var sessionId = props.sessionId
        // 两种槽形态都要认（详见下方注册处的说明）：
        //   · chain（≤0.1.6）：选择器的返回值落在 props.matched 上
        //   · list （0.1.7+）：owner props 直接给 turn: TurnLocation
        // TurnLocation 是对象，其中 .turn 才是 turn id；chain 形态下选择器
        // 已经替我们取过一层，所以这里按「是不是对象」再决定要不要取 .turn。
        var matched = props.matched || {}
        var raw = matched.turn !== undefined ? matched.turn : props.turn
        var turn = (raw && typeof raw === 'object') ? raw.turn : raw
        var st = React.useState({ status: 'loading', data: null, error: null })
        var state = st[0]
        var setState = st[1]
        var openSt = React.useState(false)
        var open = openSt[0]
        var setOpen = openSt[1]

        React.useEffect(function () {
          var alive = true
          if (!sessionId) return undefined
          store.fetchCost(sessionId, false).then(function (data) {
            if (alive) setState({ status: 'ready', data: data, error: null })
          }).catch(function (error) {
            if (alive) setState({ status: 'error', data: null, error: String(error && error.message ? error.message : error) })
          })
          return function () { alive = false }
        }, [sessionId, turn])

        if (!sessionId || !turn) return null

        var entry = null
        if (state.data && Array.isArray(state.data.turns)) {
          for (var i = 0; i < state.data.turns.length; i++) {
            if (state.data.turns[i].turn === turn) { entry = state.data.turns[i]; break }
          }
        }

        // 本轮还没结算、或事件折叠不出精确用量 → 不占位（保持对话尾部干净）。
        if (state.status === 'loading') return null
        if (state.status === 'error') {
          return React.createElement('div', { className: 'dlt-costrow' },
            React.createElement('span', {
              className: 'dlt-pill dlt-pill-warn dlt-cost-chip',
              title: 'DLT 成本：' + state.error,
              onClick: function () { setState({ status: 'loading', data: null, error: null }); store.invalidate() },
            }, '成本 ?'))
        }
        if (!entry || (!entry.cost && entry.cost !== 0) || !entry.usage) return null

        var currency = state.data.currency === 'CNY' ? '¥' : (state.data.currency + ' ')
        var label = currency + money(entry.cost)
        var title = buildCostTitle(entry, state.data)

        var chip = React.createElement('span', {
          className: 'dlt-pill dlt-cost-chip dlt-mono',
          title: title,
          onClick: function () { setOpen(!open) },
        },
          React.createElement('span', null, '本轮 '),
          React.createElement('span', { className: 'dlt-pill-strong' }, label),
          React.createElement('span', { style: { opacity: .6 } }, entry.band === 'peak' ? '高峰' : '空闲'))

        if (!open) return React.createElement('div', { className: 'dlt-costrow' }, chip)

        var u = entry.usage || {}
        // 与 DET 状态框重复的行：DET 接管后隐去，只留 DLT 独有的粒度
        // （「本轮 ¥」与三项 token 明细 DET 都没有）。
        var detPricing = detOwns(sw, 'pricing')
        var detSession = detOwns(sw, 'sessionCost')
        var rows = [
          ['计费模型', entry.billingModel || '未知'],
        ]
        if (!detPricing) {
          rows.push(['档位', (entry.bandLabel || '') + '（' + (state.data.pricing && state.data.pricing.peakRule ? state.data.pricing.peakRule : '') + '）'])
        }
        rows.push(
          ['输入（未命中）', kmb(u.uncachedInputTokens) + ' tokens'],
          ['输入（缓存命中）', u.cacheReadTokens === undefined ? '未上报' : kmb(u.cacheReadTokens) + ' tokens'],
          ['输出', kmb(u.outputTokens) + ' tokens'],
          ['本轮合计', label]
        )
        if (!detSession) {
          rows.push(['本会话累计', currency + money(state.data.sessionTotal) + '（' + state.data.pricedTurns + '/' + state.data.turnCount + ' 轮已计价）'])
        }
        if (!detPricing) {
          rows.push(['单价快照', state.data.pricing ? clock(state.data.pricing.fetchedAt) + (state.data.pricing.stale ? '（旧快照）' : '') : '—'])
        }
        if (detPricing || detSession) {
          rows.push(['让位', '已由 DET 状态框统一呈现：' +
            (detPricing ? '单价（峰/谷 · 命中/未命中/输出）' : '') +
            (detPricing && detSession ? '、' : '') +
            (detSession ? '本对话花费' : '')])
        }
        var detail = React.createElement('div', { className: 'dlt-cost-detail' },
          rows.map(function (pair, index) {
            return [
              React.createElement('span', { key: 'k' + index }, pair[0]),
              React.createElement('b', { key: 'v' + index }, pair[1]),
            ]
          }).reduce(function (all, pair) { return all.concat(pair) }, []))

        return React.createElement('div', { className: 'dlt-costrow', style: { flexDirection: 'column', alignItems: 'flex-end' } },
          chip, detail)
      }
    }

    function buildCostTitle(entry, data) {
      var u = entry.usage || {}
      var routeText = entry.routes && entry.routes.length
        ? entry.routes.map(function (r) { return r.provider + '/' + r.model }).join('、')
        : (entry.model || '—')
      var lines = [
        'DLT 本轮成本：' + (data.currency === 'CNY' ? '¥' : data.currency + ' ') + money(entry.cost),
        '计费模型：' + (entry.billingModel || '未知') + '（路由 ' + routeText + '）',
        '档位：' + (entry.bandLabel || '—'),
        'token：未命中 ' + kmb(u.uncachedInputTokens) + ' / 命中 ' + (u.cacheReadTokens === undefined ? '—' : kmb(u.cacheReadTokens)) + ' / 输出 ' + kmb(u.outputTokens),
        '点击展开明细',
      ]
      if (entry.warnings && entry.warnings.length) lines.push('注意：' + entry.warnings.join('；'))
      return lines.join('\n')
    }

    // ══ 2) 右下角余额 ═════════════════════════════════════════════════════
    var POS_KEY = 'dlt-balance-pos'

    function loadPos() {
      try {
        var raw = JSON.parse(localStorage.getItem(POS_KEY))
        if (raw && typeof raw.right === 'number' && typeof raw.bottom === 'number') return raw
      } catch (e) { /* ignore */ }
      return null
    }
    function savePos(pos) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch (e) { /* ignore */ }
    }

    function createBalanceWidget(call) {
      return function BalanceWidget() {
        var st = React.useState({ status: 'loading', data: null, error: null })
        var state = st[0]
        var setState = st[1]
        var posSt = React.useState(function () { return loadPos() || { right: 14, bottom: 14 } })
        var pos = posSt[0]
        var setPos = posSt[1]
        var dragged = React.useRef(false)
        // 拖拽期间 pos 状态会重渲染，但 mousedown 时创建的那组监听器闭包拿到的是旧值，
        // 所以用 ref 记住最新坐标，mouseup 时按 ref 保存。
        var posRef = React.useRef(pos)
        posRef.current = pos

        var load = React.useCallback(function (force) {
          call('balance', { force: !!force }).then(function (data) {
            if (data && data.ok === false) setState({ status: 'error', data: null, error: data.error || '余额不可用' })
            else setState({ status: 'ready', data: data, error: null })
          }).catch(function (error) {
            setState({ status: 'error', data: null, error: String(error && error.message ? error.message : error) })
          })
        }, [])

        React.useEffect(function () {
          load(false)
          var timer = setInterval(function () {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            load(false)
          }, 60000)
          return function () { clearInterval(timer) }
        }, [load])

        var onDown = function (event) {
          if (event.button !== undefined && event.button !== 0) return
          var el = event.currentTarget
          var rect = el.getBoundingClientRect()
          dragged.current = false
          var grab = {
            offX: event.clientX - rect.left,
            offY: event.clientY - rect.top,
            w: rect.width,
            h: rect.height,
          }
          var onMove = function (moveEvent) {
            dragged.current = true
            var right = Math.max(6, window.innerWidth - (moveEvent.clientX - grab.offX) - grab.w)
            var bottom = Math.max(6, window.innerHeight - (moveEvent.clientY - grab.offY) - grab.h)
            var next = { right: Math.round(right), bottom: Math.round(bottom) }
            posRef.current = next
            setPos(next)
          }
          var onUp = function () {
            if (dragged.current) savePos(posRef.current)
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
          event.preventDefault()
        }

        var onClick = function () {
          if (dragged.current) { dragged.current = false; return }
          setState({ status: 'loading', data: state.data, error: null })
          load(true)
        }

        var data = state.data
        var cur = data && data.currency === 'CNY' ? '¥' : ((data && data.currency) || '¥')
        var body
        if (state.status === 'error') {
          body = React.createElement('span', { className: 'dlt-balance-error' }, '余额 ✗')
        } else if (!data && state.status === 'loading') {
          body = React.createElement('span', { className: 'dlt-balance-sub' }, '余额 …')
        } else {
          body = [
            React.createElement('span', { key: 'label', className: 'dlt-balance-sub' }, '余额'),
            React.createElement('b', { key: 'value', className: 'dlt-mono' }, cur + money(data ? data.total : null)),
          ]
        }

        var title = [
          'DLT · DeepSeek 账户余额（点击刷新，可拖动）',
          state.error ? ('错误：' + state.error) : null,
          data ? ('总余额：' + cur + money(data.total)) : null,
          data ? ('赠送余额：' + cur + money(data.granted)) : null,
          data ? ('充值余额：' + cur + money(data.toppedUp)) : null,
          data ? ('凭据来源：' + data.ref + '（' + data.source + '）') : null,
          data ? ('更新时间：' + clock(data.fetchedAt)) : null,
          data && data.available === false ? '注意：账户当前被标记为不可用（余额可能不足）' : null,
        ].filter(Boolean).join('\n')

        return React.createElement('div', {
          className: 'dlt-balance' + (state.status === 'loading' ? ' dlt-balance-busy' : ''),
          style: { right: pos.right + 'px', bottom: pos.bottom + 'px' },
          title: title,
          onMouseDown: onDown,
          onClick: onClick,
        }, body)
      }
    }

    // ══ 4) 右栏文档预览（Word / Excel / CSV） ═════════════════════════════
    function pathFromAddress(address) {
      var addr = String(address || '')
      var match = /^dsh-resource:\/\/file\/(?:session\/[^/]+\/|absolute\/)(.*)$/.exec(addr)
      var raw = match ? match[1] : addr
      try { return decodeURIComponent(raw) } catch (e) { return raw }
    }

    function resolveTargetPath(props) {
      // 首选产品给的元数据（含 Host 绝对路径），退而解析 address 本身。
      var address = props && props.resourceAddress ? String(props.resourceAddress) : ''
      var absolute = ''
      try {
        if (typeof props.useResource === 'function' && address) {
          var snapshot = props.useResource(address)
          if (snapshot && snapshot.value && typeof snapshot.value.absolutePath === 'string') {
            absolute = snapshot.value.absolutePath
          }
        }
      } catch (e) { /* 元数据不可用时退回 address */ }
      return absolute || pathFromAddress(address)
    }

    function TableBlock(rows, key, headFirst) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return React.createElement('div', { className: 'dlt-doc-empty', key: key }, '（空表）')
      }
      var header = headFirst ? rows[0] : null
      var bodyRows = headFirst ? rows.slice(1) : rows
      return React.createElement('table', { key: key },
        header ? React.createElement('thead', null,
          React.createElement('tr', null, header.map(function (cell, index) {
            return React.createElement('th', { key: index }, cell === null || cell === undefined ? '' : String(cell))
          }))) : null,
        React.createElement('tbody', null, bodyRows.map(function (row, rowIndex) {
          return React.createElement('tr', { key: rowIndex }, (row || []).map(function (cell, cellIndex) {
            return React.createElement('td', { key: cellIndex }, cell === null || cell === undefined ? '' : String(cell))
          }))
        })))
    }

    function createOfficeBody(call, kind) {
      return function OfficeDocBody(props) {
        var target = resolveTargetPath(props)
        var st = React.useState({ status: 'loading', data: null, error: null })
        var state = st[0]
        var setState = st[1]
        var sheetSt = React.useState(0)
        var sheetIndex = sheetSt[0]
        var setSheetIndex = sheetSt[1]

        React.useEffect(function () {
          var alive = true
          setState({ status: 'loading', data: null, error: null })
          if (!target) {
            setState({ status: 'error', data: null, error: '拿不到文件路径（resourceAddress=' + String(props.resourceAddress) + '）' })
            return undefined
          }
          // 同时把原始 address 与 sessionId 交给 Host：绝对路径拿不到时，
          // Host 还能用会话工作区去补全相对路径。
          call('office', {
            path: target,
            address: props.resourceAddress || '',
            sessionId: props.sessionId || '',
          }).then(function (data) {
            if (!alive) return
            if (data && data.ok === false) setState({ status: 'error', data: null, error: data.error || '读取失败' })
            else setState({ status: 'ready', data: data, error: null })
          }).catch(function (error) {
            if (alive) setState({ status: 'error', data: null, error: String(error && error.message ? error.message : error) })
          })
          return function () { alive = false }
        }, [target])

        if (state.status === 'loading') {
          return React.createElement('div', { className: 'dlt-doc' },
            React.createElement('div', { className: 'dlt-doc-meta' }, shortPath(target) || '载入中…'),
            React.createElement('div', { className: 'dlt-doc-empty' }, 'DLT 正在解析…'))
        }
        if (state.status === 'error') {
          return React.createElement('div', { className: 'dlt-doc' },
            React.createElement('div', { className: 'dlt-doc-meta' }, shortPath(target)),
            React.createElement('div', { className: 'dlt-doc-err' }, 'DLT 无法预览：' + state.error))
        }

        var data = state.data || {}
        var children = [React.createElement('div', { className: 'dlt-doc-meta', key: 'meta' },
          shortPath(target) + (data.bytes ? '（' + data.bytes + ' 字节）' : ''))]

        if (kind === 'docx' && data.document) {
          var doc = data.document
          children.push(React.createElement('div', { className: 'dlt-doc-meta', key: 'stat' },
            '段落 ' + doc.paragraphs + '（非空 ' + (doc.blocks || []).length + '） · 表格 ' + (doc.tables || []).length))
          ;(doc.blocks || []).forEach(function (block, index) {
            var tag = block.type === 'p' ? 'p'
              : block.type === 'title' ? 'h1'
                : (block.type === 'h1' || block.type === 'h2' || block.type === 'h3' || block.type === 'h4') ? block.type
                  : 'p'
            children.push(React.createElement(tag, { key: 'b' + index }, block.text))
          })
          ;(doc.tables || []).forEach(function (table, index) {
            children.push(React.createElement('div', { className: 'dlt-doc-meta', key: 'tm' + index },
              '表 ' + (index + 1) + '（' + table.rows + '×' + table.cols + '）'))
            children.push(TableBlock(table.data, 'tb' + index, false))
          })
        } else if (kind === 'xlsx' && data.workbook) {
          var sheets = data.workbook.sheets || []
          var active = Math.min(sheetIndex, Math.max(0, sheets.length - 1))
          if (sheets.length > 1) {
            children.push(React.createElement('div', { className: 'dlt-doc-tabs', key: 'tabs' },
              sheets.map(function (sheet, index) {
                return React.createElement('span', {
                  key: index,
                  className: 'dlt-doc-tab' + (index === active ? ' dlt-doc-tab-on' : ''),
                  onClick: function () { setSheetIndex(index) },
                }, sheet.name)
              })))
          }
          var sheet = sheets[active]
          if (sheet) {
            children.push(React.createElement('div', { className: 'dlt-doc-meta', key: 'sinfo' },
              '表「' + sheet.name + '」' + (sheet.totalRows ? ' · ' + sheet.totalRows + ' 行 × ' + sheet.totalCols + ' 列' : '') +
              (sheet.truncated ? ' · 仅显示前 ' + (sheet.rows || []).length + ' 行' : '')))
            children.push(TableBlock(sheet.rows, 'sheet' + active, true))
          }
        } else if (kind === 'csv' && data.csv) {
          children.push(React.createElement('div', { className: 'dlt-doc-meta', key: 'cinfo' },
            '共 ' + data.csv.rows + ' 行' + (data.csv.truncated ? ' · 仅显示前 ' + data.csv.data.length + ' 行' : '')))
          children.push(TableBlock(data.csv.data, 'csv', true))
        } else {
          children.push(React.createElement('div', { className: 'dlt-doc-empty', key: 'none' }, '没有可显示的内容'))
        }

        children.push(React.createElement('div', { className: 'dlt-doc-note', key: 'note' },
          'DLT 只读预览 · 要修改请让模型用 dlt_doc_write'))

        return React.createElement('div', { className: 'dlt-doc' }, children)
      }
    }

    var PREVIEW_DEFS = [
      { id: 'dlt-docx', extensions: ['docx', 'docm'], label: 'DLT Word 视图', kind: 'docx' },
      { id: 'dlt-xlsx', extensions: ['xlsx', 'xlsm'], label: 'DLT Excel 视图', kind: 'xlsx' },
      { id: 'dlt-csv', extensions: ['csv'], label: 'DLT 表格视图', kind: 'csv' },
    ]

    // 让位状态：id → true 表示产品自带实现（priority 'builtin'）已认领该后缀，
    // DLT 主动退出并交给原生预览。管理器据此**如实显示**，否则用户只看到
    // 「DLT 预览没出现」，会以为坏了而不是被更高优先级的原生实现接走。
    var previewTakeover = {}

    // ── 上级（DET）接管判定 ─────────────────────────────────────────────────
    // DET 总开关打开并声明接管某个「面」时，DLT 抑制自己那份**重复实现**；
    // 各自独有的部分照旧（例如成本小签的「本轮 ¥」粒度 DET 没有，必须保留）。
    // 声明由 Host 从 DET 的 dshEssentialTools 服务取回（见 lib/index.js 的 _detGrant）。
    //
    // ⚠ 必须定义在**工厂作用域**，不能放进 apply()：下面 createTurnCostChip(L183)
    //   与 createDltManagerSection(L665) 都在 apply() 之外，放进 apply 里它们看不见，
    //   渲染时会 ReferenceError: detOwns is not defined（成本小签与 DLT 管理器一起挂）。
    var detOwns = function (st, surface) {
      var g = st && st.detGrant
      return !!(g && g.present && g.grants && g.grants[surface] === true)
    }

    // ══ 运行期开关（总开关 + 六个分模块）═══════════════════════════════════
    // 真值在 Host（switch.json）：这里缓存一份并通知订阅者，
    // 于是「设置页里一改，三块 UI 立刻装卸」，不用刷新页面、更不用重启。
    var FALLBACK_MODULE_KEYS = ['cost', 'balance', 'documents', 'preview', 'environment', 'run', 'draft']

    function createSwitchStore(call) {
      var state = {
        loading: true, enabled: true, modules: {}, meta: {}, moduleKeys: FALLBACK_MODULE_KEYS,
        path: '', source: 'config', error: null, tools: [], promptSection: false,
        busy: false, message: null, diag: null,
        // 上级（DET）的接管声明。DET 不在/没开总开关时 present=false，DLT 自己全责。
        detGrant: { present: false, grants: {}, reason: '' },
        // DET 是否**全面接管**（grants.dlt === true）：为 true 时 DLT 本体停摆，
        // 本半区的全部界面注入（含「DLT 管理器」设置页入口）都不注册。
        detTakeover: false,
      }
      var listeners = []
      function notify() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](state) } catch (e) { /* ignore */ } } }
      function absorb(info) {
        if (!info || info.ok === false) {
          state = Object.assign({}, state, { loading: false, error: (info && info.error) || '开关读取失败' })
          notify()
          return state
        }
        state = Object.assign({}, state, {
          loading: false,
          enabled: info.enabled !== false,
          modules: info.modules || {},
          meta: info.moduleMeta || {},
          moduleKeys: (info.moduleKeys && info.moduleKeys.length) ? info.moduleKeys : FALLBACK_MODULE_KEYS,
          path: info.path || '',
          source: info.source || 'config',
          error: info.error || null,
          tools: info.tools || [],
          promptSection: info.promptSection === true,
          detGrant: info.detGrant || state.detGrant || { present: false, grants: {}, reason: '' },
          detTakeover: info.detTakeover === true,
        })
        notify()
        return state
      }
      var store = {
        get: function () { return state },
        subscribe: function (fn) {
          listeners.push(fn)
          return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) }
        },
        absorb: absorb,
        load: function () {
          return call('switchGet', {}).then(absorb, function (error) {
            state = Object.assign({}, state, {
              loading: false,
              error: '读不到运行期开关（Host 端点未就绪？）：' + String(error && error.message ? error.message : error),
            })
            notify()
            return state
          })
        },
        set: function (patch) {
          state = Object.assign({}, state, { busy: true, message: null })
          notify()
          return call('switchSet', patch).then(function (info) {
            absorb(info)
            state = Object.assign({}, state, {
              busy: false,
              message: info && info.saved === false
                ? '⚠ 已即时生效，但没写进 switch.json：' + (info.saveError || '')
                : '✓ 已保存并即时生效',
            })
            notify()
            return state
          }, function (error) {
            state = Object.assign({}, state, { busy: false, message: '✗ ' + String(error && error.message ? error.message : error) })
            notify()
            return state
          })
        },
      }
      return store
    }

    /** React 侧订阅（组件重渲染由 store 通知驱动）。 */
    function useSwitch(store) {
      var pair = React.useState(store.get())
      var set = pair[1]
      React.useEffect(function () {
        set(store.get())
        return store.subscribe(function (next) { set(next) })
      }, [])
      return pair[0]
    }

    /** 设置页「DLT 管理器」：总开关 + 六个分模块开关 + 当前装载事实 + 诊断。 */
    function createDltManagerSection(store, call) {
      return function DltManagerSection() {
        var st = useSwitch(store)
        var diagPair = React.useState(null)
        var diag = diagPair[0]
        var setDiag = diagPair[1]
        React.useEffect(function () { store.load() }, [])
        var on = st.enabled !== false
        var keys = st.moduleKeys || FALLBACK_MODULE_KEYS
        var toggleMaster = function () { if (!st.busy) store.set({ enabled: !on }) }
        var toggleModule = function (key) {
          if (st.busy || !on) return
          var modules = {}
          modules[key] = !(st.modules[key] !== false)
          store.set({ modules: modules })
        }
        var metaOf = function (key) { return (st.meta && st.meta[key]) || {} }
        // 版本符合提示：产品自带预览认领了后缀时如实说明 DLT 已退让，
        // 免得用户把「DLT 预览没出现」当成故障。
        var takeoverNote = function (key) {
          if (key === 'balance' && detOwns(st, 'balance')) {
            return ' · 已由 DET 接管（DET 状态框常显 DeepSeek 余额，重复实现已抑制；关掉 DET 总开关或 det.subordinate 即恢复）'
          }
          if (key === 'cost' && (detOwns(st, 'pricing') || detOwns(st, 'sessionCost'))) {
            return ' · 小签保留（「本轮 ¥」是 DLT 独有粒度）；展开里的单价 / 本会话累计已让位给 DET 状态框'
          }
          if (key !== 'preview') return ''
          var hit = []
          for (var i = 0; i < PREVIEW_DEFS.length; i++) {
            if (previewTakeover[PREVIEW_DEFS[i].id]) hit.push(PREVIEW_DEFS[i].kind)
          }
          if (!hit.length) return ''
          return ' · 本宿主自带预览已接管 ' + hit.join(' / ') + '（原生实现优先级更高，DLT 已退让，此模块在这些后缀上不生效）'
        }
        var row = function (key) {
          var modOn = on && st.modules[key] !== false
          var meta = metaOf(key)
          return React.createElement('div', {
            key: key,
            className: 'dlt-set-row' + (on ? '' : ' dlt-set-row-muted'),
            role: 'switch',
            'aria-checked': modOn ? 'true' : 'false',
            onClick: function () { toggleModule(key) },
          },
            React.createElement('div', { className: 'dlt-set-row-main' },
              React.createElement('div', { className: 'dlt-set-row-name' }, meta.label || key),
              React.createElement('div', { className: 'dlt-set-sub' }, (meta.desc || '') + takeoverNote(key) + (on ? '' : ' · 总开关关闭中，分模块此刻都不生效'))
            ),
            React.createElement('span', { className: 'dlt-set-switch' + (modOn ? ' dlt-set-switch-on' : '') }, '')
          )
        }
        return React.createElement('div', { className: 'dlt-set' },
          React.createElement('p', { className: 'dlt-set-note' },
            'DLT 是常驻永久插件。这里的开关**即时生效、并持久化**（switch.json），改完不用重启；总开关关掉即卸下 DLT 的全部模型工具与系统提示注入，只留本页这个开关，随时可以打开。'),
          React.createElement('div', {
            className: 'dlt-set-master' + (on ? '' : ' dlt-set-master-off'),
            role: 'switch',
            'aria-checked': on ? 'true' : 'false',
            title: on ? '点击关闭：卸下 DLT 的全部注入' : '点击开启：恢复 DLT',
            onClick: toggleMaster,
          },
            React.createElement('div', { className: 'dlt-set-master-main' },
              React.createElement('div', { className: 'dlt-set-master-name' }, '总开关 · DLT'),
              React.createElement('div', { className: 'dlt-set-sub' }, on
                ? '已开启：按下面的分模块开关装载 DLT（模型工具 / 系统提示 / 界面注入）'
                : '已关闭：模型工具（dlt_env / dlt_run / dlt_build / dlt_doc_read / dlt_doc_write / dlt_doc_convert）与系统提示注入都已卸下，界面上的成本小签、余额卡、右栏预览也已撤下')
            ),
            React.createElement('span', { className: 'dlt-set-switch' + (on ? ' dlt-set-switch-on' : '') }, '')
          ),
          React.createElement('div', { className: 'dlt-set-rows' }, keys.map(row)),
          React.createElement('div', { className: 'dlt-set-foot' },
            React.createElement('div', { className: 'dlt-set-sub' },
              '当前装载的模型工具：' + ((st.tools && st.tools.length) ? st.tools.join('、') : '（无）') +
              (st.promptSection ? ' · 系统提示已注入' : ' · 系统提示未注入')),
            React.createElement('div', { className: 'dlt-set-sub dlt-mono' },
              '状态文件：' + (st.path || '—') + '（来源：' + (st.source === 'file' ? 'switch.json' : 'cordis.patch.yml 默认值') + '）'),
            st.error ? React.createElement('div', { className: 'dlt-set-err' }, '⚠ ' + st.error) : null,
            st.message ? React.createElement('div', { className: 'dlt-set-msg' }, st.message) : null,
            React.createElement('div', { className: 'dlt-set-btns' },
              React.createElement('button', {
                className: 'dlt-set-btn',
                onClick: function () { store.load() },
              }, '重新读取'),
              React.createElement('button', {
                className: 'dlt-set-btn',
                onClick: function () {
                  setDiag('读取中…')
                  call('status', {}).then(function (info) {
                    if (!info || info.ok === false) { setDiag('✗ ' + ((info && info.error) || 'status 不可用')); return }
                    setDiag([
                      '版本 ' + info.version,
                      'pythonEnv ' + info.pythonEnv,
                      'pythonEngine ' + (info.paths && info.paths.pythonEngineExists ? '在' : '缺'),
                      '定价 ' + (info.pricing && info.pricing.source ? (info.pricing.source + (info.pricing.stale ? '(缓存)' : '')) : (info.pricing && info.pricing.skipped ? info.pricing.skipped : '—')),
                      '每轮折叠 ' + (info.turnUsageFold || '未加载'),
                    ].join(' · '))
                  }, function (error) { setDiag('✗ ' + String(error && error.message ? error.message : error)) })
                },
              }, '诊断'),
              diag ? React.createElement('span', { className: 'dlt-set-sub' }, diag) : null
            )
          )
        )
      }
    }


    // ══ 草图（draft：现画一张 → 导入输入框）═══════════════════════════════
    //
    // 输入框工具行里、「+」旁边的小铅笔按钮。点开一块画布，画完点「导入」：
    //   ① 先经 Host 的 draftSave 把 PNG 落成工作区文件（<工作区>/.dsh-drafts/sketch-*.png）——
    //      草图于是总有一份能复用的实体文件；
    //   ② 再看这个会话当前的模型收不收图片（Host 的 draftSupport，按 inputModalities 判定）：
    //        · 收 → 作为图片附件挂进输入框；
    //        · 不收（纯文本模型）→ 把工作区相对路径插进输入框文字。
    // 判定放 Host：客户端不猜，免得「挂上去了、发送时才被宿主以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝」。

    /** 当前会话 id。输入框工具行槽位不传 props（renderSlot(name, {})），只能自己从 sessions 取。 */
    function currentSessionId(ctx) {
      try {
        var sessions = ctx.get('sessions')
        var snap = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
          ? sessions.list.getSnapshot()
          : null
        var cur = snap && snap.current
        if (typeof cur === 'string') return cur
        if (cur && cur.id) return cur.id
      } catch (e) { /* 取不到就由调用方兜底 */ }
      return undefined
    }

    /** 画布逻辑尺寸。960×600 = 57.6 万像素，落在视觉模型的图片像素预算之内。 */
    var SKETCH_W = 960
    var SKETCH_H = 600
    var SKETCH_COLORS = ['#111111', '#d93025', '#1a73e8', '#137333', '#f9ab00']
    var SKETCH_WIDTHS = [2, 4, 8, 16]

    function sk2(n) { return String(n).padStart(2, '0') }
    /** 草图文件名里的时间戳：sketch-YYYYmmdd-HHMMSS.png（与 Host 的 stamp() 同风格）。 */
    function sketchStamp(date) {
      return String(date.getFullYear()) + sk2(date.getMonth() + 1) + sk2(date.getDate()) + '-' +
        sk2(date.getHours()) + sk2(date.getMinutes()) + sk2(date.getSeconds())
    }

    /**
     * 把画布产物交付到输入框。
     * allowImage=true 且模型收图时挂图片附件，否则把工作区相对路径插进文字。
     * @returns {{mode:'image'|'file', path:string, rel:(string|null), name:string}}
     */
    function deliverSketch(ctx, blob, name, saved, sessionId, allowImage) {
      var conv = null
      try { conv = ctx.get('conversation') } catch (e) { conv = null }
      var shell = null
      try {
        if (conv && conv.input && typeof conv.input.shell === 'function' && sessionId) shell = conv.input.shell(sessionId)
      } catch (e) { shell = null }

      // ① 图片附件：createDrafts(图片草稿) + shell.addAttachments(id)。
      if (allowImage && conv && typeof conv.createDrafts === 'function' && shell && typeof shell.addAttachments === 'function') {
        try {
          var file = new File([blob], name, { type: 'image/png' })
          var drafts = conv.createDrafts(sessionId, [file])
          var ids = drafts.map(function (d) { return d.id })
          if (shell.addAttachments(ids)) {
            return { mode: 'image', path: saved.path, rel: saved.rel, name: name }
          }
          if (typeof conv.releaseDraftAttachments === 'function') conv.releaseDraftAttachments(drafts)
        } catch (e) { /* 落到下面的「路径」分支 */ }
      }

      // ② 回落：把工作区相对路径插进输入框文字（纯文本模型也能把这张图记住）。
      var rel = saved.rel || saved.path
      var line = '\n[草图] ' + rel + '（当前模型不支持图片输入；切到视觉模型后可用 read_image 查看这张图）'
      if (shell && typeof shell.paste === 'function') {
        shell.paste(line)
      } else if (shell && typeof shell.setDraft === 'function') {
        var cur = (shell.snapshot && shell.snapshot.draft) || ''
        shell.setDraft(cur + line)
      } else {
        try { navigator.clipboard.writeText(rel) } catch (e) { /* 剪贴板也不可用时只留 toast */ }
      }
      return { mode: 'file', path: saved.path, rel: saved.rel, name: name }
    }

    /** 草图画布弹窗。props: { call, ctx, sessionId, onClose, onDone }。 */
    function SketchPad(props) {
      var call = props.call
      var ctx = props.ctx
      var canvasRef = React.useRef(null)
      var dragging = React.useRef(false)
      var lastPt = React.useRef(null)
      var history = React.useRef([])
      var dirty = React.useRef(false)

      var colorPair = React.useState(SKETCH_COLORS[0])
      var color = colorPair[0]
      var setColor = colorPair[1]
      var widthPair = React.useState(SKETCH_WIDTHS[1])
      var width = widthPair[0]
      var setWidth = widthPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var msgPair = React.useState(null)
      var msg = msgPair[0]
      var setMsg = msgPair[1]
      var supportPair = React.useState(null)
      var support = supportPair[0]
      var setSupport = supportPair[1]
      var revPair = React.useState(0)
      var setRev = revPair[1]   // 只是为了让「撤销/清空」按钮的禁用态刷新

      // 挂载：铺白底、置线帽线角；顺便问一次 Host「这个会话的模型收不收图片」。
      React.useEffect(function () {
        var canvas = canvasRef.current
        if (canvas) {
          canvas.width = SKETCH_W
          canvas.height = SKETCH_H
          var g = canvas.getContext('2d')
          if (g) {
            g.fillStyle = '#ffffff'
            g.fillRect(0, 0, SKETCH_W, SKETCH_H)
            g.lineCap = 'round'
            g.lineJoin = 'round'
          }
        }
        history.current = []
        dirty.current = false
        var alive = true
        call('draftSupport', { sessionId: props.sessionId }).then(function (r) {
          if (alive && r && r.ok) setSupport(r)
        }).catch(function () { /* 问不到就按「纯文本模型」处理 */ })
        var onKey = function (event) { if (event.key === 'Escape') props.onClose() }
        try { window.addEventListener('keydown', onKey) } catch (e) { /* ignore */ }
        return function () {
          alive = false
          try { window.removeEventListener('keydown', onKey) } catch (e) { /* ignore */ }
        }
      }, [])

      var pointOf = function (event) {
        var canvas = canvasRef.current
        var rect = canvas.getBoundingClientRect()
        var scaleX = rect.width > 0 ? SKETCH_W / rect.width : 1
        var scaleY = rect.height > 0 ? SKETCH_H / rect.height : 1
        return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY }
      }
      var pushHistory = function () {
        var canvas = canvasRef.current
        if (!canvas) return
        try {
          history.current.push(canvas.toDataURL('image/png'))
          if (history.current.length > 12) history.current.shift()
        } catch (e) { /* ignore */ }
      }
      var onDown = function (event) {
        if (busy) return
        var canvas = canvasRef.current
        if (!canvas) return
        event.preventDefault()
        try { canvas.setPointerCapture(event.pointerId) } catch (e) { /* ignore */ }
        dragging.current = true
        lastPt.current = pointOf(event)
        // 单击也要留一个点，否则「点一下」什么都不会发生。
        var g = canvas.getContext('2d')
        if (g) {
          g.fillStyle = color
          g.beginPath()
          g.arc(lastPt.current.x, lastPt.current.y, Math.max(1, width / 2), 0, Math.PI * 2)
          g.fill()
        }
        dirty.current = true
      }
      var onMove = function (event) {
        if (!dragging.current || busy) return
        var canvas = canvasRef.current
        if (!canvas) return
        event.preventDefault()
        var p = pointOf(event)
        var from = lastPt.current || p
        var g = canvas.getContext('2d')
        if (g) {
          g.strokeStyle = color
          g.lineWidth = width
          g.beginPath()
          g.moveTo(from.x, from.y)
          g.lineTo(p.x, p.y)
          g.stroke()
        }
        lastPt.current = p
      }
      var onUp = function (event) {
        if (!dragging.current) return
        dragging.current = false
        lastPt.current = null
        try { canvasRef.current.releasePointerCapture(event.pointerId) } catch (e) { /* ignore */ }
        pushHistory()
        setRev(function (n) { return n + 1 })
      }
      var undo = function () {
        var canvas = canvasRef.current
        if (!canvas || history.current.length === 0) return
        var url = history.current.pop()
        var img = new Image()
        img.onload = function () {
          var g = canvas.getContext('2d')
          if (g) {
            g.clearRect(0, 0, SKETCH_W, SKETCH_H)
            g.drawImage(img, 0, 0)
          }
        }
        img.src = url
        setRev(function (n) { return n + 1 })
      }
      var clearAll = function () {
        var canvas = canvasRef.current
        if (!canvas) return
        pushHistory()
        var g = canvas.getContext('2d')
        if (g) {
          g.fillStyle = '#ffffff'
          g.fillRect(0, 0, SKETCH_W, SKETCH_H)
        }
        dirty.current = false
        setRev(function (n) { return n + 1 })
      }

      /** 导入：画布 → PNG blob → draftSave 落盘 → 交付（图片附件 / 路径）。 */
      var doImport = function () {
        var canvas = canvasRef.current
        if (!canvas || busy) return
        if (!dirty.current) { setMsg({ ok: false, text: '画布还是空的：先画两笔再导入' }); return }
        setBusy(true)
        setMsg(null)
        var sessionId = props.sessionId || currentSessionId(ctx)
        var name = 'sketch-' + sketchStamp(new Date()) + '.png'
        var withSupport = support
          ? Promise.resolve(support)
          : call('draftSupport', { sessionId: sessionId }).catch(function () { return null })
        var toBlob = new Promise(function (resolve) {
          try {
            canvas.toBlob(function (blob) { resolve(blob) }, 'image/png')
          } catch (e) { resolve(null) }
        })
        Promise.all([toBlob, withSupport]).then(function (pair) {
          var blob = pair[0]
          var sup = pair[1]
          if (!blob) throw new Error('画布导出 PNG 失败（浏览器不支持 toBlob？）')
          return new Promise(function (resolve, reject) {
            var reader = new FileReader()
            reader.onload = function () { resolve(String(reader.result || '')) }
            reader.onerror = function () { reject(new Error('读取画布数据失败')) }
            reader.readAsDataURL(blob)
          }).then(function (dataUrl) {
            return call('draftSave', { sessionId: sessionId, dataUrl: dataUrl, name: name }).then(function (saved) {
              if (!saved || saved.ok === false) throw new Error((saved && saved.error) || '草图保存失败')
              return { blob: blob, saved: saved, sup: sup, sessionId: sessionId, name: name }
            })
          })
        }).then(function (r) {
          // 模型收图才挂附件；否则（含问不到 support 的情况）一律走「路径」这条稳妥路。
          var out = deliverSketch(ctx, r.blob, r.name, r.saved, r.sessionId, !!(r.sup && r.sup.images))
          setBusy(false)
          props.onDone(out)
        }).catch(function (error) {
          setBusy(false)
          setMsg({ ok: false, text: '✗ ' + String(error && error.message ? error.message : error) })
        })
      }

      var hintText = support
        ? (support.images ? '当前模型支持图片：导入后作为图片附件' : (support.reason || '将存成 PNG 并把路径插进输入框'))
        : '正在确认当前模型是否支持图片…'

      return React.createElement('div', {
        className: 'dlt-sk-mask',
        onMouseDown: function (event) { if (event.target === event.currentTarget && !busy) props.onClose() },
      },
        React.createElement('div', { className: 'dlt-sk-panel' },
          React.createElement('div', { className: 'dlt-sk-head' },
            React.createElement('span', null, '草图 · 现画一张'),
            React.createElement('span', { className: 'dlt-sk-hint' }, hintText)
          ),
          React.createElement('div', { className: 'dlt-sk-tools' },
            SKETCH_COLORS.map(function (c) {
              return React.createElement('button', {
                key: c, type: 'button',
                className: 'dlt-sk-sw' + (c === color ? ' dlt-sk-sw-on' : ''),
                style: { background: c },
                title: '颜色 ' + c,
                'aria-label': '画笔颜色 ' + c,
                onClick: function () { setColor(c) },
              })
            }),
            React.createElement('span', { className: 'dlt-sk-note' }, '·'),
            SKETCH_WIDTHS.map(function (w) {
              return React.createElement('button', {
                key: 'w' + w, type: 'button',
                className: 'dlt-sk-btn' + (w === width ? ' dlt-sk-sw-on' : ''),
                title: '线宽 ' + w + 'px',
                onClick: function () { setWidth(w) },
              }, w + 'px')
            }),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', {
              type: 'button', className: 'dlt-sk-btn',
              disabled: history.current.length === 0 || busy,
              onClick: undo,
            }, '撤销'),
            React.createElement('button', {
              type: 'button', className: 'dlt-sk-btn', disabled: busy, onClick: clearAll,
            }, '清空')
          ),
          React.createElement('div', { className: 'dlt-sk-stage' },
            React.createElement('canvas', {
              ref: canvasRef,
              className: 'dlt-sk-canvas',
              width: SKETCH_W,
              height: SKETCH_H,
              onPointerDown: onDown,
              onPointerMove: onMove,
              onPointerUp: onUp,
              onPointerCancel: onUp,
              onPointerLeave: onUp,
            })
          ),
          React.createElement('div', { className: 'dlt-sk-foot' },
            msg ? React.createElement('span', { className: 'dlt-sk-err' }, msg.text) : null,
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', {
              type: 'button', className: 'dlt-sk-btn', disabled: busy, onClick: props.onClose,
            }, '取消'),
            React.createElement('button', {
              type: 'button', className: 'dlt-sk-btn dlt-sk-sw-on', disabled: busy, onClick: doImport,
            }, busy ? '导入中…' : '导入')
          )
        )
      )
    }

    /** 输入框「+」旁的草图按钮：点开画布弹窗。 */
    function createDraftButton(deps) {
      return function DraftButton() {
        var openPair = React.useState(false)
        var open = openPair[0]
        var setOpen = openPair[1]
        var notePair = React.useState(null)
        var note = notePair[0]
        var setNote = notePair[1]

        var close = function () { setOpen(false) }
        var done = function (out) {
          setOpen(false)
          if (!out) return
          var text = out.mode === 'image'
            ? '✓ 草图已作为图片附件放进输入框（原图：' + (out.rel || out.path) + '）'
            : '✓ 草图画好了：' + (out.rel || out.path) + '（当前模型不支持图片输入，路径已插进输入框）'
          setNote({ ok: true, text: text })
        }
        var body = typeof document !== 'undefined' ? document.body : null
        var mask = open
          ? React.createElement(SketchPad, {
            call: deps.call,
            ctx: deps.ctx,
            sessionId: currentSessionId(deps.ctx),
            onClose: close,
            onDone: done,
          })
          : null
        var pad = mask && ReactDOM && body ? ReactDOM.createPortal(mask, body) : mask
        return React.createElement('span', { className: 'dlt-draft-wrap', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
          React.createElement('button', {
            type: 'button',
            className: 'dlt-draft-btn',
            title: '画一张草图并导入输入框（模型能看图就是图片附件，否则存 PNG + 插路径）',
            'aria-label': '画草图并导入',
            onMouseDown: function (event) { event.preventDefault() },
            onClick: function () { setNote(null); setOpen(true) },
          },
            React.createElement('svg', {
              viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true,
              fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
            },
              React.createElement('path', { d: 'M11.6 2.4l2 2-8.1 8.1-2.7.7.7-2.7 8.1-8.1z' }),
              React.createElement('path', { d: 'M10.2 3.8l2 2' })
            )
          ),
          note ? React.createElement('span', {
            className: note.ok ? 'dlt-set-msg' : 'dlt-set-err',
            title: note.text,
            style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, note.text) : null
        )
      }
    }

    // ══ apply ══════════════════════════════════════════════════════════════
    function apply(ctx) {
      var call = makeCaller(function () { return ctx.get('connection') })
      var switchStore = createSwitchStore(call)

      // 样式：挂在 fiber 上，停用即移除。
      ctx.effect(function () {
        if (typeof document === 'undefined') return function () {}
        var el = document.createElement('style')
        el.setAttribute('data-plugin', 'dlt')
        el.textContent = CSS
        document.head.append(el)
        return function () { try { el.remove() } catch (e) { /* ignore */ } }
      }, 'dlt: styles')

      // ── 按开关门控的注册器 ───────────────────────────────────────────────
      // 条件满足就挂上，条件不满足就立刻撤下；开关一变（store 通知）重新评估，
      // 所以「关掉总开关」时界面注入是**当场消失**的，不需要刷新页面。
      var gated = []
      var gateRefresh = function () {
        var st = switchStore.get()
        for (var i = 0; i < gated.length; i++) {
          var g = gated[i]
          var want = false
          try { want = g.when(st) === true } catch (e) { want = false }
          if (want && !g.disposer) {
            try { var d = g.setup(); g.disposer = typeof d === 'function' ? d : null } catch (e) { warn('注册失败 ' + g.key + '：' + (e && e.message ? e.message : e)) }
          } else if (!want && g.disposer) {
            try { g.disposer() } catch (e) { /* ignore */ }
            g.disposer = null
          }
        }
      }
      var gate = function (key, when, setup) {
        gated.push({ key: key, when: when, setup: setup, disposer: null })
        gateRefresh()
      }
      ctx.effect(function () { return switchStore.subscribe(gateRefresh) }, 'dlt: switch gate')
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < gated.length; i++) {
            if (!gated[i].disposer) continue
            try { gated[i].disposer() } catch (e) { /* ignore */ }
            gated[i].disposer = null
          }
        }
      }, 'dlt: gated teardown')

      var moduleOn = function (st, key) { return st.enabled !== false && st.modules[key] !== false }

      // ── 1) 每轮成本小签 ──────────────────────────────────────────────────
      var costStore = createCostStore(call)
      var Chip = createTurnCostChip(call, costStore, switchStore)
      gate('cost', function (st) { return moduleOn(st, 'cost') && !detOwns(st, 'dlt') }, function () {
        return ctx.slots.inject('conversation.chat.turnTail', function () {
          // ⚠ 这个槽在两代宿主里**类型变了**，必须两种形态都试：
          //   · 0.1.5~0.1.6 —— kind: 'chain'，注册选项是**必填的 select**，
          //     由选择器决定哪一轮认领；非本轮的 turn 返回 null 即不占位。
          //   · 0.1.7 起   —— kind: 'list'，选项换成 id / order / label，
          //     **不再有 select**。继续按 chain 注册会抛错，而 gate 的 setup
          //     只把异常打成一条 warn，于是小签静默消失 —— 这正是它的失因。
          // 先按 chain 注册（老宿主只能这么注册），抛错再按 list 补一次。
          var selectClosedTurn = function (owner) {
            var t = owner && owner.turn
            if (!t || t.status !== 'closed') return null
            return { turn: t.turn }
          }
          try {
            return ctx.slots.register({
              name: 'conversation.chat.turnTail',
              select: selectClosedTurn,
            }, Chip)
          } catch (e) {
            return ctx.slots.register({
              name: 'conversation.chat.turnTail',
              id: 'dlt-cost',
              order: 20,
            }, Chip)
          }
        })
      })

      // ── 2) 右下角余额 ────────────────────────────────────────────────────
      // DET 总开关打开时，余额与 DET 状态框**完全重复** → 让位，不注册。
      var Balance = createBalanceWidget(call)
      gate('balance', function (st) { return moduleOn(st, 'balance') && !detOwns(st, 'balance') && !detOwns(st, 'dlt') }, function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'dlt-balance', order: 302 }, Balance)
        })
      })

      // ── 3) 输入框「+」旁的草图按钮 ───────────────────────────────────────
      // 现画一张草图，导入成图片附件（模型收图时）或「PNG 落盘 + 路径插进文字」。
      var DraftButton = createDraftButton({ call: call, ctx: ctx })
      gate('draft', function (st) { return moduleOn(st, 'draft') && !detOwns(st, 'dlt') }, function () {
        return ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register({ name: 'conversation.input.left', id: 'dlt-draft', order: 40 }, DraftButton)
        })
      })

      // ── 4) 右栏文档预览 ──────────────────────────────────────────────────
      // 预览渲染要 Host 的 office 端点（靠文档引擎），所以「右栏预览」与「文档工具」
      // 都开着才注册；任一关掉就交回产品自带渲染器。
      //
      // 让位判定（能力探测，不硬编码宿主版本）：
      //   产品自带预览在 0.1.5 只有 builtin 的 Markdown/代码/HTML/PDF/表格，
      //   **不含 docx/xlsx/pptx**，故这条线上 DLT 的 Office 渲染器仍然接管；
      //   0.1.7 起自带实现新增 Word/PPT→本地转 PDF 与 Excel 表格引擎
      //   （priority 依旧是 'builtin'），而外挂实现（priority 'extension'）
      //   在候选排序里**优先于 builtin**——继续注册就会反过来盖住更好的原生预览。
      //   故：某个后缀一旦有 builtin 实现认领，DLT 就对该后缀让位。
      var previewOn = function (st) { return moduleOn(st, 'preview') && moduleOn(st, 'documents') }
      var previews = null
      try { previews = ctx.get('documentPreviews') } catch (e) { previews = null }
      if (previews && typeof previews.register === 'function') {
        var nativeCovers = function (def) {
          if (typeof previews.getSnapshot !== 'function') return false
          var snap = null
          try { snap = previews.getSnapshot() } catch (e) { return false }
          if (!snap || !snap.length) return false
          for (var i = 0; i < snap.length; i++) {
            var other = snap[i]
            // priority 缺省即 'extension'；只有 builtin 才算「产品自带」。
            if (!other || (other.priority || 'extension') !== 'builtin') continue
            if (!other.extensions) continue
            for (var j = 0; j < def.extensions.length; j++) {
              if (other.extensions.indexOf(def.extensions[j]) !== -1) return true
            }
          }
          return false
        }
        PREVIEW_DEFS.forEach(function (def) {
          // 每次重估都刷新让位状态：gateRefresh 会反复调用 ours()，
          // 注册表订阅也会触发，所以管理器看到的始终是当前事实。
          var ours = function (st) {
            var taken = nativeCovers(def)
            previewTakeover[def.id] = taken
            return previewOn(st) && !taken && !detOwns(st, 'dlt')
          }
          gate('preview-meta-' + def.id, ours, function () {
            return previews.register({
              id: def.id,
              extensions: def.extensions,
              priority: 'extension',
              title: function () { return def.label },
              loading: 'bytes-complete',
              wrap: false,
            })
          })

          var Body = createOfficeBody(call, def.kind)
          gate('preview-body-' + def.id, ours, function () {
            return ctx.slots.inject('sidebar.right.tab.document', function () {
              return ctx.slots.register({ name: 'sidebar.right.tab.document', key: def.id }, Body)
            })
          })
        })
        // 产品实现可能在 DLT 之后才注册，故订阅注册表变化重新求值让位判定。
        if (typeof previews.subscribe === 'function') {
          ctx.effect(function () { return previews.subscribe(gateRefresh) }, 'dlt: documentPreviews 让位重估')
        }
      } else {
        warn('documentPreviews 服务不可用，右栏 Word/Excel 预览未注册（插件未停用时应能看到它）')
      }

      // ── 5) 设置页：DLT 管理器（**不受总开关影响**，否则关掉就没入口再打开）──
      // 但 DET 全面接管时**连这个入口都不注册**：此时 DLT 的一切（含它的开关页）
      // 都已归 DET，「DET 管理器 → DLT 集成」就是新的唯一入口；DET 一关它自动回来。
      gate('settings', function (st) { return !detOwns(st, 'dlt') }, function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dlt-manager',
            order: 87,
            label: function () { return 'DLT 管理器'; },
          }, createDltManagerSection(switchStore, call))
        })
      })

      // 首次读开关（挂载时才知道 Host 里存的到底是什么）；连接重置后重读。
      switchStore.load()
      ctx.effect(function () {
        return ctx.on('connection/reset', function () { switchStore.load() })
      }, 'dlt: reload switch on connection reset')

      // DET 的总开关/det.subordinate 随时会变：定期重读一次 Host 开关（含 detTakeover），
      // 这样「DET 一开，DLT 的界面当场消失；DET 一关，当场回来」，不必刷新页面。
      ctx.effect(function () {
        var timer = setInterval(function () { switchStore.load() }, 5000)
        return function () { clearInterval(timer) }
      }, 'dlt: poll host switch for det takeover')

      warn('已挂载：DLT 界面注入（成本小签 / 余额 / 草图 / 预览 / 管理器），按开关与 DET 接管声明装卸')
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = 'dlt'
    return module.exports
  },
})
