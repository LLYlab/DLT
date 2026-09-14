# dlt_office.ps1 — DLT 的 Office 转换桥（Word / Excel COM）
#
# 由 DLT Host 半区调用，把 .docx / .xlsx 导出为 PDF（保真最高，因为本机装了 Office）。
# 输出：stdout 一行 JSON  {"ok":true,"data":{...}} 或 {"ok":false,"error":"..."}
#
# 安全口径（两条踩过的坑都写进来，避免以后再犯）：
#   1. 只依附「可用」的 Office 实例：GetActiveObject 拿到陈旧 RCW 时，第一次碰属性就会
#      TYPE_E_CANTLOADLIBRARY（0x80029C4A），所以先验证再决定是依附还是新建。
#   2. 依附到用户正在用的实例时**绝不修改它的任何属性**（尤其 Visible/DisplayAlerts）：
#      把 Visible 设成 false 会把用户开着的窗口直接藏掉。文档本身通过
#      Documents.Open(..., Visible:=false) 隐藏打开，不需要动应用级属性。
#   3. 只有「本脚本自己新建的」实例才会 Quit，绝不关闭用户在用的 Office。
#   4. 无论成功失败都释放 COM 引用，避免残留 WINWORD.EXE / EXCEL.EXE。
#
# 注意：本文件必须以「带 BOM 的 UTF-8」保存 —— Windows PowerShell 5.1 对无 BOM 的
# 脚本按 ANSI 解码，中文注释会撑坏语法（这也是踩过的坑）。

param(
    [Parameter(Mandatory = $true)][ValidateSet('docx', 'xlsx')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$Range = '',
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $OutputEncoding = New-Object Text.UTF8Encoding($false)
} catch { }

function Write-Result($payload) {
    [Console]::Out.Write(($payload | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Write("`n")
    [Console]::Out.Flush()
}

function Release($obj) {
    if ($null -ne $obj) {
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($obj) } catch { }
    }
}

function Count-Process($name) {
    try { return @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count } catch { return 0 }
}

# 取得一个「确实可用」的 Office 实例：优先依附已运行实例（省一次冷启动），
# 但陈旧 RCW 必须能被识别出来，否则后续每个属性访问都会炸；验证失败就新建自己的实例。
function Get-UsableApplication($progId, $processName, $probe) {
    if ((Count-Process $processName) -gt 0) {
        try {
            $existing = [Runtime.InteropServices.Marshal]::GetActiveObject($progId)
            if ($null -ne $existing) {
                & $probe $existing
                return @{ app = $existing; created = $false }
            }
        } catch {
            # 依附不可用（陈旧实例 / 类型库未加载）→ 落到下面新建
        }
    }
    $app = New-Object -ComObject $progId
    return @{ app = $app; created = $true }
}

if (-not (Test-Path -LiteralPath $Source)) {
    Write-Result @{ ok = $false; error = "源文件不存在: $Source" }
    exit 1
}
$targetDir = Split-Path -Parent $Target
if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
}

$app = $null
$doc = $null
$created = $false
$started = Get-Date

try {
    if ($Kind -eq 'docx') {
        $pair = Get-UsableApplication 'Word.Application' 'WINWORD' { param($a) $null = $a.Version }
        $app = $pair.app
        $created = $pair.created
        if ($created) {
            try { $app.Visible = $false } catch { }
            try { $app.AutomationSecurity = 3 } catch { }   # msoAutomationSecurityForceDisable
        }
        # 第 12 个参数 Visible:=false —— 文档隐藏打开，不影响用户窗口。
        $doc = $app.Documents.Open($Source, $false, $true, $false, '', '', $false, '', '', 0, 0, $false, $false, $false)
        # 17 = wdExportFormatPDF
        $doc.ExportAsFixedFormat($Target, 17, $false, 0, 0, 0, 0, 0, $true, $true, 0, $true, $true, $false)
    }
    else {
        $pair = Get-UsableApplication 'Excel.Application' 'EXCEL' { param($a) $null = $a.Workbooks.Count }
        $app = $pair.app
        $created = $pair.created
        if ($created) {
            try { $app.Visible = $false } catch { }
            try { $app.DisplayAlerts = $false } catch { }
            try { $app.AutomationSecurity = 3 } catch { }
        }
        # UpdateLinks=0, ReadOnly=$true：不改用户文件。
        $doc = $app.Workbooks.Open($Source, 0, $true)
        # 0 = xlTypePDF
        if ([string]::IsNullOrWhiteSpace($Range)) {
            $doc.ExportAsFixedFormat(0, $Target)
        }
        else {
            $doc.Worksheets.Item(1).Range($Range).ExportAsFixedFormat(0, $Target)
        }
    }

    $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
    $size = 0
    if (Test-Path -LiteralPath $Target) { $size = (Get-Item -LiteralPath $Target).Length }
    Write-Result @{ ok = $true; data = @{ kind = $Kind; source = $Source; path = $Target; bytes = $size; ms = $elapsed; attached = (-not $created) } }
}
catch {
    Write-Result @{ ok = $false; error = ("Office 转换失败（{0}）: {1}" -f $Kind, $_.Exception.Message) }
    exit 1
}
finally {
    if ($null -ne $doc) {
        try { $doc.Close($false) } catch { }
        Release $doc
    }
    if ($null -ne $app) {
        if ($created) { try { $app.Quit() } catch { } }
        Release $app
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
