import * as fs from 'node:fs'
import * as path from 'node:path'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export type DocumentFormat = 'docx' | 'pdf' | 'xlsx'
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const MAX_EXTRACTED_CHARS = 30_000
const MAX_PDF_PAGES = 50
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
  return /\b(?:kirim|kirimkan|send|bagikan|share)\b/iu.test(normalized)
    && (hasDocument || /\b(?:dokumen|file|berkas|docx|word|pdf|xlsx|excel|spreadsheet|lampiran|whatsapp|wa)\b/iu.test(normalized))
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

export async function extractDocumentText(bytes: Buffer, format: DocumentFormat,
  signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('SESSION_STOPPED')
  await checkedBytes(bytes, format)
  try {
    let extracted = ''
    let partial = false
    if (format === 'docx') {
      extracted = (await mammoth.extractRawText({ buffer: bytes })).value
      if (signal?.aborted) throw new Error('SESSION_STOPPED')
    } else {
      const task = getDocument({ data: new Uint8Array(bytes),
        disableFontFace: true, useSystemFonts: true })
      const abort = () => { void task.destroy() }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const pdf = await task.promise
        const pages = Math.min(pdf.numPages, MAX_PDF_PAGES)
        for (let pageNumber = 1; pageNumber <= pages && extracted.length < MAX_EXTRACTED_CHARS; pageNumber++) {
          if (signal?.aborted) throw new Error('SESSION_STOPPED')
          const page = await pdf.getPage(pageNumber)
          const content = await page.getTextContent()
          extracted += content.items.map(item => 'str' in item ? item.str : '').join(' ') + '\n'
        }
        partial = pdf.numPages > pages
      } finally {
        signal?.removeEventListener('abort', abort)
        await task.destroy()
      }
    }
    const cleaned = extracted.trim()
    if (!cleaned) return '[Dokumen tidak memiliki teks yang dapat diekstrak. Jangan mengaku sudah membaca isinya; halaman pindai memerlukan OCR.]'
    const clipped = cleaned.length > MAX_EXTRACTED_CHARS
    return cleaned.slice(0, MAX_EXTRACTED_CHARS)
      + (clipped || partial ? '\n[Cuplikan dokumen terpotong. Jangan menganggap seluruh isi sudah terbaca.]' : '')
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
