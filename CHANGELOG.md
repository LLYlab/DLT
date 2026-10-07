# Changelog

## v1.3.0 — 草图（draft）；被 DET 全面接管时整体停摆

- **依赖对齐 DSH 0.2**：`@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-typert-protocol` 由 `^0.1.7-rc.2` 抬到 `^0.2.0-rc.2`。caret 在 0.x 上锁次版本，`^0.1.7-rc.2` 根本不含 0.2，不抬的话干净环境解析不到、插件管理也会判成不兼容；`@deepseek-ai/schemastery` 保持 `^3.18.1`（0.2 带的是 3.18.4，落在范围内）。代码本身无需适配 —— 0.2.0-rc.2 下 6 个测试文件全绿（core 28 / doc-engine 22 / host 29 / env-paths 12 / switch 7 / client-load），升级后的真实宿主里工具、端点、客户端槽也已实测可用。
- **新增第 7 个模块「草图导入」（`draft`）**：输入框「+」旁边多了一个小铅笔按钮（挂 `conversation.input.left`），点开是一块画布 —— 选颜色/线宽、撤销、清空，画完点「导入」：
  - 当前会话的模型**声明了图片输入**（`inputModalities` 含 `image`）→ 草图作为**图片附件**挂进输入框（`conversation.createDrafts` + `shell.addAttachments`），随消息一起发给视觉模型；
  - 否则（纯文本模型）→ 草图存成 PNG 并把**工作区相对路径**插进输入框文字（`.dsh-drafts/sketch-*.png`），切到视觉模型后模型可用 `read_image` 看它；
  - 判据由 Host 回答（新端点 **`draftSupport`**），客户端不猜 —— 免得「挂上去了、发送时才被宿主以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝」。两条路都会先调新端点 **`draftSave`** 把 PNG 落成真实文件（PNG 魔数校验 + 默认 `<会话工作区>/.dsh-drafts`，没有工作区时退到 `<DSH_HOME>/dlt/drafts`），所以草图总有一份可复用的实体。
  - 画布 960×600（57.6 万像素，落在视觉模型的图片像素预算内）；弹窗用 portal 挂到 `body`，不受输入框 `overflow` 裁切。
- **被 DET 全面接管时 DLT 整体停摆（新增「DET 全量接管」这一档声明）**：DET 的 `subordinateGrants()` 现在会回 `grants.dlt === true`，含义是「DET 已经把 DLT 的全部功能（六个 `dlt_*` 工具 / 系统提示 / 成本小签 / 右栏预览 / 草图）搬进自己」，于是 DLT：
  - **宿主侧**：`dlt_env` / `dlt_run` / `dlt_build` / `dlt_doc_read` / `dlt_doc_write` / `dlt_doc_convert` 与系统提示段落**一个都不注册**（否则两边会撞同名工具）；
  - **客户端**：成本小签、余额卡、草图按钮、右栏预览，连同**「DLT 管理器」设置页入口**一起撤下 —— DET 的「设置 → DET 管理器 → DLT 集成」成为唯一入口；
  - 判断放在启动时 + 每 **5 秒**复核一次（`det.subordinate` 关掉、DET 总开关关掉、DET 卸载，任一条发生都会让 DLT 立刻恢复自管，不用重启也不用刷新）；
  - 注册同名工具失败时**只跳过那一件并登记冲突**（不把整个插件带崩），配合 DET 侧的重试，启动瞬间的撞名窗口能自愈。
- **新增回归测试 `tests/client-load.test.mjs`（31 条）**：客户端半区此前零覆盖。这套在假 ModuleLoader + 假 `require` + 假 ctx 下真跑 `factory` 与 `apply(ctx)`，逐个场景核对「此刻到底挂着什么」：全开五块界面都在；`detTakeover=true` 时连设置页入口都不挂；只关 `draft` 时其余照旧；总开关关闭时只留管理端点。
- 全量测试：doc-engine **22/22** · core **28/28** · host **18/29**（11 条失败全部是本机 pwsh 沙箱不给子进程管道的 `spawn EPERM`，与代码无关；经 `dlt_run` 起的外层进程里跑则全绿）· switch **7/7** · env-paths **12/12** · client-load **31/31**。

## v1.1.0 — 环境表路径不再写死（自动探测 + 可配置覆盖）

