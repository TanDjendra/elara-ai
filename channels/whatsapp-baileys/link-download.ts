import * as dns from 'node:dns/promises'
import * as fs from 'node:fs'
import * as https from 'node:https'
import * as net from 'node:net'
import * as path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage } from 'node:http'

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const MIME: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
}

export function isDownloadRequest(text: string): boolean {
  return /^(?:\.(?:download|unduh)\b|(?:tolong\s+)?(?:unduh|download)(?:kan)?\b)/iu.test(text.trim())
}

export function requestedDownloadUrl(text: string): string | undefined {
  const value = text.trim()
  const match = value.match(/^(?:\.download|\.unduh|(?:tolong\s+)?(?:unduh|download)(?:kan)?(?:\s+(?:file|berkas|ini|dong))*[\s:]+)(?:\s*)(https:\/\/\S+)\s*$/iu)
  return match?.[1]
}

export function isPublicIPv4(address: string): boolean {
  if (net.isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || b === 0 || b === 88 && c === 99 || b === 0 && c === 2)) return false
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function checkedUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('DOWNLOAD_URL_INVALID') }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !url.hostname.includes('.') || net.isIP(url.hostname)
    || /(?:^|\.)(?:localhost|local|lan|internal|onion|test|invalid)$/iu.test(url.hostname)
    || url.hostname.length > 253) throw new Error('DOWNLOAD_URL_INVALID')
  return url
}

function safeFileName(url: URL, header: string | string[] | undefined): { fileName: string; extension: string } {
  const disposition = Array.isArray(header) ? header[0] : header
  const fromHeader = disposition?.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/iu)
  const raw = fromHeader?.[1] || fromHeader?.[2]?.trim() || decodeURIComponent(url.pathname.split('/').at(-1) || '')
  const basename = path.win32.basename(path.posix.basename(raw))
  const clean = basename.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/u, '').slice(0, 80)
  const extension = path.extname(clean).slice(1).toLowerCase()
  if (!clean || !Object.hasOwn(MIME, extension)) throw new Error('DOWNLOAD_TYPE_UNSUPPORTED')
  return { fileName: clean, extension }
}

type OpenResponse = (url: URL, address: string, signal: AbortSignal) => Promise<IncomingMessage>
const openHttps: OpenResponse = (url, address, signal) => new Promise((resolve, reject) => {
  const request = https.request(url, {
    method: 'GET', signal, maxHeaderSize: 16 * 1024, agent: false,
    headers: { Accept: 'application/octet-stream, application/pdf, text/plain, */*' },
    lookup: (_hostname, _options, callback) => callback(null, address, 4),
  }, response => {
    response.once('close', () => clearTimeout(deadline))
    resolve(response)
  })
  const deadline = setTimeout(() => request.destroy(new Error('DOWNLOAD_TIMEOUT')), 120_000)
  deadline.unref?.()
  request.once('error', error => { clearTimeout(deadline); reject(error) })
  request.setTimeout(30_000, () => request.destroy(new Error('DOWNLOAD_TIMEOUT')))
  request.end()
})

export interface DownloadResult { filePath: string; fileName: string; mime: string; bytes: Buffer }

function interruptible<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('SESSION_STOPPED'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('SESSION_STOPPED'))
    signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function downloadPublicFile(inputUrl: string, rootDir: string, senderKey: string,
  operationId: string, signal: AbortSignal, dependencies: {
    resolve?: (hostname: string) => Promise<Array<{ address: string }>>
    open?: OpenResponse
  } = {}): Promise<DownloadResult> {
  if (!/^[a-f0-9]{24}$/u.test(senderKey) || !/^[a-f0-9-]{36}$/iu.test(operationId)) {
    throw new Error('DOWNLOAD_TARGET_INVALID')
  }
  const resolve = dependencies.resolve ?? (hostname => dns.lookup(hostname, { all: true }))
  const open = dependencies.open ?? openHttps
  let url = checkedUrl(inputUrl)
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (signal.aborted) throw new Error('SESSION_STOPPED')
    const addresses = await interruptible(resolve(url.hostname), signal)
    if (signal.aborted) throw new Error('SESSION_STOPPED')
    const address = addresses.find(item => isPublicIPv4(item.address))?.address
    if (!address) throw new Error('DOWNLOAD_ADDRESS_BLOCKED')
    const response = await open(url, address, signal)
    if (signal.aborted) { response.destroy(); throw new Error('SESSION_STOPPED') }
    const status = response.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.destroy()
      const location = response.headers.location
      if (!location || redirect === 3) throw new Error('DOWNLOAD_REDIRECT_BLOCKED')
      url = checkedUrl(new URL(location, url).href)
      continue
    }
    if (status !== 200) { response.destroy(); throw new Error('DOWNLOAD_REMOTE_FAILED') }
    const advertised = Number(response.headers['content-length'] || 0)
    if (!Number.isFinite(advertised) || advertised > MAX_DOWNLOAD_BYTES) {
      response.destroy(); throw new Error('DOWNLOAD_TOO_LARGE')
    }
    let fileName: string
    let extension: string
    let directory: string
    try {
      ({ fileName, extension } = safeFileName(url, response.headers['content-disposition']))
      const contentType = String(response.headers['content-type'] || '').split(';', 1)[0]!.toLowerCase()
      if (contentType === 'text/html' || contentType === 'application/xhtml+xml'
        || contentType && contentType !== MIME[extension] && contentType !== 'application/octet-stream'
        && !(extension === 'zip' && contentType === 'application/x-zip-compressed')
        && !(extension === 'csv' && contentType === 'application/vnd.ms-excel')) {
        throw new Error('DOWNLOAD_TYPE_UNSUPPORTED')
      }
      directory = path.join(rootDir, '.runtime', 'downloads', 'elara')
      await fs.promises.mkdir(directory, { recursive: true })
      const actualRoot = await fs.promises.realpath(rootDir)
      const actualDirectory = await fs.promises.realpath(directory)
      if (!actualDirectory.startsWith(actualRoot + path.sep)) throw new Error('DOWNLOAD_TARGET_INVALID')
    } catch (error) { response.destroy(); throw error }
    const base = `${senderKey}-${operationId}`
    const partial = path.join(directory, `${base}.part`)
    const final = path.join(directory, `${base}.${extension}`)
    let written = 0
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length
      callback(written > MAX_DOWNLOAD_BYTES ? new Error('DOWNLOAD_TOO_LARGE') : null, chunk)
    } })
    try {
      await pipeline(response, limiter, fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
      if (signal.aborted) throw new Error('SESSION_STOPPED')
      const bytes = await fs.promises.readFile(partial)
      if (signal.aborted) throw new Error('SESSION_STOPPED')
      if (!bytes.length || bytes.length > MAX_DOWNLOAD_BYTES
        || bytes.subarray(0, 32).toString('utf8').trimStart().toLowerCase().startsWith('<!doctype html')
        || bytes.subarray(0, 32).toString('utf8').trimStart().toLowerCase().startsWith('<html')) {
        throw new Error('DOWNLOAD_TYPE_UNSUPPORTED')
      }
      await fs.promises.link(partial, final)
      await fs.promises.unlink(partial)
      return { filePath: final, fileName, mime: MIME[extension]!, bytes }
    } catch (error) {
      await fs.promises.unlink(partial).catch(() => undefined)
      throw error
    }
  }
  throw new Error('DOWNLOAD_REDIRECT_BLOCKED')
}
