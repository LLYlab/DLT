// dlt/lib/core.js — DLT 纯逻辑层
//
// 这里不 import 任何 Cordis / DSH 服务，只有 Node 标准库：
// 环境注册表、定价抓取与解析、人民币成本计算、进程执行器、Python/Office 桥。
// 目的：让 Host 半区（lib/index.js）只负责「接线」，而这些可被 node 直接自测。

import { spawn } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { delimiter, dirname, join, resolve, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PY_ENGINE = join(PACKAGE_ROOT, 'py', 'dlt_docs.py')
export const OFFICE_BRIDGE = join(PACKAGE_ROOT, 'py', 'dlt_office.ps1')

export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(os.homedir(), '.dsh')
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 硬编码的运行 / 编译环境表（第 5 项）
// ═══════════════════════════════════════════════════════════════════════════
//
// 这台机器上 cl / cmake / msbuild 都不在 PATH 里，必须靠 vcvarsall 注入环境，
// 所以「环境表」的价值就是把这件事写死，模型不用每次自己拼命令。

const VS18 = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community'

export const ENVIRONMENTS = {
  'msvc-x64': {
    label: 'MSVC x64 工具链（cl/link/lib，VS18 Community）',
    kind: 'msvc',
    arch: 'x64',
    vcvars: `${VS18}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    toolset: `${VS18}\\VC\\Tools\\MSVC`,
    tools: ['cl', 'link', 'lib', 'nmake', 'dumpbin', 'rc'],
    note: '进入后 cl.exe/link.exe 可用；源码目录用 cwd 参数指定。',
  },
  'msvc-x86': {
    label: 'MSVC x86 (32 位) 工具链',
    kind: 'msvc',
    arch: 'x86',
    vcvars: `${VS18}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    tools: ['cl', 'link', 'lib', 'nmake'],
  },
  'msvc-x64-x86': {
    label: 'MSVC 交叉：x64 宿主 → x86 目标',
    kind: 'msvc',
    arch: 'amd64_x86',
    vcvars: `${VS18}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
  },
  'msvc-x86-x64': {
    label: 'MSVC 交叉：x86 宿主 → x64 目标',
    kind: 'msvc',
    arch: 'x86_amd64',
    vcvars: `${VS18}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
  },
  msbuild: {
    label: 'MSBuild（VS18 Community，自动带 MSVC x64 环境）',
    kind: 'msvc',
    arch: 'x64',
    vcvars: `${VS18}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    program: `${VS18}\\MSBuild\\Current\\Bin\\MSBuild.exe`,
    note: '也可用环境 msvc-x64 + program msbuild 达到同样效果。',
  },
  'vs-cmake': {
    label: 'CMake（VS18 自带，配合 MSVC x64）',
    kind: 'msvc',
    arch: 'x64',
    vcvars: `${VS18}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    program: `${VS18}\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe`,
  },
  'vs-ninja': {
    label: 'Ninja（VS18 自带，配合 MSVC x64）',
    kind: 'msvc',
    arch: 'x64',
    vcvars: `${VS18}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    program: `${VS18}\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\Ninja\\ninja.exe`,
  },
  python312: {
    label: 'Python 3.12.10（含 pymupdf/pypdf/python-docx/openpyxl/pdf2docx/Pillow 等文档库）',
    kind: 'plain',
    program: 'C:\\Users\\L2959\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
    version: '3.12.10',
    note: 'DLT 的文档引擎 dlt_docs.py 就跑在这个解释器上。',
  },
  python39: {
    label: 'Python 3.9.13（Visual Studio 自带）',
    kind: 'plain',
    program: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Shared\\Python39_64\\python.exe',
    version: '3.9.13',
  },
  'py-launcher': {
    label: 'Windows Python 启动器 py.exe（可 py -3.12 / -3.9 切换）',
    kind: 'plain',
    program: 'C:\\WINDOWS\\py.exe',
  },
  node: {
    label: 'Node.js（DSH 自身运行的这个）',
    kind: 'plain',
    program: process.execPath,
    version: process.version,
  },
  npm: {
    label: 'npm',
    kind: 'plain',
    program: 'C:\\Program Files\\nodejs\\npm.cmd',
    note: 'pnpm 未安装，本机 npm 可用。',
  },
  git: {
    label: 'Git',
    kind: 'plain',
    program: 'C:\\Program Files\\Git\\cmd\\git.exe',
  },
  dotnet: {
    label: '.NET SDK/CLI',
    kind: 'plain',
    program: 'C:\\Program Files\\dotnet\\dotnet.exe',
  },
  'windows-powershell': {
    label: 'Windows PowerShell 5.1（本机唯一的 PowerShell：未安装 PowerShell 7，harness 的 pwsh 实际就是它）',
    kind: 'plain',
    program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    version: '5.1',
    note: '踩坑记录：5.1 对「无 BOM 的 UTF-8 脚本」按 ANSI 解码，中文注释会撑坏语法 —— 本插件自带 .ps1 一律带 BOM 保存。',
  },
  cmd: {
    label: 'cmd.exe',
    kind: 'plain',
    program: 'C:\\Windows\\System32\\cmd.exe',
  },
  'office-com': {
    label: 'Microsoft Office COM 桥（Word/Excel 导出 PDF）',
    kind: 'com',
    program: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    note: '用 py/dlt_office.ps1 调用；docx/xlsx → PDF 保真最高。',
  },
  'edge-headless': {
    label: 'Microsoft Edge 无头模式（HTML → PDF）',
    kind: 'plain',
    program: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  },
}

// ── 路径解析层 ──────────────────────────────────────────────────────────────
//
// 上面表里的路径只是**默认值**，不是唯一答案。实际用哪条路径由
// resolveEnvironment() 逐次解析：
//   ① config.environments[<id>] 的显式覆盖（{ program?, vcvars?, arch?, label?, vsRoot? }）
//   ② 自动探测：VS 安装根扫描、%ProgramFiles% / %SystemRoot% / %LOCALAPPDATA% 展开、
//      常见安装位置、PATH 查找
//   ③ 表里的默认值（最后兜底，也是报错时展示的那条路径）
// 于是换一台机器基本不用动源码；个别对不上的，用配置覆盖即可。

const PF = process.env['ProgramFiles'] || 'C:\\Program Files'
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
const SYSROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
const LOCALAPPDATA = process.env.LOCALAPPDATA || ''
/** 探测不到 VS 时用的兜底安装根（= 本机原本写死的那个）。 */
const DEFAULT_VS_ROOT = join(PF, 'Microsoft Visual Studio', '18', 'Community')

/** VS 系环境：vcvars 在安装根下的固定相对位置。 */
const VS_VCVARS_REL = join('VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
/** VS 系环境里 program 相对安装根的位置；表里没有 rel 的，就是「靠 vcvars 进环境后用 cl/link」。 */
const VS_PROGRAM_REL = {
  msbuild: join('MSBuild', 'Current', 'Bin', 'MSBuild.exe'),
  'vs-cmake': join('Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe'),
  'vs-ninja': join('Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'Ninja', 'ninja.exe'),
}
const VS_ENVS = new Set(['msvc-x64', 'msvc-x86', 'msvc-x64-x86', 'msvc-x86-x64', 'msbuild', 'vs-cmake', 'vs-ninja'])

/** 非 VS 系环境：默认值不存在时按序再试的候选路径。 */
const PROGRAM_CANDIDATES = {
  python312: [
    ...(LOCALAPPDATA ? [join(LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe')] : []),
    join(PF, 'Python312', 'python.exe'),
    join('C:\\', 'Python312', 'python.exe'),
  ],
  python39: [
    join(PF86, 'Microsoft Visual Studio', 'Shared', 'Python39_64', 'python.exe'),
    join(PF, 'Microsoft Visual Studio', 'Shared', 'Python39_64', 'python.exe'),
  ],
  'py-launcher': [join(SYSROOT, 'py.exe')],
  npm: [join(PF, 'nodejs', 'npm.cmd'), join(PF86, 'nodejs', 'npm.cmd')],
  git: [
    join(PF, 'Git', 'cmd', 'git.exe'),
    join(PF86, 'Git', 'cmd', 'git.exe'),
    ...(LOCALAPPDATA ? [join(LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')] : []),
  ],
  dotnet: [join(PF, 'dotnet', 'dotnet.exe'), join(PF86, 'dotnet', 'dotnet.exe')],
  'windows-powershell': [join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
  cmd: [join(SYSROOT, 'System32', 'cmd.exe')],
  'office-com': [
    join(PF, 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'),
    join(PF86, 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'),
    join(PF, 'Microsoft Office', 'Office16', 'WINWORD.EXE'),
    join(PF86, 'Microsoft Office', 'Office16', 'WINWORD.EXE'),
  ],
  'edge-headless': [
    join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ],
}
/** 候选路径都不存在时，再去 PATH 里找这些名字。 */
const WHICH_NAMES = {
  python312: ['python', 'python3'],
  python39: ['python3.9'],
  'py-launcher': ['py'],
  npm: ['npm'],
  git: ['git'],
  dotnet: ['dotnet'],
}

function safeExists(target) {
  try {
    return existsSync(target)
  } catch {
    return false
  }
}

/** 在 PATH 里解析可执行文件（Windows 语义：按 PATHEXT 补扩展名）。 */
function which(name) {
  if (!name || /[\\/]/.test(name)) return null
  const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  const exts = ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (safeExists(candidate)) return candidate
    }
  }
  return null
}

/** 按顺序返回第一个真实存在的候选；都没有则 null。 */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && safeExists(candidate)) return candidate
  }
  return null
}

let vsRootCache
/** 探测 Visual Studio 安装根：认「根下有 VC\Auxiliary\Build\vcvarsall.bat」的那个。 */
function detectVsRoot() {
  if (vsRootCache !== undefined) return vsRootCache
  const years = ['18', '2022', '2026', '2019', '2017']
  const editions = ['Community', 'Professional', 'Enterprise', 'BuildTools', 'Preview']
  const roots = []
  if (process.env.VSINSTALLDIR) roots.push(process.env.VSINSTALLDIR)
  for (const base of [PF, PF86]) {
    for (const year of years) {
      for (const edition of editions) roots.push(join(base, 'Microsoft Visual Studio', year, edition))
    }
  }
  roots.push(DEFAULT_VS_ROOT)
  vsRootCache = roots.find((root) => safeExists(join(root, VS_VCVARS_REL))) || null
  return vsRootCache
}

/** 用户覆盖：{ [环境 id]: { program?, vcvars?, arch?, label?, vsRoot? } }。 */
let envOverrides = {}
const resolvedCache = new Map()

/**
 * 设置环境路径覆盖（Host 半区装载时用 `config.environments` 调用）。
 * 传 `{}` 即恢复「纯探测 + 默认值」。
 */
export function configureEnvironments(map) {
  envOverrides = map && typeof map === 'object' && !Array.isArray(map) ? map : {}
  vsRootCache = undefined
  resolvedCache.clear()
}

/**
 * 解析某个环境的**最终**路径。带覆盖时每次重算（配置可能热改），否则缓存。
 * @returns 与 `ENVIRONMENTS[id]` 同形，但 `program` / `vcvars` 已落到真实路径。
 */
export function resolveEnvironment(id) {
  const base = ENVIRONMENTS[id]
  if (!base) return null
  const override = envOverrides[id] && typeof envOverrides[id] === 'object' ? envOverrides[id] : null
  if (!override && resolvedCache.has(id)) return resolvedCache.get(id)

  const out = { ...base }
  if (override) {
    if (override.program) out.program = override.program
    if (override.vcvars) out.vcvars = override.vcvars
    if (override.arch) out.arch = override.arch
    if (override.label) out.label = override.label
  }

  if (VS_ENVS.has(id)) {
    // VS 系的 vcvars / program 是「安装根 + 固定相对位置」**推出来的**，不是照抄表里那条默认值 ——
    // 否则探测到了 VS2022，vcvars 还指着表里写死的 VS18。显式覆盖优先级最高。
    const root = (override && override.vsRoot) || detectVsRoot() || DEFAULT_VS_ROOT
    if (!(override && override.vcvars)) out.vcvars = join(root, VS_VCVARS_REL)
    const rel = VS_PROGRAM_REL[id]
    if (rel && !(override && override.program)) out.program = join(root, rel)
  } else if (!(override && override.program) && (!out.program || !safeExists(out.program))) {
    // 默认值不存在才去探测；显式覆盖一律优先，即使那条路径并不存在（这样报错也更清楚）。
    const found = firstExisting(PROGRAM_CANDIDATES[id] || [])
    if (found) out.program = found
    else {
      for (const name of WHICH_NAMES[id] || []) {
        const hit = which(name)
        if (hit) {
          out.program = hit
          break
        }
      }
    }
  }
  if (!override) resolvedCache.set(id, out)
  return out
}

/** 环境表 + 实际存在性，供 env_info 工具与系统提示使用。 */
export function describeEnvironments() {
  const rows = []
  for (const id of Object.keys(ENVIRONMENTS)) {
    const env = resolveEnvironment(id)
    const paths = [env.program, env.vcvars].filter(Boolean)
    rows.push({
      id,
      label: env.label,
      kind: env.kind,
      arch: env.arch || null,
      version: env.version || null,
      program: env.program || (env.kind === 'msvc' ? '（vcvars 环境内的 cl/link）' : null),
      vcvars: env.vcvars || null,
      tools: env.tools || [],
      available: paths.length === 0 ? true : paths.every((p) => safeExists(p)),
      missing: paths.filter((p) => !safeExists(p)),
      note: env.note || null,
    })
  }
  return rows
}

export function environment(id) {
  const env = resolveEnvironment(id)
  if (!env) {
    const known = Object.keys(ENVIRONMENTS).join(', ')
    throw new Error(`未知环境 "${id}"。可用环境: ${known}`)
  }
  return env
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 进程执行器（第 6 项）
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_OUTPUT = 256 * 1024

function cap(text, limit) {
  if (text.length <= limit) return { text, truncated: false }
  // 编译错误常在尾部（最后一行才是 error CXXXX），日志常在首部，两头都留。
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return {
    text: `${text.slice(0, head)}\n…（中间省略 ${text.length - limit} 字符，共 ${text.length} 字符，首尾各保留一部分）\n${text.slice(-tail)}`,
    truncated: true,
  }
}

/** 生成 MSVC 环境的 .cmd 包装脚本（避免在命令行里做 cmd 转义）。 */
function buildMsvcScript(env, program, args) {
  const quote = (s) => `"${String(s).replace(/"/g, '\\"').replace(/%/g, '%%')}"`
  const lines = [
    '@echo off',
    'chcp 65001 >nul 2>nul',
    `call ${quote(env.vcvars)} ${env.arch || 'x64'} >nul 2>nul`,
    'if errorlevel 1 (echo DLT: vcvarsall 失败 1>&2 & exit /b 9009)',
    [quote(program), ...args.map((a) => quote(a))].join(' '),
    'exit /b %ERRORLEVEL%',
  ]
  return lines.join('\r\n') + '\r\n'
}

