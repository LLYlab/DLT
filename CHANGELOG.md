# Changelog

## v0.2.0 — 运行期总开关（设置 → DLT 管理器）

- **新增「DLT 管理器」设置页**：一个**总开关** + 六个**分模块开关**（每轮成本 / 账户余额 / 文档工具 / 右栏预览 / 环境表 / 执行与编译）。开关**即时生效、持久化、无需重启**。
- **总开关关闭**：卸下全部 6 个模型工具（`dlt_env` / `dlt_run` / `dlt_build` / `dlt_doc_read` / `dlt_doc_write` / `dlt_doc_convert`）与系统提示注入；界面上的成本小签、余额卡、右栏 `docx`/`xlsx`/`csv` 预览当场撤下；端点对调用返回 `{ok:false, disabled:true}`（`status` 仍可读，但不再联网抓定价）。
- **持久化**：状态写在 `<DSH_HOME>/dlt/switch.json`（纯 JSON，可手改；缺失或损坏时退回 `cordis.patch.yml` 的 `config` 默认值，并在设置页显示原因）。`config` 里的开关自此只作为**首次运行的默认值**，UI 上的选择不会被 patch 覆盖。
- **系统提示随开关生成**：关掉某模块后，提示里不再教模型调用已经关掉的工具。
- **测试**：新增 `tests/switch.test.mjs`（开关持久层，7 条）；`tests/host.test.mjs` 增加运行期开关 6 条（合计 29 条）。

## v0.1.0 — 首个版本

- 六个模块：**每轮人民币成本**（复用 `dsh-token-meter` 的 turn-usage 折叠，单价取官网定价页的峰值/错峰六档）、**DeepSeek 账户余额**（经凭据 seam 解析 key，key 只进请求头）、**PDF/Word/Excel/CSV 直接读写工具**（Python 引擎：pymupdf / pypdf / python-docx / openpyxl / pdf2docx / pywin32）、**右栏 docx/xlsx/csv 预览**、**硬编码编译运行环境表**（MSVC / MSBuild / cmake / ninja / Python / Node / git / dotnet / Office COM / Edge）、**直接执行与编译工具**（`dlt_run` / `dlt_build`）。
- 安全默认：所有写操作先备份（同目录 `.bak-YYYYmmdd-HHMMSS.<ext>`）；Office COM 用 `DispatchEx` 起**独立**进程，绝不依附用户正在使用的 Word / Excel。
