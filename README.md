# DLT — DeepSeek Light Tool

[![npm](https://img.shields.io/npm/v/dsh-light-tool.svg)](https://www.npmjs.com/package/dsh-light-tool) [![license](https://img.shields.io/npm/l/dsh-light-tool.svg)](LICENSE)

DSH（DeepSeek Harness）的**永久插件**。装一次，重启后常驻，出现在「设置 → 插件清单」。

- npm：**`dsh-light-tool`** → <https://www.npmjs.com/package/dsh-light-tool>
- 仓库：<https://github.com/LLYlab/DLT>

七个模块，每个都能在设置页或配置里单独关掉（见「运行期开关」）：

| # | 模块 | 做什么 |
|---|---|---|
| 1 | 人民币成本 | 每轮对话结束，在用量胶囊旁边显示这一轮花了多少元（可点开看 token 明细与会话累计） |
| 2 | 账户余额 | 右下角常驻显示 DeepSeek 账户余额，可拖动、可点击强制刷新 |
| 3 | 文档工具 | 让模型**直接读写** PDF / Word / Excel / CSV，不用再写脚本；PDF 支持「转 Word 改完转回来」的往返链 |
| 4 | 右栏预览 | 点工作区里的 `.docx` / `.xlsx` / `.csv`，右栏直接看（PDF 由产品自带渲染器负责） |
| 5 | 环境表 | 把「怎么进这条工具链」写清楚（VS 安装根 / Python / Office / Edge 等**自动探测**，可配置覆盖），并注入系统提示，模型不再自己探测 |
| 6 | 直接执行 | `dlt_run` / `dlt_build`：按环境名直接跑程序、编译工程，不用拼 vcvarsall 命令行 |
| 7 | 草图导入 | 输入框「+」旁的**小铅笔按钮**：现画一张草图，模型能看图就当**图片附件**挂进输入框，否则存成 PNG 并把工作区相对路径插进输入框文字 |

> 装 DET（`dsh-essential-tools` v2.9.0+）时，DET 会把上面这七件事**全部搬进自己**并声明
> 「已全量接管」：此时 DLT **整体停摆** —— 六个 `dlt_*` 工具与系统提示都不注册，界面
> （成本小签 / 余额卡 / 草图按钮 / 右栏预览）连同**本设置页入口**一起撤下，入口统一到
> 「设置 → DET 管理器 → DLT 集成」。想让 DLT 自己回来：关掉 DET 的总开关，或把
> `det.subordinate` 里的 `dlt` 设为 `false`（DLT 每 5 秒复核一次，无需重启）。

---

## 安装（已经装好的话跳过）

DLT 在 `package.json` 里声明了 **`dsh.bundle.patch`**（→ [`cordis.patch.yml`](./cordis.patch.yml)），
所以装完会自动并进当前 profile 的 bundle 层，**不需要手工改 `cordis.patch.yml`**。

### 从 npm 装（推荐）

```powershell
dsh plugin --profile web add dsh-light-tool
```

### 从 GitHub 装

```powershell
dsh plugin --profile web add github:LLYlab/DLT
```

想钉住某个 commit（更稳，推荐）：`dsh plugin --profile web add github:LLYlab/DLT#<commit-sha>`。

两种装法都读包里的 bundle patch，装完**重启 DSH** 即常驻，出现在「设置 → 插件清单」。

### 改默认配置

要改默认值（比如 `dlt_build` 不传 target 时用的解决方案），在自己的 patch 层里按 **id** 覆盖：

```yaml
- id: dlt
  config:
    defaultSolution: 'C:\path\to\your.sln'
```

> ⚠️ 覆盖是**整块替换**，不是逐字段深合并——`config` 里要写全你想生效的键，
> 没写的会回到 schema 默认值（完整键表见下面「配置项」）。
> 也不要再 `insert` 一个同名 `dlt` 行，否则是重复的 Bundle ID。

> 文档引擎依赖本机 Python 3.12 与几个包，见文末「依赖」；Office COM / Edge 用本机已装的程序。

### 从源码挂载（本机开发用）

源码：`C:\Users\L2959\.dsh\plugins\dlt`
挂载：给包建自己的 node_modules → junction 到 profile 的 node_modules → 在 patch 层插一行。

**第 0 步（最容易漏）**：DSH 按 Node 规则从插件的**真实路径**解析裸包名，而真实路径在 `plugins\` 下，
祖先目录里没有 `@deepseek-ai`。所以插件包必须自带一份 `node_modules`（`dbs`/`topo` 包里也有），
用 junction 指向 profile 里已装的同一版本，版本天然一致、且是同一个真实文件：

```powershell
$pkg = 'C:\Users\L2959\.dsh\plugins\dlt\node_modules\@deepseek-ai'
$pro = 'C:\Users\L2959\.dsh\profiles\node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
foreach ($n in 'schemastery','dsh-typert-protocol','dsh-tools','dsh-llm','dsh-util-values','cordis','cosmokit','dsh-token-meter') {
  New-Item -ItemType Junction -Path (Join-Path $pkg $n) -Target (Join-Path $pro $n)
}
```

**第 1 步**：让 profile 能解析到 dlt 包

```powershell
New-Item -ItemType Junction -Path "C:\Users\L2959\.dsh\profiles\node_modules\dsh-light-tool" `
         -Target "C:\Users\L2959\.dsh\plugins\dlt"
```

**第 2 步**：`C:\Users\L2959\.dsh\profiles\web\cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dlt
      name: 'dsh-light-tool'
      config:
        defaultSolution: 'C:\path\to\your.sln'   # dlt_build 不传 target 时用它
```

**第 3 步**：**重启 DSH**（Host 与新的 Client bundle 都在启动时装载；组合里挂载的永久插件不需要 GUI 批准，那是动态插件 `cordis_run` 的流程）。

一步验证装载是否成功（不需要重启，用假服务把插件跑起来）：

```powershell
cd C:\Users\L2959\.dsh\profiles\web
node C:\Users\L2959\.dsh\plugins\dlt\tests\host.test.mjs
```

## 运行期开关（设置 → DLT 管理器）

设置里有一页 **DLT 管理器**：一个**总开关** + 六个**分模块开关**（每轮成本 / 账户余额 / 文档工具 / 右栏预览 / 环境表 / 执行与编译）。

- **即时生效**：改完立刻装卸 —— 总开关关掉，DLT 的 6 个模型工具（`dlt_env` / `dlt_run` / `dlt_build` / `dlt_doc_read` / `dlt_doc_write` / `dlt_doc_convert`）与系统提示注入当场卸下，界面上的成本小签、余额卡、右栏预览当场撤下；端点对调用返回 `{ok:false, disabled:true}`（`status` 仍可用，但不再联网抓定价）。**不用改 yml、不用重启。**
- **持久化**：状态写在 **`<DSH_HOME>/dlt/switch.json`**（默认 `C:\Users\L2959\.dsh\dlt\switch.json`），重启后照旧；文件坏了/缺失就退回下面的 `config` 默认值并把原因显示在设置页里。
- **总开关关掉后**，设置页里那个总开关仍然在 —— 它是把 DLT 重新打开的唯一入口。
- 端点：`switchGet`（读开关状态）· `switchSet({enabled?, modules?})`（局部改开关）。

> 与 `cordis.patch.yml` 的关系：patch 里的 `config` 只提供**首次运行**的默认值；一旦在设置页动过开关，就以 `switch.json` 为准（UI 上的选择不会被 patch 覆盖）。

## 配置项（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | **总开关默认值**（只影响没有 `switch.json` 时；运行期开关见上一节） |
| `cost` / `balance` / `documents` / `preview` / `environment` / `run` | `true` | 六个模块的开关默认值（同上） |
| `pythonEnv` | `python312` | 文档引擎用的解释器（见环境表） |
| `environments` | `{}` | 环境表路径覆盖：`{ [环境 id]: { program?, vcvars?, arch?, label?, vsRoot? } }`。**不填就能用** —— 解析顺序见文末实现要点 10 |
| `cacheDir` | `<DSH_HOME>/dlt` | 定价与余额快照目录 |
| `pricingMaxAgeMs` | `86400000` | 定价快照最长使用时间，超过就重抓官网 |
| `balanceApiBase` | `https://api.deepseek.com` | 余额接口基址 |
| `balanceApiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用名（先走凭据 seam，再退回同名环境变量） |
| `balanceCacheMs` | `60000` | 余额缓存时长，浏览器按这个节奏轮询 |
| `docTimeoutMs` / `runTimeoutMs` | `300000` / `120000` | 默认超时 |
| `maxOutputBytes` | `262144` | 单次执行捕获的输出上限（超出保留首尾） |
| `promptSection` | `true` | 是否把环境表注入系统提示 |
| `defaultSolution` | 空 | `dlt_build` 的默认解决方案 |
| `defaultConfiguration` / `defaultPlatform` | `Debug` / `x64` | `dlt_build` 默认值 |

## 模型工具

- **`dlt_env`** — 看环境表（`env=<id>` 看细节）。路径会**自动探测**（VS 安装根扫描 / `%ProgramFiles%` / `%SystemRoot%` / PATH 查找），探测不到才退回内置默认值；要指定就配 `environments`（见「配置项」）。
- **`dlt_run(env, program, args, cwd, timeoutMs, stdin)`** — 在指定环境里执行程序，回 stdout/stderr/退出码。`env=msvc-x64` 会先注入 vcvarsall，于是 `cl`/`link` 直接可用。
- **`dlt_build(target?, configuration?, platform?, rebuild?)`** — MSBuild 一条龙。
- **`dlt_doc_read(path, mode?, pages?, sheets?, range?, formulas?, maxRows?)`** — 读 PDF（逐页文本）/ Word（段落+表格）/ Excel（各表行列）/ CSV。
- **`dlt_doc_write(path, action?, ops?, spec?, out?, chain?, replacements?)`** — 改或建文档。
  - PDF `ops`：`delete_pages` / `extract` / `rotate` / `merge` / `insert_pdf` / `watermark` / `replace_text` / `set_metadata`
  - Word `ops`：`replace_text` / `set_paragraph` / `add_paragraph` / `delete_paragraph` / `add_table` / `set_cell` / `add_table_row`
  - Excel `ops`：`set_cell` / `set_range` / `append_row` / `insert_row` / `delete_row` / `add_sheet` / `rename_sheet` / `delete_sheet` / `set_number_format` / `set_column_width` / `set_style`
  - PDF `chain=word`：PDF →(pdf2docx)→ docx →(用 Word op 改)→ PDF（Word COM）
  - PDF `chain=html`：PDF →(pymupdf)→ HTML →(文本替换)→ PDF（Edge 无头打印）
- **`dlt_doc_convert(path, to, ...)`** — `to=docx|html`（从 PDF）、`to=pdf`（从 Word/Excel/HTML）、`to=png`（PDF 某页出图，之后用 `read_image` 看）。

**写操作一律先备份**（同目录 `.bak-YYYYmmdd-HHMMSS.<ext>`）；`chain` 往返链会额外备份原 PDF。

## 端点（供右栏 UI 调用）

`connection.rpc.call('/api', 'dlt/<method>', { args: { args } })`：

`status` · `balance` · `cost({sessionId})` · `office({path})` · `pricingInfo({force})` · `envs` · `switchGet` · `switchSet({enabled?, modules?})`

## 依赖（本机已装，换机器需重装）

Python **3.12**（`C:\Users\L2959\AppData\Local\Programs\Python\Python312\python.exe`）：

```
pip install pymupdf pypdf python-docx openpyxl pdf2docx pywin32
```

> 国内网络下 `pdf2docx` 会拖 opencv（约 40MB）而反复卡住，用镜像快很多：
> `pip install -i https://pypi.tuna.tsinghua.edu.cn/simple pdf2docx`
>
> 另外 **pdf2docx 缺失时 PDF→Word 不会失败**：引擎会退回内置实现
> （pymupdf 取文本块/表格 + python-docx 落盘），保真度略低但「PDF → 改字 → 转回 PDF」照样能跑。

Office（Word/Excel COM 导出 PDF）与 Edge（HTML→PDF）都用本机已装的程序。

## 测试

五套，全部可重复运行：

```powershell
# 1) 文档引擎（Python CLI 层：创建/读取/编辑/渲染/转换/往返链）
node C:\Users\L2959\.dsh\plugins\dlt\tests\doc-engine.test.mjs

# 2) 核心层（环境表 / 定价抓取解析 / 高峰判定 / 成本计算 / MSVC 真编译 / Office COM / Edge）
node C:\Users\L2959\.dsh\plugins\dlt\tests\core.test.mjs

# 3) Host 半区（真 Cordis Context 装载插件，调它注册的工具与端点 + 运行期开关）
cd C:\Users\L2959\.dsh\profiles\web
node C:\Users\L2959\.dsh\plugins\dlt\tests\host.test.mjs

# 4) 开关持久层（纯 Node，不用起 Cordis：默认值 / 合并 / 落盘读回 / 文件损坏降级）
node C:\Users\L2959\.dsh\plugins\dlt\tests\switch.test.mjs

# 5) 环境表路径解析（纯 Node：默认解析 / config 覆盖 / VS 安装根推导 / 覆盖清除）
node C:\Users\L2959\.dsh\plugins\dlt\tests\env-paths.test.mjs
```

第 3 套**必须从 profile 目录运行**：ESM 按导入方的真实路径解析裸包名，只有从 profile 里
`import('dsh-light-tool')` 才能用上 junction；而且它会真起 `cl.exe` / Office COM / 联网抓价，
**别在受限沙箱里跑**（子进程管道会被拦，报 `spawn EPERM`）。

当前状态：doc-engine **22/22**，core **28/28**，host **29/29**（含运行期开关 6 条），switch **7/7**，env-paths **12/12**。

覆盖到的关键断言：flash/pro 六档单价与官网一致；高峰/空闲 9 个时间边界；
1M 未命中 + 1M 输出 @ 空闲恰好 5 元；旧模型名映射到 flash；未结算轮次不编造数据；
MSVC 真正编译出 exe 并运行；超时能杀掉进程树；PDF↔Word 与 PDF↔HTML 两条往返链的文本可验证；
环境表 18 个环境全部解析到真实存在的路径，且 `config.environments` 的覆盖（只给 `vsRoot` 时
`vcvars` 与 MSBuild 路径会一起跟着走）与清除都成立。

---

## 实现要点与踩过的坑（改代码前请先读）

1. **工具不能直接回图片块。** `ImageBlock` 需要 attachment 服务托管字节，且当前适配器声明为纯文本输出。所以 `dlt_doc_convert to=png` 是**写文件 + 返回路径**，再由模型调 `read_image` 去看。
2. **PowerShell 只有 5.1，且它按「无 BOM 就 ANSI」解码脚本。** `py/dlt_office.ps1` 必须保存为**带 BOM 的 UTF-8**，否则中文注释会撑坏语法。改这个文件后务必确认前 3 字节是 `EF BB BF`。
3. **Office COM 必须用 pywin32 的 `DispatchEx`，不要用 PowerShell 的 `New-Object -ComObject`。** 后者依赖 Office PIA 类型库，本机会 `TYPE_E_CANTLOADLIBRARY (0x80029C4A)`；`DispatchEx` 走 IDispatch，并且强制新开**独立**进程 —— 这条更重要：**依附用户正在用的 Word/Excel 会改到用户的东西**。早期版本依附时设置了 `Visible=$false`，直接把用户开着的 Word 窗口藏掉了。现在的口径是：只碰自己新建的实例；`app.Quit()` 之后还会按「转换前后新增的 PID」做一次兜底清理，绝不碰别人的进程。
4. **成本数据复用了产品自己的折叠逻辑。** Host 用 `ctx.sessionQuery.readSession(id)` 取原始事件，按 `turn/start…turn/end` 分组，再把这些事件交给 **dsh-token-meter 自带的 `deriveTurnTokenUsage`**（按文件 URL 动态 import）折叠 —— 这样算出来的 token 与 UI 用量胶囊完全一致，不会因为自己重写解析而对不上。取不到就整轮不显示，不猜。
5. **高峰/空闲按「请求时刻」判定**（北京时间 周一至周五 9:00–12:00、14:00–18:00），单价来自官网中文定价页，本地缓存每天刷新，抓不到就用旧快照并在 UI 上标注。
6. **旧模型名会映射到计费模型**：官网明确 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 已下线、由 V4.1-Flash 服务并按 Flash 计费，所以别名表把它们都映射到 `deepseek-flash`。
7. **`cacheWrite` 不单独计价**（官网没有缓存写入档），只报数并提示已按未命中输入口径计入。
8. **`formulas=false` 读 Excel 缓存值**时，若文件是由 openpyxl 生成且从未被 Excel 打开过，公式单元格会返回 `null` —— 这是 openpyxl 的既有行为，不是 bug。
9. **中文水印会嵌入约 1.7MB 的 CJK 字体**，所以水印字体按内容选择：纯 ASCII 用内置 `helv`，含中文才用 `china-s`。
10. **环境表的路径是「解析」出来的，不是照抄表里的值。** `resolveEnvironment()` 按 ① `config.environments` 的显式覆盖 → ② 自动探测（VS 安装根扫描 / `%ProgramFiles%` / `%SystemRoot%` / `%LOCALAPPDATA%` 展开 / PATH 查找）→ ③ `ENVIRONMENTS` 里那条默认值 的顺序落地。两个容易写错的地方：**(a) VS 系的 `vcvars`/`program` 必须由探测到的安装根推导**，不能沿用表里写死的 VS18 —— 否则在装了 VS2022 的机器上会拿着一条指向 VS18 的路径去 call；**(b) 显式覆盖永远优先，哪怕那条路径并不存在**，这样报错会直接指出用户给的那条路径，而不是被探测结果悄悄顶掉。`msvc` 类环境执行时会自动生成一个临时 `.cmd`（`chcp 65001` + `call vcvarsall`）来注入环境，避免命令行转义地狱。
11. **相对路径按会话工作区解析。** 工具通过 `exec.agent.session.meta.cwd` 拿到当前会话的工作区根，所以模型写 `docs/a.docx` 能命中；预览端点则从 `dsh-resource://file/session/<sessionId>/<path>` 地址里取出 sessionId 再反查 cwd。绝对路径原样使用，没有会话信息才退回进程 cwd。
12. **`dsh-token-meter` 不是 dlt 的依赖，是动态解析的。** 依次尝试：直接当包解析 → **从 `@deepseek-ai/cordis` 的位置推出同层的 `dsh-token-meter`** → `createRequire`。第二条是关键：它不依赖 dlt 自己的依赖声明，而且解析到的是同一个真实文件（Node 按 realpath 缓存模块），所以不会出现「两份 token-meter、两份状态」。
13. **`ctx.plugin()` 返回的是 Fiber，不是 thenable。** `await ctx.plugin(...)` 不会等激活，必须 `await fiber.await()`；写测试时容易在这里踩空（表现为「插件好像没加载」）。同理 `ctx.get()` 返回的是 `getTraceable` 包过的代理，**不要用 `===` 比较身份**。
14. **运行期开关为什么落 JSON 文件，而不是宿主的 storage 域**：DLT 的 `node_modules/@deepseek-ai` 是 8 个 junction（只链它真正 import 的包），里面没有 `dsh-storage-domain`；而且 storage 域用 zod schema，DLT 这边是 schemastery。所以开关落 `<DSH_HOME>/dlt/switch.json`（与定价快照同目录）：纯 Node 读写、坏了/缺了都能降级回 `config` 默认值，用户也能手改。
15. **关总开关必须真的把工具卸下来。** `dsh-tools` 的 `tools.register(def)` 返回 disposer（内部走 `ctx.effect`），`dsh-system-prompt` 的 `section(...)` 同理。所以 `DltService.applyRuntime()` 逐个登记这些 disposer、`unloadRuntime()` 逐个撤下；不撤的话模型依然看得见 `dlt_run` 等工具（只是调用会失败），那就是「关了没关干净」。改了开关还要顺带改系统提示：提示里不能再教模型去调已经关掉的工具。

## 文件

```
plugins/dlt/
  package.json          # main=lib/index.js, exports ./client, dsh.client.platform=web
  CHANGELOG.md          # 版本变更（随 npm 包分发，也是 GitHub Release 的说明）
  LICENSE               # MIT
  publish.ps1           # 一键发布（升版本 → commit/tag → push → npm publish → gh release）
  lib/index.js          # Host 半区（Cordis 插件：工具 + typert 端点 + 系统提示段 + 运行期开关）
  lib/core.js           # 纯逻辑：环境表 / 定价抓取解析 / 成本计算 / 进程执行器 / Office 桥
  lib/switch.js         # 运行期开关的持久层（<DSH_HOME>/dlt/switch.json）
  lib/client.js         # Client 半区（ModuleLoader bundle：成本小签 / 余额 / 文档预览 / DLT 管理器设置页）
  py/dlt_docs.py        # 文档引擎（pymupdf / pypdf / python-docx / openpyxl / pdf2docx / pywin32）
  py/dlt_office.ps1     # Office COM 兜底桥（带 BOM 的 UTF-8！）
  tests/doc-engine.test.mjs   # 文档引擎回归测试
  tests/core.test.mjs         # 核心层回归测试（含真编译、真抓价）
  tests/host.test.mjs         # Host 半区回归测试（真 Cordis 上下文装载 + 运行期开关）
  tests/switch.test.mjs       # 开关持久层单测
  tests/env-paths.test.mjs    # 环境表路径解析单测（默认 / 覆盖 / VS 根推导 / 清除）
  node_modules/@deepseek-ai/* # 8 个 junction → profile 里同一版本的包（仅源码挂载方式需要，见安装第 0 步）
```
