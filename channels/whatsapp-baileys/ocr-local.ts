import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

const MAX_OCR_INPUT = 25 * 1024 * 1024
const MAX_OCR_OUTPUT = 120 * 1024
const OCR_TIMEOUT_MS = 90_000

export type OcrOutput = { text: string } | { pages: Array<{ page: number; text: string }> }

export async function runLocalOcr(rootDir: string, bytes: Buffer, kind: 'image' | 'pdf',
  signal?: AbortSignal, pages: number[] = []): Promise<OcrOutput> {
  if (signal?.aborted) throw new Error('SESSION_STOPPED')
  if (!bytes.length || bytes.length > MAX_OCR_INPUT || kind === 'pdf'
    && (!pages.length || pages.length > 12 || pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > 50))) {
    throw new Error('OCR_INPUT_INVALID')
  }
  const python = path.join(rootDir, '.runtime', 'document-tools-venv', 'Scripts', 'python.exe')
  const helper = path.join(rootDir, 'scripts', 'ocr-local.py')
  if (!fs.existsSync(python) || !fs.existsSync(helper)) throw new Error('OCR_UNAVAILABLE')
  const args = [helper, '--kind', kind]
  if (kind === 'pdf') args.push('--pages', pages.join(','))
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: rootDir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let overflow = false
    let spawnError: Error | undefined
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, OCR_TIMEOUT_MS)
    timeout.unref?.()
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_OCR_OUTPUT) { overflow = true; child.kill() }
    })
    // Consume stderr but never echo image text, paths, or raw exceptions.
    child.stderr.resume()
    child.once('error', error => { spawnError = error })
    child.once('close', code => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { reject(new Error('SESSION_STOPPED')); return }
      if (spawnError || timedOut || overflow || code !== 0) {
        reject(new Error(spawnError ? 'OCR_UNAVAILABLE' : 'OCR_FAILED')); return
      }
      try {
        const parsed = JSON.parse(stdout)
        if (kind === 'image' && typeof parsed?.text === 'string' && parsed.text.length <= 30_000) {
          resolve({ text: parsed.text }); return
        }
        if (kind === 'pdf' && Array.isArray(parsed?.pages) && parsed.pages.length <= pages.length
          && parsed.pages.every((item: any) => pages.includes(item.page)
            && typeof item.text === 'string' && item.text.length <= 30_000)) {
          resolve({ pages: parsed.pages }); return
        }
        reject(new Error('OCR_FAILED'))
      } catch { reject(new Error('OCR_FAILED')) }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(bytes)
    if (signal?.aborted) child.kill()
  })
}
