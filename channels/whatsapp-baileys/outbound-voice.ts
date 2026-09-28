import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MAX_SPEECH_CHARS = 900
const MAX_AUDIO_BYTES = 8 * 1024 * 1024

export interface VoiceSynthesizer {
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>
}

export function voiceReplyRequested(text: string): boolean {
  const message = text.trim().toLocaleLowerCase('id-ID')
  if (/^\.voice(?:\s|$)/u.test(message)) return true
  if (/^(?:aku|saya|gue|gw)\s+(?:sudah\s+|pernah\s+|lagi\s+)?(?:kirim|ngirim|buat)\b/u.test(message)) return false
  if (/^(?:apa|kenapa|gimana|bagaimana|jelaskan|cara)\b/u.test(message)
    && !/\b(?:balas|jawab|kirim)\b/u.test(message)) return false
  return /\b(?:balas|jawab|kirim|bales|respon)\b[^.!?\n]{0,55}\b(?:voice\s*note|voicenote|vn|pakai suara|dengan suara|pake suara)\b/iu.test(message)
    || /\b(?:voice\s*note|voicenote|vn)\b[^.!?\n]{0,35}\b(?:balas|jawab|kirim|bales)\b/iu.test(message)
}

export function voicePrompt(text: string): string {
  const match = text.trim().match(/^\.voice(?:\s+([\s\S]+))?$/iu)
  return match ? match[1]?.trim() ?? '' : text
}

export function spokenText(response: string): string {
  const clean = response.replace(/```[\s\S]*?```/gu, ' bagian kode ')
    .replace(/https?:\/\/\S+/giu, ' tautan ')
    .replace(/[*_`~#]/gu, '')
    .replace(/\s+/gu, ' ').trim()
  if (!clean || clean.length > MAX_SPEECH_CHARS) throw new Error('VOICE_TEXT_INVALID')
  return clean
}

export function assertOggOpus(bytes: Buffer): Buffer {
  if (bytes.length < 36 || bytes.length > MAX_AUDIO_BYTES
    || bytes.toString('ascii', 0, 4) !== 'OggS'
    || !bytes.subarray(0, Math.min(bytes.length, 256)).includes(Buffer.from('OpusHead')))
    throw new Error('VOICE_AUDIO_INVALID')
  return bytes
}

function escapeXml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;')
}

export interface AzureVoiceConfig { region: string; key: string; voice?: string }

export class AzureVoiceSynthesizer implements VoiceSynthesizer {
  constructor(readonly config: AzureVoiceConfig, private readonly fetcher: typeof fetch = fetch) {
    if (!/^[a-z0-9-]{2,40}$/u.test(config.region) || !config.key.trim())
      throw new Error('VOICE_CONFIG_INVALID')
  }
  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const content = spokenText(text)
    if (signal?.aborted) throw new Error('VOICE_ABORTED')
    const voice = this.config.voice ?? 'id-ID-GadisNeural'
    if (!/^id-ID-[A-Za-z0-9:-]{3,80}$/u.test(voice)) throw new Error('VOICE_CONFIG_INVALID')
    const ssml = `<speak version="1.0" xml:lang="id-ID"><voice name="${voice}">${escapeXml(content)}</voice></speak>`
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
    const response = await this.fetcher(`https://${this.config.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST', signal: requestSignal, body: ssml,
      headers: { 'Ocp-Apim-Subscription-Key': this.config.key, 'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'ogg-24khz-16bit-mono-opus', 'User-Agent': 'ELARA-local' },
    })
    if (!response.ok || !response.body) throw new Error('VOICE_PROVIDER_FAILED')
    if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) throw new Error('VOICE_AUDIO_TOO_LARGE')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > MAX_AUDIO_BYTES) throw new Error('VOICE_AUDIO_TOO_LARGE')
        chunks.push(item.value)
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined)
      throw error
    } finally { reader.releaseLock() }
    if (signal?.aborted) throw new Error('VOICE_ABORTED')
    return assertOggOpus(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size))
  }
}

interface ProcessRow { ProcessId: number; ParentProcessId: number; CreationDate: string }

async function processRows(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  const rows = JSON.parse(stdout)
  return Array.isArray(rows) ? rows : rows ? [rows] : []
}

