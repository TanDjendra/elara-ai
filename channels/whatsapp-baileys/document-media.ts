import * as fs from 'node:fs'
import * as path from 'node:path'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { OcrOutput } from './ocr-local.ts'

export type DocumentFormat = 'docx' | 'pdf' | 'xlsx'
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const MAX_EXTRACTED_CHARS = 30_000
const MAX_PDF_PAGES = 50
const MAX_XLSX_SHEETS = 20
const MAX_XLSX_ROWS = 200
const MAX_XLSX_COLUMNS = 50
const MIME: Record<DocumentFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function documentFormat(name: string, mime: string): DocumentFormat | undefined {
  const extension = path.extname(name).toLowerCase()
  const mediaType = mime.split(';', 1)[0]!.toLowerCase()
  if (extension === '.docx' && [MIME.docx, 'application/octet-stream'].includes(mediaType)) return 'docx'
  if (extension === '.pdf' && [MIME.pdf, 'application/octet-stream'].includes(mediaType)) return 'pdf'
  if (extension === '.xlsx' && [MIME.xlsx, 'application/octet-stream'].includes(mediaType)) return 'xlsx'
  if (mediaType === MIME.docx && extension !== '.pdf' && extension !== '.xlsx') return 'docx'
  if (mediaType === MIME.pdf && extension !== '.docx' && extension !== '.xlsx') return 'pdf'
  if (mediaType === MIME.xlsx && extension !== '.docx' && extension !== '.pdf') return 'xlsx'
  return undefined
}

export function isDocumentSendRequest(text: string, hasDocument = false): boolean {
  const normalized = text.trim().toLocaleLowerCase('id-ID')
  if (/^(?:apa|jelaskan|gimana|bagaimana|cara|kenapa|jangan|tidak|nggak)\b/u.test(normalized)) return false
  const explicitSend = /\b(?:kirim|kirimkan|send|bagikan|share)\b/iu.test(normalized)
    && (hasDocument || /\b(?:dokumen|file|berkas|docx|word|pdf|xlsx|excel|spreadsheet|lampiran|whatsapp|wa)\b/iu.test(normalized))
  const createSpreadsheet = /\b(?:buat|buatkan|bikin|bikinin|siapkan|generate)\b/iu.test(normalized)
    && /\b(?:xlsx|excel|spreadsheet)\b/iu.test(normalized)
  return explicitSend || createSpreadsheet
}

export function requestedDocumentFormats(text: string, incoming?: DocumentFormat): DocumentFormat[] {
  const hasDocx = /\b(?:docx|word)\b/iu.test(text)
  const hasPdf = /\bpdf\b/iu.test(text)
  const hasXlsx = /\b(?:xlsx|excel|spreadsheet)\b/iu.test(text)
  const res: DocumentFormat[] = []
  if (hasDocx) res.push('docx')
  if (hasPdf) res.push('pdf')
  if (hasXlsx) res.push('xlsx')
  if (res.length) return res
  return [incoming ?? 'docx']
}

function outboundDirectory(rootDir: string): string {
  const directory = path.join(rootDir, '.runtime', 'whatsapp-outbound')
  fs.mkdirSync(directory, { recursive: true })
  const root = fs.realpathSync.native(rootDir)
  const actualDirectory = fs.realpathSync.native(directory)
  if (!actualDirectory.startsWith(root + path.sep)) throw new Error('DOCUMENT_TARGET_INVALID')
  return directory
}

export function prepareDocumentTarget(rootDir: string, senderKey: string, operationId: string,
  format: DocumentFormat): string {
  if (!/^[a-f0-9]{24}$/u.test(senderKey) || !/^[0-9a-f-]{36}$/iu.test(operationId)
    || !['docx', 'pdf', 'xlsx'].includes(format)) throw new Error('DOCUMENT_TARGET_INVALID')
  const target = path.join(outboundDirectory(rootDir), `${senderKey}-${operationId}.${format}`)
  if (fs.existsSync(target)) throw new Error('DOCUMENT_TARGET_EXISTS')
  return target
}

async function checkedBytes(bytes: Buffer, format: DocumentFormat): Promise<void> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new Error('DOCUMENT_INVALID')
  if (format === 'pdf') {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('DOCUMENT_INVALID')
  } else if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error('DOCUMENT_INVALID')
  }
}

function spreadsheetValue(value: ExcelJS.CellValue): string | undefined {
  if (value == null) return undefined
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value)
  if ('formula' in value || 'sharedFormula' in value) {
    const formula = 'formula' in value ? value.formula : value.sharedFormula
    const result = 'result' in value ? spreadsheetValue(value.result as ExcelJS.CellValue) : undefined
    return `=${formula}${result === undefined ? ' [hasil belum dihitung]' : ` [hasil tersimpan: ${result}]`}`
  }
  if ('richText' in value) return value.richText.map(part => part.text).join('')
  if ('text' in value) return String(value.text)
  if ('error' in value) return String(value.error)
  return undefined
}

