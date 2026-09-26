import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { prepareDocumentTarget, readOutboundDocument } from '../channels/whatsapp-baileys/document-media.ts'

const root = path.resolve(import.meta.dirname, '..')
const python = path.join(root, '.runtime', 'document-tools-venv', 'Scripts', 'python.exe')
const helper = path.join(root, 'scripts', 'document-ops.py')
assert.ok(fs.existsSync(python), 'Run npm run setup:documents before test:documents')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-document-ops-'))

function run(args, expectedStatus = 0) {
  const result = spawnSync(python, args, { cwd: directory, encoding: 'utf8', timeout: 20_000,
    maxBuffer: 1024 * 1024, windowsHide: true })
  assert.equal(result.error, undefined)
  assert.equal(result.status, expectedStatus, result.stderr)
  return result
}

try {
  run(['-c', `from docx import Document
import pymupdf
from openpyxl import Workbook
from pathlib import Path
folder = Path.cwd()
doc = Document()
paragraph = doc.add_paragraph()
paragraph.add_run('Halo ')
paragraph.add_run('Tan lama')
doc.save(folder / 'source.docx')
pdf = pymupdf.open()
page = pdf.new_page()
page.insert_text((72, 72), 'Halo Tan lama')
pdf.save(folder / 'source.pdf')
pdf.close()
book = Workbook()
sheet = book.active
sheet.title = 'Data'
sheet['A1'] = 'Tan lama'
sheet['B1'] = 42
sheet['B1'].number_format = '#,##0.00'
sheet['C1'] = '=B1*2'
book.save(folder / 'source.xlsx')
from openpyxl.chart import BarChart
chart = BarChart()
sheet.add_chart(chart, 'E1')
book.save(folder / 'complex.xlsx')`])
  for (const format of ['docx', 'pdf']) {
    const source = path.join(directory, `source.${format}`)
    const target = path.join(directory, `edited.${format}`)
    const original = fs.readFileSync(source)
    assert.match(run([helper, 'read', '--input', source]).stdout, /Halo Tan lama/u)
    const result = run([helper, 'replace', '--input', source, '--output', target,
      '--old', 'Tan lama', '--new', 'Tan baru'])
    assert.deepEqual(JSON.parse(result.stdout).outcome, 'completed')
    assert.match(run([helper, 'read', '--input', target]).stdout, /Halo Tan baru/u)
    assert.ok(fs.readFileSync(source).equals(original), 'input must remain unchanged')
    assert.match(run([helper, 'replace', '--input', source, '--output', target,
      '--old', 'Tan lama', '--new', 'ulang'], 1).stderr, /DOCUMENT_OUTPUT_INVALID/u)
  }
  const xlsxSource = path.join(directory, 'source.xlsx')
  const xlsxEdited = path.join(directory, 'edited.xlsx')
  const xlsxNumber = path.join(directory, 'number.xlsx')
  const xlsxText = path.join(directory, 'text.xlsx')
  const originalXlsx = fs.readFileSync(xlsxSource)
  assert.match(run([helper, 'read', '--input', xlsxSource]).stdout, /\[Sheet: Data\][\s\S]*A1: Tan lama[\s\S]*C1: =B1\*2/u)
  assert.equal(JSON.parse(run([helper, 'replace', '--input', xlsxSource, '--output', xlsxEdited,
    '--old', 'Tan lama', '--new', 'Tan baru']).stdout).replacements, 1)
  assert.match(run([helper, 'read', '--input', xlsxEdited]).stdout, /A1: Tan baru/u)
  run([helper, 'set-cell', '--input', xlsxSource, '--output', xlsxNumber,
    '--sheet', 'Data', '--cell', 'B1', '--value', '43', '--type', 'number'])
  run([helper, 'set-cell', '--input', xlsxSource, '--output', xlsxText,
    '--sheet', 'Data', '--cell', 'A1', '--value', '=literal text', '--type', 'text'])
  run(['-c', `from openpyxl import load_workbook
from pathlib import Path
folder = Path.cwd()
source = load_workbook(folder / 'source.xlsx')
edited = load_workbook(folder / 'edited.xlsx')
number = load_workbook(folder / 'number.xlsx')
text = load_workbook(folder / 'text.xlsx')
assert edited['Data']['A1'].value == 'Tan baru'
assert edited['Data']['C1'].value == source['Data']['C1'].value
assert number['Data']['B1'].value == 43
assert number['Data']['B1'].number_format == source['Data']['B1'].number_format
assert number['Data']['C1'].value == source['Data']['C1'].value
assert text['Data']['A1'].value == '=literal text'
assert text['Data']['A1'].data_type == 's'`])
  assert.ok(fs.readFileSync(xlsxSource).equals(originalXlsx), 'XLSX input must remain unchanged')
  assert.match(run([helper, 'set-cell', '--input', xlsxSource, '--output', path.join(directory, 'formula.xlsx'),
    '--sheet', 'Data', '--cell', 'C1', '--value', '5', '--type', 'number'], 1).stderr,
  /DOCUMENT_FORMULA_CELL/u)
  assert.match(run([helper, 'set-cell', '--input', path.join(directory, 'complex.xlsx'),
    '--output', path.join(directory, 'complex-edited.xlsx'), '--sheet', 'Data', '--cell', 'B1',
    '--value', '43', '--type', 'number'], 1).stderr, /DOCUMENT_COMPLEX_EDIT_UNSUPPORTED/u)
  const template = path.join(directory, 'template.xlsx')
  const templateResult = JSON.parse(run([helper, 'create-xlsx', '--output', template,
    '--title', 'Daftar Tugas', '--columns', 'Tanggal,Nama,Status,Catatan']).stdout)
  assert.deepEqual([templateResult.columns, templateResult.rows], [4, 0])
  assert.match(run([helper, 'create-xlsx', '--output', template,
    '--columns', 'Nama'], 1).stderr, /DOCUMENT_OUTPUT_INVALID/u)
  const literalTitle = path.join(directory, 'literal-title.xlsx')
  run([helper, 'create-xlsx', '--output', literalTitle, '--title', '=not a formula', '--columns', 'Nama'])
  const specPath = path.join(directory, 'professional-spec.json')
  fs.writeFileSync(specPath, JSON.stringify({
    title: 'Rekap Penjualan', sheet: 'Penjualan', subtitle: 'September 2026',
    columns: [
      { key: 'tanggal', label: 'Tanggal', type: 'date' },
      { key: 'produk', label: 'Produk', type: 'text' },
      { key: 'jumlah', label: 'Jumlah', type: 'integer' },
      { key: 'nilai', label: 'Nilai', type: 'currency', symbol: 'Rp' },
      { key: 'margin', label: 'Margin', type: 'percent' },
      { key: 'catatan', label: 'Catatan', type: 'text' },
    ],
    rows: [
      { tanggal: '2026-09-26', produk: 'Buku', jumlah: 3, nilai: 125000, margin: 0.25, catatan: '=SUM(1,1)' },
      { tanggal: '2026-09-27', produk: 'Pulpen', jumlah: 10, nilai: 50000, margin: 0.1 },
    ],
  }), 'utf8')
  const professional = path.join(directory, 'professional.xlsx')
  const professionalResult = JSON.parse(run([helper, 'create-xlsx', '--output', professional,
    '--spec', specPath]).stdout)
  assert.deepEqual([professionalResult.columns, professionalResult.rows], [6, 2])
  run(['-c', `from openpyxl import load_workbook
from pathlib import Path
folder = Path.cwd()
template = load_workbook(folder / 'template.xlsx')
plain = template.active
assert plain['A1'].value == 'Daftar Tugas'
assert [plain.cell(3, col).value for col in range(1, 5)] == ['Tanggal', 'Nama', 'Status', 'Catatan']
assert plain.freeze_panes == 'A4'
assert plain.auto_filter.ref == 'A3:D15'
assert plain['A3'].font.bold and plain['A3'].font.color.rgb[-6:] == 'FFFFFF'
assert 'A1:D1' in [str(area) for area in plain.merged_cells.ranges]
assert plain['A1'].fill.fgColor.rgb[-6:] == '14283F'
assert plain.column_dimensions['D'].width >= 13
literal = load_workbook(folder / 'literal-title.xlsx').active
assert literal['A1'].value == '=not a formula' and literal['A1'].data_type == 's'
book = load_workbook(folder / 'professional.xlsx')
sheet = book['Penjualan']
assert sheet['A1'].value == 'Rekap Penjualan'
assert sheet['A2'].value == 'September 2026'
assert sheet['A4'].value.date().isoformat() == '2026-09-26'
assert sheet['C4'].value == 3
assert sheet['D4'].value == 125000
assert sheet['D4'].number_format.startswith('"Rp"')
assert sheet['E4'].value == 0.25 and sheet['E4'].number_format == '0.0%'
assert sheet['F4'].value == '=SUM(1,1)' and sheet['F4'].data_type == 's'
assert sheet.freeze_panes == 'A4'
assert sheet.auto_filter.ref == 'A3:F15'
assert sheet['A4'].fill.fgColor.rgb != sheet['A5'].fill.fgColor.rgb
assert sheet.column_dimensions['F'].width >= 13`])
  const staged = prepareDocumentTarget(directory, 'a'.repeat(24),
    '12345678-1234-4123-8123-123456789abc', 'xlsx')
  fs.copyFileSync(professional, staged)
  const outbound = await readOutboundDocument(staged, directory, 'xlsx')
  assert.equal(outbound.fileName, 'dokumen-elara.xlsx')
  assert.equal(outbound.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.ok(outbound.bytes.equals(fs.readFileSync(professional)))
  const invalidSpec = path.join(directory, 'invalid-spec.json')
  fs.writeFileSync(invalidSpec, JSON.stringify({ title: 'Bad', columns: [
    { key: 'same', label: 'One' }, { key: 'same', label: 'Two' },
  ] }), 'utf8')
  const invalidOutput = path.join(directory, 'invalid.xlsx')
  assert.match(run([helper, 'create-xlsx', '--output', invalidOutput, '--spec', invalidSpec], 1).stderr,
    /DOCUMENT_COLUMNS_INVALID/u)
  assert.equal(fs.existsSync(invalidOutput), false)
  process.stdout.write('DOCX/PDF/XLSX read, edit, and XLSX creation tests passed\n')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
