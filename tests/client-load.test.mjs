/**
 * DLT 客户端半区装载测试（client-load）
 * ====================================================================
 * 为什么需要：lib/client.js 是 `window.__ModuleLoader__.load({factory})` 形式的
 * 预打包 bundle，此前**一条断言都没有** —— 而它现在承担两件事：
 *   · 草图按钮（conversation.input.left：现画一张 → 导入输入框）；
 *   · 「DET 全面接管时整体停摆」：switchGet 回报 detTakeover=true 时，
 *     成本小签 / 余额卡 / 草图按钮 / 右栏预览 / **DLT 管理器设置页**一个都不许挂。
 *
 * 本套在假 ModuleLoader + 假 require + 假 ctx（含会答 switchGet 的假 connection）下
 * **真执行** factory 与 apply(ctx)，逐场景核对「此刻到底挂着什么」。
 *
 *     node <repo>/tests/client-load.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0;
const failures = [];
const notes = [];
function ok(cond, label) {
  if (cond) { pass++; return true; }
  failures.push(label);
  return false;
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function section(t) { console.log(`\n-- ${t}`); }

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
const src = readFileSync(join(REPO, "lib", "client.js"), "utf8");

const reactStub = {
  createElement: function () { return { __el: true }; },
  Fragment: "fragment",
  useState: function (v) { return [typeof v === "function" ? v() : v, function () {}]; },
  useEffect: function () {},
  useMemo: function (fn) { try { return fn(); } catch (e) { return null; } },
  useCallback: function (fn) { return fn; },
  useRef: function () { return { current: null }; },
  createPortal: function (node, _container) { return node; },
};
const requireLog = [];
const bundleIds = [];

function loadBundle() {
  const registrations = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: function (def) { registrations.push(def); } } };
  try {
    // eslint-disable-next-line no-new-func
    new Function(src)();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  eq(registrations.length, 1, "每次执行 bundle 只向 ModuleLoader 注册一次");
  const def = registrations[0];
  bundleIds.push(def.id);
  const exportsObj = def.factory(function (id) {
    requireLog.push(id);
    if (id === "react") return reactStub;
    if (id === "react-dom") return reactStub;   // 允许（有 try/catch 兜底）
    throw new Error("client bundle 出现了未声明的外部依赖: " + id);
  });
  return exportsObj;
}

/** 在册登记表：返回的 disposer 会把它从在册集合里移除。
 *  inject 的 disposer 同时回收它内部注册的插槽 —— 与真实宿主一致（撤注入即撤子树）。 */
function makeLedger() {
  const live = [];
  let scope = null;
  const ledger = {
    live: live,
    add: function (name) {
      live.push(name);
      return function () {
        const at = live.indexOf(name);
        if (at >= 0) live.splice(at, 1);
      };
    },
    has: function (name) { return live.indexOf(name) !== -1; },
    inject: function (name, cb) {
      const inner = [];
      const previous = scope;
      scope = inner;
      const disposeInject = ledger.add("inject:" + name);
      try { cb(); } catch (e) { /* 单个插槽失败不应中断 */ }
      scope = previous;
      return function () {
        disposeInject();
        for (let i = inner.length - 1; i >= 0; i--) { try { inner[i](); } catch (e) { /* ignore */ } }
      };
    },
    register: function (name) {
      const dispose = ledger.add(name);
      if (scope) scope.push(dispose);
      return dispose;
    },
  };
  return ledger;
}

const MODULES_ON = { cost: true, balance: true, documents: true, preview: true, environment: true, run: true, draft: true };

function makeCtx(switchInfo) {
  const ledger = makeLedger();
  const connection = {
    rpc: {
      call: function (_route, method) {
        const name = String(method).replace("dlt/", "");
        if (name === "switchGet") return Promise.resolve({ ok: true, value: switchInfo });
        return Promise.resolve({ ok: false, error: { message: "stub " + name } });
      },
    },
  };
  const previews = {
    registered: [],
    register: function (def) { previews.registered.push(def.id); return ledger.register("preview:" + def.id); },
    getSnapshot: function () { return [{ priority: "builtin", extensions: ["md", "pdf"] }]; },
    subscribe: function () { return function () {}; },
  };
  const slots = {
    inject: function (name, cb) { return ledger.inject(name, cb); },
    register: function (def, _c) {
      const name = def && def.name ? def.name : String(def);
      const id = def && def.id ? "#" + def.id : (def && def.key ? "@" + def.key : "");
      return ledger.register("register:" + name + id);
    },
  };
  const ctx = {
    get: function (name) {
      if (name === "connection") return connection;
      if (name === "sessions") return { list: { getSnapshot: function () { return { current: "sess-1" }; } } };
      if (name === "documentPreviews") return previews;
      if (name === "conversation") return { input: { shell: function () { return null; } }, createDrafts: function () { return []; } };
      return undefined;
    },
    effect: function (fn) { let d = null; try { d = fn(); } catch (e) { /* ignore */ } return typeof d === "function" ? d : function () {}; },
    on: function () { return function () {}; },
    emit: function () {},
    logger: { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} },
    slots: slots,
    remote: {},
  };
  return { ctx: ctx, ledger: ledger, previews: previews };
}

function tick() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