function ownedRows(rows: ProcessRow[], pid: number): ProcessRow[] {
  const ids = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (!ids.has(row.ProcessId) && ids.has(row.ParentProcessId)) {
      ids.add(row.ProcessId); changed = true
    }
  }
  return rows.filter(row => ids.has(row.ProcessId))
}

async function terminateOwned(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    if (!child.kill()) throw new Error('PROCESS_TERMINATION_UNCONFIRMED')
    return
  }
  if (process.platform !== 'win32') {
    if (!child.kill()) throw new Error('PROCESS_TERMINATION_UNCONFIRMED')
    return
  }
  let before: ProcessRow[]
  try { before = ownedRows(await processRows(), child.pid) }
  catch { child.kill(); throw new Error('PROCESS_TERMINATION_UNCONFIRMED') }
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000, maxBuffer: 8192 })
  } catch { child.kill() }
  try {
    const after = await processRows()
    if (before.some(original => after.some(row => row.ProcessId === original.ProcessId
      && row.CreationDate === original.CreationDate)) || ownedRows(after, child.pid).length)
      throw new Error('PROCESS_TERMINATION_UNCONFIRMED')
  } catch { throw new Error('PROCESS_TERMINATION_UNCONFIRMED') }
}

export async function runOwned(file: string, args: string[], input: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('VOICE_ABORTED')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let settled = false
    let aborted = false
    let timedOut = false
    let closed = false
    let termination: Promise<void> | undefined
    const requestTermination = () => {
      if (closed) return
      termination ??= terminateOwned(child)
      void termination.catch(() => undefined)
    }
    const abort = () => { aborted = true; requestTermination() }
    const timer = setTimeout(() => { timedOut = true; requestTermination() }, 30_000)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stderr.resume()
    let failure = false
    child.on('error', () => { failure = true })
    child.on('close', code => {
      closed = true
      clearTimeout(timer)
      void (termination ?? Promise.resolve()).then(
        () => finish(aborted ? new Error('VOICE_ABORTED')
          : timedOut ? new Error('VOICE_TIMEOUT') : !failure && code === 0 ? undefined : new Error('VOICE_PROCESS_FAILED')),
        () => finish(new Error('PROCESS_TERMINATION_UNCONFIRMED')),
      )
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

export class WindowsVoiceSynthesizer implements VoiceSynthesizer {
  constructor(readonly rootDir: string, readonly ffmpeg = 'ffmpeg') {}
  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const content = spokenText(text)
    if (process.platform !== 'win32') throw new Error('VOICE_WINDOWS_REQUIRED')
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'elara-voice-'))
    const wave = path.join(directory, 'voice.wav')
    const ogg = path.join(directory, 'voice.ogg')
    try {
      await runOwned('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(this.rootDir, 'scripts', 'voice-local.ps1'), wave], content, signal)
      if (signal?.aborted) throw new Error('VOICE_ABORTED')
      await runOwned(this.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', wave,
        '-vn', '-c:a', 'libopus', '-b:a', '24k', '-ar', '24000', '-ac', '1', ogg], '', signal)
      if (signal?.aborted) throw new Error('VOICE_ABORTED')
      const stats = await fs.promises.stat(ogg)
      if (stats.size > MAX_AUDIO_BYTES) throw new Error('VOICE_AUDIO_TOO_LARGE')
      return assertOggOpus(await fs.promises.readFile(ogg))
    } finally {
      const temporaryRoot = path.resolve(os.tmpdir())
      const target = path.resolve(directory)
      if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith('elara-voice-'))
        throw new Error('VOICE_TEMP_PATH_INVALID')
      await fs.promises.rm(target, { recursive: true, force: true })
    }
  }
}

export function voiceSynthesizer(rootDir: string, env: NodeJS.ProcessEnv = process.env): VoiceSynthesizer | undefined {
  const provider = env.ELARA_TTS_PROVIDER?.trim().toLowerCase()
  if (provider === 'azure') {
    const region = env.ELARA_AZURE_SPEECH_REGION?.trim()
    const key = env.ELARA_AZURE_SPEECH_KEY?.trim()
    return region && key ? new AzureVoiceSynthesizer({ region, key, voice: env.ELARA_TTS_VOICE?.trim() || undefined }) : undefined
  }
  if (provider === 'windows' || !provider && process.platform === 'win32') return new WindowsVoiceSynthesizer(rootDir)
  return undefined
}
