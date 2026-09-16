# Changelog

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
