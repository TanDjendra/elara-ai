import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { downloadPublicFile, isDownloadRequest, isPublicIPv4, requestedDownloadUrl } from './link-download.ts'

function response(statusCode: number, headers: Record<string, string>, body?: Buffer) {
  const stream = Object.assign(new PassThrough(), { statusCode, headers })
  if (body) stream.end(body)
  return stream as any
}

test('explicit download intent accepts one HTTPS file URL', () => {
  assert.equal(requestedDownloadUrl('tolong unduh file ini https://example.com/a.pdf'), 'https://example.com/a.pdf')
  assert.equal(requestedDownloadUrl('.download https://example.com/a.pdf'), 'https://example.com/a.pdf')
  assert.equal(isDownloadRequest('unduh http://example.com/a.pdf'), true)
  assert.equal(requestedDownloadUrl('unduh http://example.com/a.pdf'), undefined)
  assert.equal(isDownloadRequest('lihat https://example.com/a.pdf'), false)
  assert.equal(requestedDownloadUrl('unduh https://example.com/a.pdf https://example.com/b.pdf'), undefined)
})

test('resolver rejects non-public addresses and does not open a connection', async () => {
  for (const blocked of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1',
    '169.254.1.1', '100.64.0.1', '198.18.0.1', '203.0.113.5']) {
    assert.equal(isPublicIPv4(blocked), false)
  }
  assert.equal(isPublicIPv4('8.8.8.8'), true)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-link-test-'))
  try {
    let opened = false
    await assert.rejects(downloadPublicFile('https://example.com/file.pdf', root, 'a'.repeat(24),
      '11111111-1111-4111-8111-111111111111', new AbortController().signal, {
        resolve: async () => [{ address: '127.0.0.1' }],
        open: async () => { opened = true; return response(200, {}) },
      }), /DOWNLOAD_ADDRESS_BLOCKED/)
    assert.equal(opened, false)
    await assert.rejects(downloadPublicFile('https://127.0.0.1/file.pdf', root, 'a'.repeat(24),
      '11111111-1111-4111-8111-111111111111', new AbortController().signal, {
        resolve: async () => [{ address: '8.8.8.8' }],
      }), /DOWNLOAD_URL_INVALID/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('bounded public file is saved under its operation and returned without URL exposure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-link-test-'))
  try {
    const payload = Buffer.from('%PDF-1.4\nsynthetic document\n')
    const result = await downloadPublicFile('https://files.example.com/private-token/file.pdf?secret=marker',
      root, 'a'.repeat(24), '22222222-2222-4222-8222-222222222222', new AbortController().signal, {
        resolve: async () => [{ address: '8.8.8.8' }],
        open: async () => response(200, { 'content-type': 'application/pdf', 'content-length': String(payload.length) }, payload),
      })
    assert.equal(result.fileName, 'file.pdf')
    assert.equal(result.mime, 'application/pdf')
    assert.ok(result.filePath.startsWith(path.join(root, '.runtime', 'downloads', 'elara') + path.sep))
    assert.ok(fs.readFileSync(result.filePath).equals(payload))
    assert.equal(result.filePath.includes('marker'), false)
    assert.equal(fs.existsSync(result.filePath.replace(/\.pdf$/u, '.part')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('redirect to private address and oversized response fail before writing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-link-test-'))
  try {
    const seen: string[] = []
    await assert.rejects(downloadPublicFile('https://files.example.com/file.pdf', root, 'b'.repeat(24),
      '33333333-3333-4333-8333-333333333333', new AbortController().signal, {
        resolve: async hostname => [{ address: hostname === 'private.example.com' ? '10.0.0.1' : '8.8.8.8' }],
        open: async url => { seen.push(url.hostname); return response(302, { location: 'https://private.example.com/file.pdf' }) },
      }), /DOWNLOAD_ADDRESS_BLOCKED/)
    assert.deepEqual(seen, ['files.example.com'])
    await assert.rejects(downloadPublicFile('https://files.example.com/file.pdf', root, 'b'.repeat(24),
      '33333333-3333-4333-8333-333333333333', new AbortController().signal, {
        resolve: async () => [{ address: '8.8.8.8' }],
        open: async () => response(200, { 'content-type': 'application/pdf', 'content-length': '26214401' }),
      }), /DOWNLOAD_TOO_LARGE/)
    assert.equal(fs.existsSync(path.join(root, '.runtime', 'downloads')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('abort removes partial file while a response is streaming', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-link-test-'))
  try {
    const controller = new AbortController()
    let streaming!: () => void
    const started = new Promise<void>(resolve => { streaming = resolve })
    const stream = Object.assign(Readable.from((async function* () {
      yield Buffer.from('%PDF-1.4\n')
      streaming()
      await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
    })()), { statusCode: 200, headers: { 'content-type': 'application/pdf' } }) as any
    const pending = downloadPublicFile('https://files.example.com/file.pdf', root, 'c'.repeat(24),
      '44444444-4444-4444-8444-444444444444', controller.signal, {
        resolve: async () => [{ address: '8.8.8.8' }], open: async () => stream,
      })
    await started
    controller.abort()
    await assert.rejects(pending)
    assert.deepEqual(fs.readdirSync(path.join(root, '.runtime', 'downloads', 'elara')), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('abort during DNS wait settles without opening a connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-link-test-'))
  try {
    const controller = new AbortController()
    let resolveLookup!: (value: Array<{ address: string }>) => void
    const lookup = new Promise<Array<{ address: string }>>(resolve => { resolveLookup = resolve })
    let opened = false
    const pending = downloadPublicFile('https://files.example.com/file.pdf', root, 'd'.repeat(24),
      '55555555-5555-4555-8555-555555555555', controller.signal, {
        resolve: async () => lookup,
        open: async () => { opened = true; return response(200, {}) },
      })
    controller.abort()
    await assert.rejects(pending, /SESSION_STOPPED/)
    resolveLookup([{ address: '8.8.8.8' }])
    assert.equal(opened, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('HTML masquerading as a document is rejected and leaves no file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-link-test-'))
  try {
    await assert.rejects(downloadPublicFile('https://files.example.com/file.pdf', root, 'e'.repeat(24),
      '66666666-6666-4666-8666-666666666666', new AbortController().signal, {
        resolve: async () => [{ address: '8.8.8.8' }],
        open: async () => response(200, { 'content-type': 'application/octet-stream' }, Buffer.from('<html>not a PDF</html>')),
      }), /DOWNLOAD_TYPE_UNSUPPORTED/)
    assert.deepEqual(fs.readdirSync(path.join(root, '.runtime', 'downloads', 'elara')), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