/**
 * 在指定环境里执行程序。
 * @returns {{ok:boolean, exitCode:number|null, stdout:string, stderr:string, ms:number, command:string, truncated:boolean}}
 */
export async function runInEnvironment(options) {
  const {
    env: envId = 'cmd',
    program,
    args = [],
    cwd = process.cwd(),
    timeoutMs = 120000,
    stdin = null,
    maxOutput = DEFAULT_MAX_OUTPUT,
    extraEnv = {},
  } = options || {}

  const env = environment(envId)
  const started = Date.now()
  let realProgram = program || env.program
  let realArgs = [...args]
  let useShell = false

  if (env.kind === 'msvc') {
    if (!realProgram) {
      if (!program) throw new Error(`环境 "${envId}" 需要显式指定 program（例如 cl、link、msbuild）`)
      realProgram = program
    }
    if (realProgram === 'msbuild' || realProgram === 'MSBuild') realProgram = resolveEnvironment('msbuild').program
    if (realProgram === 'cmake') realProgram = resolveEnvironment('vs-cmake').program
    if (realProgram === 'ninja') realProgram = resolveEnvironment('vs-ninja').program
    const dir = await fsp.mkdtemp(join(os.tmpdir(), 'dlt-cmd-'))
    const scriptPath = join(dir, 'dlt-run.cmd')
    await fsp.writeFile(scriptPath, buildMsvcScript(env, realProgram, realArgs), 'utf8')
    realProgram = 'C:\\Windows\\System32\\cmd.exe'
    realArgs = ['/d', '/s', '/c', scriptPath]
    useShell = false
  } else if (env.kind === 'com') {
    throw new Error(`环境 "${envId}" 是 COM 桥，请用 officeConvert() 而不是 runInEnvironment()`)
  }

  const command = [realProgram, ...realArgs].map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(' ')

  return await new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(realProgram, realArgs, {
        cwd,
        windowsHide: true,
        shell: useShell,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...extraEnv },
      })
    } catch (error) {
      resolvePromise({ ok: false, exitCode: null, stdout: '', stderr: String(error.message || error), ms: 0, command, truncated: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let killed = false
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        killed = true
        // Windows 上 child.kill 不保证杀掉孙进程（cmd → cl），用 taskkill 杀整棵树
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        } catch { /* ignore */ }
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, timeoutMs)
      : null

    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ ok: false, exitCode: null, stdout, stderr: stderr + String(error.message || error), ms: Date.now() - started, command, truncated: false })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const outCap = cap(stdout, maxOutput)
      const errCap = cap(stderr, maxOutput)
      resolvePromise({
        ok: !killed && code === 0,
        exitCode: code,
        stdout: outCap.text,
        stderr: killed ? `（超时 ${timeoutMs}ms 被终止）\n${errCap.text}` : errCap.text,
        ms: Date.now() - started,
        command,
        truncated: outCap.truncated || errCap.truncated,
      })
    })

    if (stdin !== null && stdin !== undefined) {
      child.stdin?.end(String(stdin))
    } else {
      child.stdin?.end()
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 文档引擎桥（第 3 项）
// ═══════════════════════════════════════════════════════════════════════════

export async function runDocumentOp(op, args, options = {}) {
  const envId = options.pythonEnv || 'python312'
  const engine = options.engine || PY_ENGINE
  if (!existsSync(engine)) throw new Error(`文档引擎不存在: ${engine}`)
  const res = await runInEnvironment({
    env: envId,
    program: undefined,
    args: [engine],
    stdin: JSON.stringify({ op, args: args || {} }),
    timeoutMs: options.timeoutMs ?? 300000,
    cwd: options.cwd || PACKAGE_ROOT,
    maxOutput: options.maxOutput ?? 4 * 1024 * 1024,
  })
  const line = res.stdout.trim().split('\n').filter(Boolean).pop()
  if (!line) {
    throw new Error(`文档引擎无输出（退出码 ${res.exitCode}）: ${res.stderr.slice(0, 600)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error(`文档引擎输出不是 JSON: ${line.slice(0, 300)}`)
  }
  if (!parsed.ok) throw new Error(parsed.error || '文档操作失败')
  return parsed.data
}

/**
 * docx / xlsx → PDF。
 *
 * 首选 Python + pywin32 的 `DispatchEx`：它强制新开一个**独立**的 Office 进程，
 * 因此 (a) 绝不碰用户正开着的 Word/Excel，(b) 走 IDispatch 不需要 PIA 类型库
 * （PowerShell 的 New-Object -ComObject 依赖类型库，在部分安装上会
 * TYPE_E_CANTLOADLIBRARY）。两条路都失败才报错，并把两个原因都带出来。
 */
export async function officeConvert(options) {
  const { kind, source, target, range = '' } = options || {}
  if (!['docx', 'xlsx'].includes(kind)) throw new Error(`officeConvert 只支持 docx/xlsx，收到 ${kind}`)
  const reasons = []

  try {
    const data = await runDocumentOp('convert', { path: source, to: 'pdf', out: target, range }, { timeoutMs: 240000 })
    return {
      kind,
      source,
      path: data.path || target,
      bytes: data.bytes ?? 0,
      ms: null,
      engine: data.engine || 'pywin32',
      attached: false,
    }
  } catch (error) {
    reasons.push(`pywin32 路线失败：${error && error.message ? error.message : error}`)
  }

  try {
    const res = await runInEnvironment({
      env: 'windows-powershell',
      program: undefined,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OFFICE_BRIDGE,
        '-Kind', kind, '-Source', source, '-Target', target, ...(range ? ['-Range', range] : [])],
      timeoutMs: 240000,
      cwd: PACKAGE_ROOT,
    })
    const line = res.stdout.trim().split('\n').filter(Boolean).pop()
    if (!line) throw new Error(`Office 桥无输出（退出码 ${res.exitCode}）: ${res.stderr.slice(0, 400)}`)
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`Office 桥输出不是 JSON: ${line.slice(0, 300)}`)
    }
    if (!parsed.ok) throw new Error(parsed.error || 'Office 转换失败')
    return { ...parsed.data, engine: 'powershell-com' }
  } catch (error) {
    reasons.push(`PowerShell COM 桥失败：${error && error.message ? error.message : error}`)
  }

  throw new Error(`Office 转换失败（两种引擎都不行）：\n  - ${reasons.join('\n  - ')}`)
}

/** HTML → PDF（Edge 无头打印）。 */
export async function htmlToPdf({ source, target, timeoutMs = 120000 }) {
  const edge = resolveEnvironment('edge-headless').program
  if (!existsSync(edge)) throw new Error(`未找到 Edge: ${edge}`)
  const profile = await fsp.mkdtemp(join(os.tmpdir(), 'dlt-edge-'))
  const url = 'file:///' + source.replace(/\\/g, '/').replace(/^\/+/, '')
  const res = await runInEnvironment({
    env: 'cmd',
    program: edge,
    args: [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${target}`,
      url,
    ],
    timeoutMs,
  }).catch((error) => ({ ok: false, stderr: String(error.message || error), stdout: '', exitCode: null }))

  // Edge 的 --print-to-pdf 有时退出码非 0 但文件已写出，故以文件为准。
  if (!existsSync(target)) {
    throw new Error(`Edge 打印未生成 PDF: ${(res.stderr || '').slice(0, 400)}`)
  }
  const stat = await fsp.stat(target)
  return { path: target, bytes: stat.size, source, ms: res.ms ?? null }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. 定价：抓官网中文页 → 解析 → 本地缓存（第 1 项）
// ═══════════════════════════════════════════════════════════════════════════

export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/** 旧模型名 / 别名 → 计费模型。官网明确：v4-flash 与 vision-exp 已下线，按 Flash 计费。 */
export const MODEL_ALIASES = {
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash-expires-on-0910': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-pro': 'deepseek-v4-pro',
}

/**
 * 把一个路由上的 model 名解析到计费模型。
 * 先查别名表；查不到再按包含关系猜测（pro 系列 → pro，其余 → flash），保证不会因为
 * 官网上了新名字就完全算不出成本。
 */
export function billingModelFor(model) {
  const raw = String(model || '').trim().toLowerCase()
  if (raw === '') return null
  if (MODEL_ALIASES[raw]) return MODEL_ALIASES[raw]
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  if (MODEL_ALIASES[bare]) return MODEL_ALIASES[bare]
  if (/(^|[-_.])pro([-_.]|$)/.test(bare)) return 'deepseek-v4-pro'
  if (bare.includes('flash')) return 'deepseek-flash'
  return null
}

/** 把官网页面 HTML 压成「每行一个单元格文本」，降低解析对结构的依赖。 */
export function flattenHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(td|th|tr|div|p|li|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

const NUM_RE = /([0-9]+(?:\.[0-9]+)?)\s*元/g

const METRIC_MATCHERS = [
  { key: 'cacheHit', test: (line) => line.includes('缓存命中') && !line.includes('未命中') },
  { key: 'cacheMiss', test: (line) => line.includes('缓存未命中') },
  { key: 'output', test: (line) => line.includes('百万tokens输出') },
]

/**
 * 逐行扫描价格表。官网是 Docusaurus 渲染的 HTML 表格，把每个 </td> 折成一行之后，
 * 结构是：<指标行> → (空闲时段 | 高峰时段) → 每行一个「N元」。
 * 状态机比正则跨行匹配稳，且行序变了也只会报「解析失败」而不是静默算错。
 */
function parsePricingRows(lines, modelCount) {
  const metrics = { cacheHit: { off: [], peak: [] }, cacheMiss: { off: [], peak: [] }, output: { off: [], peak: [] } }
  let current = null
  let band = null

  for (const line of lines) {
    const metric = METRIC_MATCHERS.find((m) => m.test(line))
    if (metric) {
      current = metric.key
      band = null
      continue
    }
    if (current === null) continue
    if (line.includes('空闲时段')) { band = 'off'; continue }
    if (line.includes('高峰时段')) { band = 'peak'; continue }
    if (band !== null) {
      const found = line.match(NUM_RE)
      if (found) {
        metrics[current][band].push(...found.map((x) => Number(x.replace(/[^0-9.]/g, ''))))
        continue
      }
    }
    if (line.includes('并发限制') || line.includes('扣减费用')) {
      current = null
      band = null
    }
  }

  const invalid = []
  for (const [key, bands] of Object.entries(metrics)) {
    for (const b of ['off', 'peak']) {
      if (bands[b].length < modelCount) invalid.push(`${key}.${b}(得到 ${bands[b].length}/${modelCount})`)
    }
  }
  if (invalid.length) {
    throw new Error(`定价页解析失败：${invalid.join('、')}。页面结构可能已变动，请检查 ${PRICING_URL}`)
  }
  return metrics
}

/**
 * 从官网中文定价页解析出单价表。
 * 列顺序为 [deepseek-flash, deepseek-v4-pro]，行顺序为
 * 缓存命中(空闲/高峰) → 缓存未命中(空闲/高峰) → 输出(空闲/高峰)。
 */
export function parsePricing(html, meta = {}) {
  const lines = flattenHtml(html)
  const text = lines.join('\n')

  const modelIds = []
  for (const candidate of ['deepseek-flash', 'deepseek-v4-pro']) {
    if (text.includes(candidate)) modelIds.push(candidate)
  }
  if (modelIds.length < 2) {
    throw new Error('定价页解析失败：未找到模型列（deepseek-flash / deepseek-v4-pro）')
  }

  const rows = parsePricingRows(lines, modelIds.length)

  const models = {}
  modelIds.forEach((model, i) => {
    models[model] = {
      cacheHit: { off: rows.cacheHit.off[i], peak: rows.cacheHit.peak[i] },
      cacheMiss: { off: rows.cacheMiss.off[i], peak: rows.cacheMiss.peak[i] },
      output: { off: rows.output.off[i], peak: rows.output.peak[i] },
      unit: 'CNY / 1M tokens',
    }
  })

  return {
    currency: 'CNY',
    unit: '元 / 百万 tokens',
    source: meta.url || PRICING_URL,
    fetchedAt: meta.fetchedAt || new Date().toISOString(),
    modelIds,
    models,
    peakRule: '北京时间周一至周五 9:00-12:00 与 14:00-18:00 为高峰档；其余为空闲档（空闲价为高峰价的一半）。',
    note: meta.note || '单价来自 DeepSeek 官方定价页（中文），仅用于本地估算，实际扣费以平台账单为准。',
  }
}

/** 判断某个时刻是否处于高峰档（北京时间 = UTC+8，无夏令时）。 */
export function peakBand(at = Date.now()) {
  const beijing = new Date(new Date(at).getTime() + 8 * 3600 * 1000)
  const day = beijing.getUTCDay() // 0=周日
  if (day === 0 || day === 6) return false
  const hour = beijing.getUTCHours() + beijing.getUTCMinutes() / 60
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

export function cachePath(cacheDir) {
  return join(cacheDir || join(dshHome(), 'dlt'), 'pricing.json')
}

/** 读取本地定价快照（离线可用）。 */
export async function readPricingCache(cacheDir) {
  try {
    const raw = await fsp.readFile(cachePath(cacheDir), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && parsed.models && parsed.modelIds) return parsed
  } catch { /* 无缓存 */ }
  return null
}

export async function writePricingCache(table, cacheDir) {
  const file = cachePath(cacheDir)
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(table, null, 2), 'utf8')
  return file
}

/**
 * 取定价表：优先新鲜缓存，其次抓官网，抓不到则退回旧缓存（并在结果里标注）。
 * @param {{cacheDir?:string, maxAgeMs?:number, force?:boolean, fetchImpl?:Function}} options
 */
export async function loadPricing(options = {}) {
  const { cacheDir, maxAgeMs = 24 * 3600 * 1000, force = false, fetchImpl } = options
  const cached = await readPricingCache(cacheDir)
  const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity
  if (cached && !force && age < maxAgeMs) {
    return { ...cached, stale: false, fromCache: true, ageMs: age }
  }
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') {
    if (cached) return { ...cached, stale: true, fromCache: true, ageMs: age, warning: '无 fetch，使用旧快照' }
    throw new Error('无法抓取定价页：当前运行环境没有 fetch')
  }
  try {
    const response = await doFetch(PRICING_URL, {
      headers: { 'user-agent': 'dsh-dlt/0.1 (+pricing snapshot)', accept: 'text/html' },
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const html = await response.text()
    const table = parsePricing(html, { url: PRICING_URL, fetchedAt: new Date().toISOString() })
    await writePricingCache(table, cacheDir)
    return { ...table, stale: false, fromCache: false, ageMs: 0 }
  } catch (error) {
    if (cached) {
      return { ...cached, stale: true, fromCache: true, ageMs: age, warning: `抓取失败，使用 ${new Date(cached.fetchedAt).toLocaleString('zh-CN')} 的快照：${error.message}` }
    }
    throw new Error(`抓取定价页失败且无本地快照：${error.message}`)
  }
}

/**
 * 给一轮对话的 token 用量算人民币。单价单位是「元 / 百万 tokens」。
 * @param {{uncachedInputTokens?:number, cacheReadTokens?:number, cacheWriteTokens?:number, outputTokens?:number}} usage
 * @param {{model?:string, routes?:Array<{provider:string,model:string}>, at?:number}} context
 */
export function priceUsage(usage, context = {}, table) {
  const u = usage || {}
  const uncached = Number(u.uncachedInputTokens || 0)
  const cacheHit = Number(u.cacheReadTokens || 0)
  const cacheWrite = Number(u.cacheWriteTokens || 0)
  const output = Number(u.outputTokens || 0)

  const routeModels = [...new Set((context.routes || []).map((r) => r.model).filter(Boolean))]
  const candidate = routeModels[0] || context.model || ''
  const billing = billingModelFor(candidate)
  const at = context.at || Date.now()
  const peak = peakBand(at)

  const result = {
    currency: (table && table.currency) || 'CNY',
    model: candidate || null,
    billingModel: billing,
    band: peak ? 'peak' : 'off',
    bandLabel: peak ? '高峰档' : '空闲档',
    at: new Date(at).toISOString(),
    tokens: { uncachedInput: uncached, cacheHitInput: cacheHit, cacheWriteInput: cacheWrite, output },
    cost: null,
    lines: [],
    warnings: [],
  }

  if (routeModels.length > 1) {
    result.warnings.push(`本轮经过多个模型路由（${routeModels.join(' / ')}），token 无法按路由拆分，按「${candidate}」近似计价。`)
  }

  if (billing && table && table.models && table.models[billing]) {
    const price = table.models[billing]
    const band = peak ? 'peak' : 'off'
    const perMillion = 1e6
    const lines = [
      { key: 'cacheHitInput', tokens: cacheHit, rate: price.cacheHit[band], label: '缓存命中输入' },
      { key: 'uncachedInput', tokens: uncached, rate: price.cacheMiss[band], label: '缓存未命中输入' },
      { key: 'output', tokens: output, rate: price.output[band], label: '输出' },
    ]
    let total = 0
    for (const line of lines) {
      const cost = (line.tokens / perMillion) * line.rate
      total += cost
      result.lines.push({ ...line, cost })
    }
    result.cost = total
    if (cacheWrite > 0) {
      result.warnings.push(`cacheWrite ${cacheWrite} tokens 未单独计价（官网未列出缓存写入档），已按未命中输入口径计入。`)
    }
  } else {
    result.warnings.push(billing
      ? `定价表中没有「${billing}」的单价。`
      : `无法把模型「${candidate || '未知'}」映射到计费模型，未计价。`)
  }
  return result
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. 文档格式判定（供工具层复用）
// ═══════════════════════════════════════════════════════════════════════════

export const DOC_EXTENSIONS = {
  pdf: ['.pdf'],
  docx: ['.docx', '.docm'],
  xlsx: ['.xlsx', '.xlsm'],
  csv: ['.csv'],
  html: ['.html', '.htm'],
}

export function docKindOf(path) {
  const ext = extname(String(path || '')).toLowerCase()
  for (const [kind, list] of Object.entries(DOC_EXTENSIONS)) {
    if (list.includes(ext)) return kind
  }
  if (ext === '.doc' || ext === '.xls') {
    throw new Error(`不支持旧版二进制格式 ${ext}，请先用 Office 另存为 .docx / .xlsx`)
  }
  throw new Error(`不支持的文档类型: ${ext || '(无扩展名)'}`)
}

export function shortPath(p) {
  const text = String(p || '')
  return text.length <= 68 ? text : '…' + text.slice(-64)
}

/**
 * 解析产品给的资源地址。
 *
 * 右栏文档预览传过来的是 `dsh-resource://file/session/<sessionId>/<path>`（或
 * `.../absolute/<绝对路径>`），其中的 path 可能是工作区相对路径 —— 所以要把
 * sessionId 与 path 一起取出来，让 Host 有机会用会话的 cwd 去补全。
 */
export function parseResourceAddress(input) {
  const text = String(input || '')
  const decode = (value) => {
    try { return decodeURIComponent(value) } catch { return value }
  }
  let match = /^dsh-resource:\/\/file\/session\/([^/]+)\/(.*)$/i.exec(text)
  if (match) return { sessionId: decode(match[1]), path: decode(match[2]), fromAddress: true }
  match = /^dsh-resource:\/\/file\/absolute\/(.*)$/i.exec(text)
  if (match) return { sessionId: null, path: decode(match[1]), fromAddress: true }
  match = /^dsh-resource:\/\/file\/(.*)$/i.exec(text)
  if (match) return { sessionId: null, path: decode(match[1]), fromAddress: true }
  return { sessionId: null, path: text, fromAddress: false }
}

export function isAbsolutePath(p) {
  const text = String(p || '')
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')
}

export { basename }