/** 在册的预览渲染器 id（已撤销的不算）。 */
function livePreviews(ledger) {
  return ledger.live
    .filter((n) => n.indexOf("preview:") === 0)
    .map((n) => n.slice("preview:".length))
    .sort();
}

async function scenario(switchInfo) {
  const bundle = loadBundle();
  const fake = makeCtx(switchInfo);
  bundle.apply(fake.ctx);
  await tick();
  await tick();
  return fake;
}

function infoOf(overrides) {
  return Object.assign({
    ok: true,
    enabled: true,
    modules: Object.assign({}, MODULES_ON),
    moduleMeta: {},
    moduleKeys: ["cost", "balance", "documents", "preview", "environment", "run", "draft"],
    path: "switch.json",
    source: "file",
    error: null,
    tools: ["dlt_env"],
    promptSection: true,
    detTakeover: false,
    detGrant: { present: false, grants: {}, reason: "" },
  }, overrides || {});
}

// ─────────────────────────────────────────────────────────────
section("bundle 契约");

const probe = loadBundle();
eq(bundleIds.indexOf("dsh-light-tool") !== -1, true, "bundle id 不变（宿主按它装载）");
eq(requireLog.filter((id) => id === "react").length >= 1, true, "factory 通过宿主 require 取 react");
ok(typeof probe.apply === "function", "exports.apply 是客户端入口");
ok(typeof probe.name === "string" && probe.name === "dlt", "exports.name 仍是 dlt");
ok(Array.isArray(probe.inject), "exports.inject 是数组");
const bad = requireLog.filter((id) => id !== "react" && id !== "react-dom");
eq(bad.length, 0, `不得 require 其它外部依赖：${bad.join(", ") || "无"}`);

// ─────────────────────────────────────────────────────────────
section("开关全开 + DET 未接管：五块界面都在");

const on = await scenario(infoOf());
ok(on.ledger.has("inject:conversation.chat.turnTail"), "成本小签注入 turnTail");
ok(on.ledger.has("inject:shell.overlay"), "余额卡注入 shell.overlay");
ok(on.ledger.has("inject:conversation.input.left"), "草图按钮注入 conversation.input.left");
ok(on.ledger.has("register:conversation.input.left#dlt-draft"), "草图按钮真的注册了");
ok(on.ledger.has("inject:sidebar.right.tab.document"), "右栏预览注入 document 槽");
eq(livePreviews(on.ledger), ["dlt-csv", "dlt-docx", "dlt-xlsx"], "docx/xlsx/csv 三个预览渲染器都在册");
ok(on.ledger.has("inject:settings.section"), "「DLT 管理器」设置页入口在");
notes.push(`全开：在册 ${on.ledger.live.length} 项 · 预览 ${livePreviews(on.ledger).length} 个`);

// ─────────────────────────────────────────────────────────────
section("DET 全面接管：DLT 整体停摆（连设置页入口都没有）");

const taken = await scenario(infoOf({ detTakeover: true, detGrant: { present: true, grants: { dlt: true, balance: true }, reason: "DET 已全量接管" } }));
ok(!taken.ledger.has("inject:conversation.chat.turnTail"), "接管后不挂成本小签");
ok(!taken.ledger.has("inject:shell.overlay"), "接管后不挂余额卡");
ok(!taken.ledger.has("inject:conversation.input.left"), "接管后不挂草图按钮");
ok(!taken.ledger.has("inject:sidebar.right.tab.document"), "接管后不挂右栏预览");
eq(livePreviews(taken.ledger), [], "接管后一个预览渲染器都不在册");
ok(!taken.ledger.has("inject:settings.section"), "接管后连「DLT 管理器」设置页入口都撤下");
eq(taken.ledger.live.length, 0, "接管后在册登记为零（全部由 DET 提供）");

// ─────────────────────────────────────────────────────────────
section("只关草图模块：其余照旧");

const noDraft = await scenario(infoOf({ modules: Object.assign({}, MODULES_ON, { draft: false }) }));
ok(!noDraft.ledger.has("inject:conversation.input.left"), "关掉草模块后不再注入草图按钮");
ok(noDraft.ledger.has("inject:conversation.chat.turnTail"), "成本小签不受影响");
ok(noDraft.ledger.has("inject:settings.section"), "管理器设置页不受影响");

// ─────────────────────────────────────────────────────────────
section("总开关关闭：只留管理端点（界面全撤）");

const off = await scenario(infoOf({ enabled: false, modules: Object.assign({}, MODULES_ON, { cost: false, balance: false, draft: false }) }));
ok(!off.ledger.has("inject:conversation.chat.turnTail"), "总开关关闭后不挂成本小签");
ok(!off.ledger.has("inject:conversation.input.left"), "总开关关闭后不挂草图按钮");
ok(off.ledger.has("inject:settings.section"), "总开关关闭后仍保留「DLT 管理器」入口（否则没法再打开）");

// ─────────────────────────────────────────────────────────────
section("结果");
for (const n of notes) console.log("   · " + n);
if (failures.length === 0) {
  console.log(`\n✅ 全部通过：${pass} 项断言`);
  process.exit(0);
}
console.log(`\n❌ 失败 ${failures.length} 项 / 通过 ${pass} 项`);
for (const f of failures) console.log("   • " + f);
process.exit(1);
