// DLT Python 文档引擎自测（Node 驱动 —— 与插件 Host 半区走同一条 spawn 通道）
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const PY = 'C:\\Users\\L2959\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
const ENGINE = 'C:\\Users\\L2959\\.dsh\\plugins\\dlt\\py\\dlt_docs.py'
const WORK = join(os.tmpdir(), 'dlt-selftest')

let pass = 0
let fail = 0
const fails = []

function runEngine(op, args) {
  return new Promise((resolve) => {
    const child = spawn(PY, [ENGINE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ ok: false, error: 'spawn 失败: ' + e.message }))
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop()
      if (!line) return resolve({ ok: false, error: `无 stdout (exit ${code}); stderr=${err.slice(0, 400)}` })
      try { resolve(JSON.parse(line)) } catch (e) { resolve({ ok: false, error: '输出非 JSON: ' + line.slice(0, 200) }) }
    })
    child.stdin.end(JSON.stringify({ op, args }))
  })
}

async function check(label, op, args, verify) {
  const res = await runEngine(op, args)
  if (res && res.ok) {
    let extra = ''
    if (verify) {
      try { extra = verify(res.data) || '' } catch (e) { extra = '验证抛错: ' + e.message }
    }
    console.log(`  [ ok ] ${label}${extra ? '  → ' + extra : ''}`)
    pass++
  } else {
    console.log(`  [FAIL] ${label}  → ${res && res.error}`)
    fail++
    fails.push(`${label}: ${res && res.error}`)
  }
  return res
}

const f = (name) => join(WORK, name)
const kb = (p) => (existsSync(p) ? statSync(p).size : 0)

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// ── Word ────────────────────────────────────────────────────────────────────
console.log('\n=== Word (.docx) ===')
const docx = f('demo.docx')
await check('docx create（标题+正文+表格）', 'create', {
  path: docx, kind: 'docx', title: 'DLT 测试文档',
  blocks: [
    { type: 'h1', text: '第一章' },
    { type: 'p', text: '这是正文段落，包含中文与 English mixed 混排。' },
    { type: 'table', data: [['表头A', '表头B'], ['值1', '值2']], style: 'Table Grid' },
  ],
}, (d) => `${kb(docx)} bytes`)
await check('docx read', 'read', { path: docx }, (d) => `blocks=${d.blocks.length} tables=${d.tables.length} 首块="${d.blocks[0].text}"`)
await check('docx edit（替换/追加/改单元格/加行）', 'edit', {
  path: docx,
  ops: [
    { op: 'replace_text', find: 'English', replace: '英文' },
    { op: 'add_paragraph', text: '追加的一句话' },
    { op: 'set_cell', table: 0, row: 2, col: 2, text: '改过的值' },
    { op: 'add_table_row', table: 0, data: ['新行1', '新行2'] },
  ],
}, (d) => `applied=${d.applied.length} backup=${d.backup ? d.backup.split('\\').pop() : 'none'}`)
await check('docx read（编辑后核对）', 'read', { path: docx }, (d) => {
  const hit = d.blocks.filter((b) => b.text.includes('英文')).length
  const cell = d.tables[0].data[1][1]
  return `命中替换=${hit} 末块="${d.blocks[d.blocks.length - 1].text}" 表行=${d.tables[0].rows} (2,2)="${cell}"`
})

