import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import JSZip from 'jszip'
import { documentFormat, extractDocumentText, isDocumentSendRequest, prepareDocumentTarget,
  readOutboundDocument, requestedDocumentFormats } from './document-media.ts'

async function sampleDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>Isi DOCX sintetis</w:t></w:r></w:p></w:body>
    </w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function samplePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 46 >>\nstream\nBT /F1 12 Tf 50 750 Td (Isi PDF sintetis) Tj ET\nendstream',
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${body}\nendobj\n`
  }
  const start = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(output)
}

test('document intent and format require an explicit send request', () => {
  assert.equal(documentFormat('report.docx', 'application/octet-stream'), 'docx')
  assert.equal(documentFormat('report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx')
  assert.equal(documentFormat('report.pdf', 'application/pdf'), 'pdf')
  assert.equal(documentFormat('report.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), undefined)
  assert.equal(isDocumentSendRequest('edit lalu kirim balik', true), true)
  assert.equal(isDocumentSendRequest('kirimkan file excel'), true)
  assert.equal(isDocumentSendRequest('tolong baca dokumen ini', true), false)
  assert.equal(isDocumentSendRequest('jangan kirim dokumen ini', true), false)
  assert.deepEqual(requestedDocumentFormats('kirim versi docx dan pdf'), ['docx', 'pdf'])
  assert.deepEqual(requestedDocumentFormats('kirim excel'), ['xlsx'])
  assert.deepEqual(requestedDocumentFormats('edit lalu kirim balik', 'pdf'), ['pdf'])
})

test('DOCX and PDF text is extracted and scoped outbound files are verified', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-document-test-'))
  try {
    const sender = 'a'.repeat(24)
    const operation = '12345678-1234-4123-8123-123456789abc'
    for (const [format, bytes, marker] of [
      ['docx', await sampleDocx(), 'Isi DOCX sintetis'],
      ['pdf', samplePdf(), 'Isi PDF sintetis'],
    ] as const) {
      assert.match(await extractDocumentText(bytes, format), new RegExp(marker))
      const target = prepareDocumentTarget(root, sender, operation, format)
      fs.writeFileSync(target, bytes)
      const result = await readOutboundDocument(target, root, format)
      assert.ok(result.bytes.equals(bytes))
      assert.equal(result.fileName, `dokumen-elara.${format}`)
      assert.equal(result.mime, format === 'pdf' ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      assert.throws(() => prepareDocumentTarget(root, sender, operation, format), /DOCUMENT_TARGET_EXISTS/)
    }
    const outside = path.join(root, 'outside.pdf')
    fs.writeFileSync(outside, samplePdf())
    await assert.rejects(() => readOutboundDocument(outside, root, 'pdf'), /DOCUMENT_TARGET_INVALID/)
    const invalid = prepareDocumentTarget(root, sender, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pdf')
    fs.writeFileSync(invalid, 'not a PDF')
    await assert.rejects(() => readOutboundDocument(invalid, root, 'pdf'), /DOCUMENT_INVALID/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