async function extractSpreadsheetText(bytes: Buffer, signal?: AbortSignal): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as any)
  if (signal?.aborted) throw new Error('SESSION_STOPPED')
  const lines: string[] = []
  let length = 0
  let hasCells = false
  let partial = workbook.worksheets.length > MAX_XLSX_SHEETS
  for (const sheet of workbook.worksheets.slice(0, MAX_XLSX_SHEETS)) {
    if (signal?.aborted) throw new Error('SESSION_STOPPED')
    const heading = `[Sheet: ${sheet.name}]`
    lines.push(heading)
    length += heading.length + 1
    partial ||= sheet.rowCount > MAX_XLSX_ROWS || sheet.columnCount > MAX_XLSX_COLUMNS
    for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, MAX_XLSX_ROWS); rowNumber++) {
      if (signal?.aborted) throw new Error('SESSION_STOPPED')
      const row = sheet.getRow(rowNumber)
      for (let column = 1; column <= Math.min(row.cellCount, MAX_XLSX_COLUMNS); column++) {
        const cell = row.getCell(column)
        const value = spreadsheetValue(cell.value)
        if (value !== undefined && value !== '') {
          const line = `${cell.address}: ${value}`
          lines.push(line)
          length += line.length + 1
          hasCells = true
        }
      }
      if (length >= MAX_EXTRACTED_CHARS) { partial = true; break }
    }
    if (length >= MAX_EXTRACTED_CHARS) break
  }
  const cleaned = lines.join('\n').trim()
  if (!hasCells) return partial
    ? '[Tidak ada sel berisi pada bagian spreadsheet yang dibaca.]\n[Cuplikan spreadsheet terpotong. Jangan menganggap seluruh isi sudah terbaca.]'
    : '[Spreadsheet kosong atau tidak memiliki isi yang dapat dibaca.]'
  return cleaned.slice(0, MAX_EXTRACTED_CHARS)
    + (partial || cleaned.length > MAX_EXTRACTED_CHARS
      ? '\n[Cuplikan spreadsheet terpotong. Jangan menganggap seluruh isi sudah terbaca.]' : '')
}

export async function extractDocumentText(bytes: Buffer, format: DocumentFormat,
  signal?: AbortSignal,
  ocr?: (bytes: Buffer, kind: 'pdf', signal: AbortSignal | undefined, pages: number[]) => Promise<OcrOutput>): Promise<string> {
  if (signal?.aborted) throw new Error('SESSION_STOPPED')
  await checkedBytes(bytes, format)
  try {
    let extracted = ''
    let partial = false
    if (format === 'docx') {
      extracted = (await mammoth.extractRawText({ buffer: bytes })).value
      if (signal?.aborted) throw new Error('SESSION_STOPPED')
    } else if (format === 'xlsx') {
      return await extractSpreadsheetText(bytes, signal)
    } else {
      const pageText: string[] = []
      const scannedPages: number[] = []
      const task = getDocument({ data: new Uint8Array(bytes),
        disableFontFace: true, useSystemFonts: true })
      const abort = () => { void task.destroy() }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const pdf = await task.promise
        const pages = Math.min(pdf.numPages, MAX_PDF_PAGES)
        let length = 0
        for (let pageNumber = 1; pageNumber <= pages && length < MAX_EXTRACTED_CHARS; pageNumber++) {
          if (signal?.aborted) throw new Error('SESSION_STOPPED')
          const page = await pdf.getPage(pageNumber)
          const content = await page.getTextContent()
          const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').trim()
          pageText.push(text)
          length += text.length
          if (text.length < 10) scannedPages.push(pageNumber)
        }
        partial = pdf.numPages > pages || pageText.length < pages
      } finally {
        signal?.removeEventListener('abort', abort)
        await task.destroy()
      }
      if (scannedPages.length) {
        if (ocr) {
          try {
            const result = await ocr(bytes, 'pdf', signal, scannedPages.slice(0, 12))
            if (signal?.aborted) throw new Error('SESSION_STOPPED')
            if ('pages' in result) {
              for (const item of result.pages) pageText[item.page - 1] = item.text
            }
          } catch (error) {
            if (signal?.aborted) throw new Error('SESSION_STOPPED')
            partial = true
          }
        }
        if (scannedPages.length > 12 || scannedPages.some(page => !pageText[page - 1]?.trim())) partial = true
      }
      extracted = pageText.map((text, index) => text ? `[Halaman ${index + 1}]\n${text}` : '').filter(Boolean).join('\n\n')
    }
    const cleaned = extracted.trim()
    if (!cleaned) return '[Dokumen tidak memiliki teks yang dapat diekstrak. OCR halaman pindai belum berhasil; jangan mengaku sudah membaca isinya.]'
    const clipped = cleaned.length > MAX_EXTRACTED_CHARS
    return cleaned.slice(0, MAX_EXTRACTED_CHARS)
      + (clipped || partial ? '\n[Cuplikan dokumen belum lengkap. Jangan menganggap seluruh isi sudah terbaca.]' : '')
  } catch {
    if (signal?.aborted) throw new Error('SESSION_STOPPED')
    throw new Error('DOCUMENT_READ_FAILED')
  }
}

export async function readOutboundDocument(target: string, rootDir: string,
  format: DocumentFormat): Promise<{ bytes: Buffer; mime: string; fileName: string }> {
  const directory = outboundDirectory(rootDir)
  if (path.dirname(path.resolve(target)) !== path.resolve(directory)
    || path.extname(target).toLowerCase() !== `.${format}`) throw new Error('DOCUMENT_TARGET_INVALID')
  const before = await fs.promises.lstat(target).catch(() => { throw new Error('DOCUMENT_NOT_AVAILABLE') })
  if (!before.isFile() || before.isSymbolicLink() || before.size < 8 || before.size > MAX_DOCUMENT_BYTES) {
    throw new Error('DOCUMENT_INVALID')
  }
  const actual = await fs.promises.realpath(target)
  if (path.dirname(actual) !== fs.realpathSync.native(directory)) throw new Error('DOCUMENT_INVALID')
  const handle = await fs.promises.open(target, 'r')
  let bytes: Buffer
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) throw new Error('DOCUMENT_INVALID')
    bytes = await handle.readFile()
  } finally { await handle.close() }
  await checkedBytes(bytes, format)
  await extractDocumentText(bytes, format)
  return { bytes, mime: MIME[format], fileName: `dokumen-elara.${format}` }
}