// ── PDF ─────────────────────────────────────────────────────────────────────
console.log('\n=== PDF ===')
const pdf = f('demo.pdf')
await check('pdf create（3 页）', 'create', {
  path: pdf, kind: 'pdf',
  pages: [
    { text: 'DLT PDF page one\nSecond line of page one.' },
    { text: 'DLT PDF page two' },
    { text: 'DLT PDF page three' },
  ],
}, (d) => `${d.pages} pages, ${kb(pdf)} bytes`)
await check('pdf info', 'info', { path: pdf }, (d) => `pages=${d.pages} A4=${Math.round(d.pageSizes[0].width)}x${Math.round(d.pageSizes[0].height)}`)
await check('pdf read（1-2 页）', 'read', { path: pdf, pages: [1, 2] }, (d) => `returns=${d.returned} p1="${d.content[0].text.slice(0, 24).replace(/\n/g, ' | ')}"`)
await check('pdf render（第1页 → PNG，供视觉模型看）', 'render', { path: pdf, page: 1, dpi: 110 }, (d) => `${d.image.split('\\').pop()} ${d.width}x${d.height} ${d.bytes} bytes`)
await check('pdf edit（水印/文本替换/元数据）', 'edit', {
  path: pdf,
  ops: [
    { op: 'watermark', text: 'DLT', fontSize: 40, opacity: 0.15 },
    { op: 'replace_text', find: 'two', replace: 'TWO' },
    { op: 'set_metadata', fields: { title: 'DLT demo', author: 'DLT' } },
  ],
}, (d) => `applied=${d.applied.length} backup=${d.backup ? d.backup.split('\\').pop() : 'none'}`)
await check('pdf info（编辑后）', 'info', { path: pdf }, (d) => `pages=${d.pages} title="${d.metadata.title}"`)
const outPdf = f('demo-out.pdf')
await check('pdf edit → 另存（删第2页 + 第1页旋转90°）', 'edit', {
  path: pdf, out: outPdf,
  ops: [{ op: 'delete_pages', pages: [2] }, { op: 'rotate', pages: [1], degrees: 90 }],
}, (d) => `out=${d.path.split('\\').pop()} ${kb(outPdf)} bytes`)
await check('pdf info（另存结果）', 'info', { path: outPdf }, (d) => `pages=${d.pages}`)

// ── CSV ─────────────────────────────────────────────────────────────────────
console.log('\n=== CSV ===')
const csv = f('demo.csv')
await check('csv write', 'edit', { path: csv, rows: [['姓名', '分数'], ['张三', 95], ['李四', 88]] }, (d) => `${d.rows} rows`)
await check('csv read', 'read', { path: csv }, (d) => `rows=${d.rows} 第2行=${d.data[1].join('/')}`)

// ── 转换与 Excel ────────────────────────────────────────────────────────────
console.log('\n=== 转换 / Excel（依赖 pdf2docx·openpyxl）===')
await check('pdf → html（pymupdf）', 'convert', { path: pdf, to: 'html', out: f('demo.html') }, (d) => `${d.pages} pages, ${d.chars} chars`)
await check('pdf → docx（pdf2docx）', 'convert', { path: pdf, to: 'docx', out: f('frompdf.docx') }, (d) => `${kb(d.path)} bytes`)
const xlsx = f('demo.xlsx')
await check('xlsx create（openpyxl）', 'create', { path: xlsx, kind: 'xlsx', sheets: [{ name: '数据', rows: [['项目', '金额'], ['甲', 100], ['乙', 250]] }] }, () => `${kb(xlsx)} bytes`)
await check('xlsx edit（写值/公式/加表/样式）', 'edit', {
  path: xlsx,
  ops: [
    { op: 'set_cell', sheet: '数据', cell: 'C1', value: '备注' },
    { op: 'set_cell', sheet: '数据', cell: 'C2', value: 'DLT' },
    { op: 'set_cell', sheet: '数据', cell: 'D2', formula: '=SUM(B2:B3)' },
    { op: 'add_sheet', name: '汇总' },
    { op: 'set_style', sheet: '数据', range: 'A1:C1', bold: true, fill: 'FFF2CC' },
  ],
}, (d) => `applied=${d.applied.length}`)
await check('xlsx read（缓存值）', 'read', { path: xlsx, formulas: false }, (d) => `sheets=${d.sheets.map((s) => s.name).join(',')} D2=${d.sheets[0].rows[1][3]}`)
await check('xlsx read（公式）', 'read', { path: xlsx, formulas: true }, (d) => `D2公式=${d.sheets[0].rows[1][3]}`)

// ── 错误路径 ────────────────────────────────────────────────────────────────
console.log('\n=== 错误路径（应当失败）===')
const bad = await runEngine('read', { path: f('不存在.docx') })
if (bad && bad.ok === false) { console.log('  [ ok ] 不存在的文件被正确报错 → ' + bad.error); pass++ }
else { console.log('  [FAIL] 不存在的文件未报错'); fail++; fails.push('missing-file') }
const bad2 = await runEngine('nope', {})
if (bad2 && bad2.ok === false) { console.log('  [ ok ] 未知 op 被正确报错'); pass++ }
else { console.log('  [FAIL] 未知 op 未报错'); fail++; fails.push('unknown-op') }

console.log(`\n=== 结果: pass=${pass} fail=${fail} ===`)
if (fails.length) { console.log('失败项:'); fails.forEach((x) => console.log('  - ' + x)) }
console.log('产物目录: ' + WORK)
console.log('文件: ' + readdirSync(WORK).join(', '))
process.exit(fail ? 1 : 0)
