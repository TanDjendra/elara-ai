import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runLocalOcr } from '../channels/whatsapp-baileys/ocr-local.ts'
import { extractDocumentText } from '../channels/whatsapp-baileys/document-media.ts'

const root = path.resolve(import.meta.dirname, '..')
const python = path.join(root, '.runtime', 'document-tools-venv', 'Scripts', 'python.exe')
assert.ok(fs.existsSync(python), 'Run npm run setup:ocr before test:ocr')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-ocr-test-'))

try {
  const created = spawnSync(python, ['-c', `from PIL import Image, ImageDraw, ImageFont
import pymupdf
from io import BytesIO
from pathlib import Path
root = Path.cwd()
image = Image.new('RGB', (1000, 180), 'white')
draw = ImageDraw.Draw(image)
draw.text((30, 45), 'INGAT RAPAT JAM 8', font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 58), fill='black')
image.save(root / 'scan.png')
pdf = pymupdf.open()
page = pdf.new_page(width=1000, height=180)
page.insert_image(page.rect, filename=str(root / 'scan.png'))
pdf.save(root / 'scan.pdf')
pdf.close()`], { cwd: directory, encoding: 'utf8', timeout: 20_000, windowsHide: true })
  assert.equal(created.status, 0, created.stderr)
  const image = fs.readFileSync(path.join(directory, 'scan.png'))
  const pdf = fs.readFileSync(path.join(directory, 'scan.pdf'))
  const imageResult = await runLocalOcr(root, image, 'image')
  assert.ok('text' in imageResult)
  assert.match(imageResult.text, /INGAT/u)
  assert.match(imageResult.text, /RAPAT/u)
  const pdfResult = await extractDocumentText(pdf, 'pdf', undefined,
    (bytes, kind, signal, pages) => runLocalOcr(root, bytes, kind, signal, pages))
  assert.match(pdfResult, /Halaman 1/u)
  assert.match(pdfResult, /INGAT/u)
  assert.match(pdfResult, /RAPAT/u)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runLocalOcr(root, image, 'image', controller.signal), /SESSION_STOPPED/u)
  process.stdout.write('Local image and scanned-PDF OCR tests passed\n')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
