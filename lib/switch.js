// dlt/lib/switch.js — DLT 运行期开关（总开关 + 六个分模块）的持久层
//
// 职责：把「DLT 管理器」里的开关状态落到 <DSH_HOME>/dlt/switch.json，
// 让总开关/分模块开关**不重启也能生效、重启后仍然记得**。
//
// 设计取舍：
//   · 文件是纯 JSON、字段少，坏了能一眼看懂并手改（比藏进宿主存储更透明）。
//   · cordis.patch.yml 里那份 config 只当**默认值**：没有 switch.json 时用它，
//     一旦在设置页动过开关就以文件为准（用户在 UI 上做的选择不会被 patch 覆盖）。
//   · 纯数据层 + 两个 IO 函数，可单测（tests/switch.test.mjs）。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './core.js'

/** 六个分模块开关的顺序（UI 与落盘顺序一致）。 */
export const MODULE_KEYS = ['cost', 'balance', 'documents', 'preview', 'environment', 'run']

/** 分模块开关的人话说明（host 与 client 共用，避免两处各写一份）。 */
export const MODULE_META = {
  cost: { label: '每轮成本', desc: '每轮对话尾部的「本轮人民币成本」小签（读单价表 + 折叠该轮用量）。' },
  balance: { label: '账户余额', desc: '右下角 DeepSeek 账户余额悬浮卡（按间隔轮询余额接口，可拖动）。' },
  documents: { label: '文档工具', desc: 'dlt_doc_read / dlt_doc_write / dlt_doc_convert 三个模型工具与 Python 文档引擎。' },
  preview: { label: '右栏预览', desc: '给右栏的 docx / xlsx / csv 注册 DLT 渲染器（依赖「文档工具」，两者都开才有内容）。' },
  environment: { label: '环境表', desc: 'dlt_env 工具 + 系统提示里那份硬编码工具链清单。' },
  run: { label: '执行与编译', desc: 'dlt_run / dlt_build 两个模型工具（直接跑程序、编译工程）。' },
}

const FILE_NAME = 'switch.json'

/** 开关文件路径（cacheDir 为空时退回 <DSH_HOME>/dlt）。 */
export function switchPath(cacheDir) {
  const dir = cacheDir && String(cacheDir).trim() !== '' ? String(cacheDir) : join(dshHome(), 'dlt')
  return join(dir, FILE_NAME)
}

/** 由插件 config 推出的默认开关（patch.yml 只在这里起作用）。 */
export function switchDefaults(config = {}) {
  const modules = {}
  for (const key of MODULE_KEYS) modules[key] = config[key] !== false
  return { enabled: config.enabled !== false, modules }
}

/**
 * 把任意输入规整成 {enabled, modules}：布尔照收，其余落回 base。
 * base 缺省时按「全开」处理（与 config 默认值一致）。
 */
export function normalizeSwitch(raw, base) {
  const fallback = base && typeof base === 'object' ? base : { enabled: true, modules: {} }
  const fallbackModules = fallback.modules && typeof fallback.modules === 'object' ? fallback.modules : {}
  const rawModules = raw && typeof raw.modules === 'object' && raw.modules !== null ? raw.modules : {}
  const modules = {}
  for (const key of MODULE_KEYS) {
    modules[key] = typeof rawModules[key] === 'boolean'
      ? rawModules[key]
      : fallbackModules[key] !== false
  }
  const enabled = typeof (raw && raw.enabled) === 'boolean'
    ? raw.enabled
    : fallback.enabled !== false
  return { enabled, modules }
}

/**
 * 读开关：文件在就用文件，否则用 config 默认值。
 * 永不抛：文件坏了/读不到就退回默认值并把原因带回去（设置页会显示出来）。
 * @returns {Promise<{state:{enabled:boolean,modules:object},source:'file'|'config',path:string,error:(string|null)}>}
 */
export async function readSwitch(cacheDir, defaults) {
  const path = switchPath(cacheDir)
  const fallback = normalizeSwitch(null, defaults)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: fallback, source: 'config', path, error: null }
    return { state: fallback, source: 'config', path, error: `读取失败：${error && error.message ? error.message : error}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { state: fallback, source: 'config', path, error: `switch.json 不是合法 JSON（已按默认值运行）：${error && error.message ? error.message : error}` }
  }
  return { state: normalizeSwitch(parsed, fallback), source: 'file', path, error: null }
}

/** 同步读一遍（给「不想 await 的」少数场景用，语义与 readSwitch 一致）。 */
export function readSwitchSync(cacheDir, defaults) {
  const path = switchPath(cacheDir)
  const fallback = normalizeSwitch(null, defaults)
  try {
    return { state: normalizeSwitch(JSON.parse(readFileSync(path, 'utf8')), fallback), source: 'file', path, error: null }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: fallback, source: 'config', path, error: null }
    return { state: fallback, source: 'config', path, error: `读取失败：${error && error.message ? error.message : error}` }
  }
}

/**
 * 写开关（先写临时文件再改名，避免留下半截 JSON）。
 * @returns {Promise<{ok:boolean,path:string,error:(string|null)}>}
 */
export async function writeSwitch(cacheDir, state) {
  const path = switchPath(cacheDir)
  const clean = normalizeSwitch(state, state)
  const tmp = path + '.tmp'
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify({ version: 1, ...clean }, null, 2) + '\n', 'utf8')
    await rename(tmp, path)
    return { ok: true, path, error: null }
  } catch (error) {
    return { ok: false, path, error: `写入失败：${error && error.message ? error.message : error}` }
  }
}

/** 一行摘要（日志/README/设置页共用）。 */
export function describeSwitch(state) {
  const on = state && state.enabled !== false
  const parts = MODULE_KEYS.filter((key) => state && state.modules && state.modules[key] !== false)
  return `${on ? '开' : '关'} · 分模块 ${on ? (parts.length ? parts.join('/') : '全关') : '随总开关停用'}`
}