- **环境表路径改为「解析」而不是硬编码。** `resolveEnvironment()` 按 ① `config.environments` 的显式覆盖 → ② 自动探测 → ③ 内置默认值 的顺序落地。探测手段：**VS 安装根扫描**（认「根下有 `VC\Auxiliary\Build\vcvarsall.bat`」的那个，覆盖 VS2017–VS18 × Community/Professional/Enterprise/BuildTools/Preview）、`%ProgramFiles%` / `%ProgramFiles(x86)%` / `%SystemRoot%` / `%LOCALAPPDATA%` 展开、常见安装位置，以及 **PATH 查找**（按 `PATHEXT` 补扩展名）。于是换一台机器基本不用动源码。
- **新增配置项 `environments`**：`{ [环境 id]: { program?, vcvars?, arch?, label?, vsRoot? } }`。不填也能用，只在「这台机器探测不准」或「就想指定某一个环境」时才需要。
- **修掉一个必然会踩的坑**：VS 系的 `vcvars` / `program` 现在由**探测到的安装根推导**。原先表里写死指向 VS18 的那条路径，在装了 VS2022 的机器上会被原样拿去 `call` —— 探测到了新版本反而没用。另外**显式覆盖永远优先，即使那条路径并不存在**：这样报错会直接指出你给的那条路径，而不是被探测结果悄悄顶掉。
- **`dlt_env` 的可用性判断**改用同一套解析结果，覆盖之后如实标 `missing`，不掩盖。
- **新增回归测试 `tests/env-paths.test.mjs`（12 条）**：环境 id 集合稳定（18 个）；默认全部解析到真实存在的路径；覆盖 `program` / `vsRoot` / `arch` / `label` 均生效且 `describeEnvironments` 如实反映；覆盖一条不存在的「幽灵路径」不会被探测结果顶掉；清除覆盖后恢复 18/18 可用；非法配置值（`null` / 数组 / 字符串 / 数字）不炸；未知环境 id 仍报清晰错误。
- 全量测试：doc-engine **22/22** · core **28/28** · host **29/29** · switch **7/7** · env-paths **12/12**。

## v1.0.0 — 可安装的 bundle（manifest 完整化）

- **新增 `dsh.bundle.patch`**：`package.json` 的 `dsh` 节除 `client` 外，现在声明
  `bundle.patch → ./cordis.patch.yml`，并在仓库根补上了对应的 `cordis.patch.yml`。
  在此之前 DLT 只声明 `dsh.client`，而**单有 `dsh.client` 并不构成可安装的 bundle**：
  `dsh plugin add` 装不上，各插件收录库的静态校验也会直接判 `invalid`
  —— 中心 Registry 的 `rejected.json` 里 DLT 的理由正是
  `package.json does not declare a safe dsh.bundle.patch`。
- **一条命令安装**：`dsh plugin --profile web add dsh-light-tool` 或
  `dsh plugin --profile web add github:LLYlab/DLT`。装完自动并入当前 profile 的 bundle 层，
  **不再需要手工往 `cordis.patch.yml` 里插 `insert` 块**。
- **README**：补 GitHub 安装方式、钉 commit 的写法，以及「按 id 覆盖 config（整块替换）」的说明。
- `cordis.patch.yml` 里的 `config` 只作为**首次运行的默认值**；运行期开关仍以
  `<DSH_HOME>/dlt/switch.json` 为准（见 v0.2.0），patch 不会覆盖 UI 上的选择。
- **功能无变化**：六个模块与 v0.2.0 完全一致，本次是打包／安装契约的修复。

## v0.2.0 — 运行期总开关（设置 → DLT 管理器）

- **新增「DLT 管理器」设置页**：一个**总开关** + 六个**分模块开关**（每轮成本 / 账户余额 / 文档工具 / 右栏预览 / 环境表 / 执行与编译）。开关**即时生效、持久化、无需重启**。
- **总开关关闭**：卸下全部 6 个模型工具（`dlt_env` / `dlt_run` / `dlt_build` / `dlt_doc_read` / `dlt_doc_write` / `dlt_doc_convert`）与系统提示注入；界面上的成本小签、余额卡、右栏 `docx`/`xlsx`/`csv` 预览当场撤下；端点对调用返回 `{ok:false, disabled:true}`（`status` 仍可读，但不再联网抓定价）。
- **持久化**：状态写在 `<DSH_HOME>/dlt/switch.json`（纯 JSON，可手改；缺失或损坏时退回 `cordis.patch.yml` 的 `config` 默认值，并在设置页显示原因）。`config` 里的开关自此只作为**首次运行的默认值**，UI 上的选择不会被 patch 覆盖。
- **系统提示随开关生成**：关掉某模块后，提示里不再教模型调用已经关掉的工具。
- **测试**：新增 `tests/switch.test.mjs`（开关持久层，7 条）；`tests/host.test.mjs` 增加运行期开关 6 条（合计 29 条）。

## v0.1.0 — 首个版本

- 六个模块：**每轮人民币成本**（复用 `dsh-token-meter` 的 turn-usage 折叠，单价取官网定价页的峰值/错峰六档）、**DeepSeek 账户余额**（经凭据 seam 解析 key，key 只进请求头）、**PDF/Word/Excel/CSV 直接读写工具**（Python 引擎：pymupdf / pypdf / python-docx / openpyxl / pdf2docx / pywin32）、**右栏 docx/xlsx/csv 预览**、**硬编码编译运行环境表**（MSVC / MSBuild / cmake / ninja / Python / Node / git / dotnet / Office COM / Edge）、**直接执行与编译工具**（`dlt_run` / `dlt_build`）。
- 安全默认：所有写操作先备份（同目录 `.bak-YYYYmmdd-HHMMSS.<ext>`）；Office COM 用 `DispatchEx` 起**独立**进程，绝不依附用户正在使用的 Word / Excel。
