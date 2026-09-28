import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import { spawn } from 'node:child_process'

interface ClientFile { installed?: { client_id?: string; client_secret?: string } }
interface SavedToken { refresh_token: string; access_token?: string; expires_at?: number }

export class CalendarAuth {
  private token?: SavedToken
  private refresh?: Promise<string>
  readonly clientPath: string
  readonly tokenPath: string
  constructor(readonly root: string, private readonly fetcher: typeof fetch = fetch) {
    this.clientPath = path.join(root, '.runtime', 'google-calendar-client.json')
    this.tokenPath = path.join(root, '.runtime', 'google-calendar-token.dpapi')
  }
  configured(): boolean { return process.platform === 'win32' && fs.existsSync(this.clientPath) && fs.existsSync(this.tokenPath) }

  private client(): { client_id: string; client_secret?: string } {
    let value: ClientFile
    try { value = JSON.parse(fs.readFileSync(this.clientPath, 'utf8')) as ClientFile }
    catch { throw new Error('CALENDAR_CLIENT_UNAVAILABLE') }
    const client = value.installed
    if (!client?.client_id || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(client.client_id))
      throw new Error('CALENDAR_CLIENT_INVALID')
    return { client_id: client.client_id, client_secret: client.client_secret }
  }

  private async dpapi(mode: 'protect' | 'unprotect', input: string): Promise<string> {
    if (process.platform !== 'win32') throw new Error('CALENDAR_WINDOWS_REQUIRED')
    const script = path.join(this.root, 'scripts', 'calendar-dpapi.ps1')
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, mode],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 64_000) child.kill() })
      child.stderr.resume() // Never expose token or PowerShell details in logs.
      child.on('error', () => reject(new Error('CALENDAR_CREDENTIAL_UNAVAILABLE')))
      child.on('close', code => code === 0 ? resolve(output) : reject(new Error('CALENDAR_CREDENTIAL_UNAVAILABLE')))
      child.stdin.end(input)
    })
  }

  private async load(): Promise<SavedToken> {
    if (this.token) return this.token
    try {
      const raw = await this.dpapi('unprotect', fs.readFileSync(this.tokenPath, 'utf8'))
      const token = JSON.parse(raw) as SavedToken
      if (!token.refresh_token || typeof token.refresh_token !== 'string') throw new Error('invalid')
      return this.token = token
    } catch { throw new Error('CALENDAR_CREDENTIAL_UNAVAILABLE') }
  }
  private async save(token: SavedToken): Promise<void> {
    const encrypted = await this.dpapi('protect', JSON.stringify(token))
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true })
    const temporary = `${this.tokenPath}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 })
      fs.renameSync(temporary, this.tokenPath)
      this.token = token
    } finally { try { fs.unlinkSync(temporary) } catch {} }
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('CALENDAR_ABORTED')
    const saved = await this.load()
    if (signal?.aborted) throw new Error('CALENDAR_ABORTED')
    if (saved.access_token && (saved.expires_at ?? 0) > Date.now() + 60_000) return saved.access_token
    this.refresh ??= this.exchange({ grant_type: 'refresh_token', refresh_token: saved.refresh_token })
      .then(async response => {
        const next: SavedToken = { refresh_token: response.refresh_token || saved.refresh_token,
          access_token: response.access_token, expires_at: Date.now() + response.expires_in * 1000 }
        await this.save(next)
        return response.access_token
      }).finally(() => { this.refresh = undefined })
    if (!signal) return this.refresh
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(new Error('CALENDAR_ABORTED'))
      signal.addEventListener('abort', abort, { once: true })
      void this.refresh!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
  }

  private async exchange(parameters: Record<string, string>, signal?: AbortSignal): Promise<{
    access_token: string; refresh_token?: string; expires_in: number
  }> {
    const client = this.client()
    const body = new URLSearchParams({ client_id: client.client_id, ...parameters })
    if (client.client_secret) body.set('client_secret', client.client_secret)
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    const response = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', body, signal: requestSignal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (!response.ok) throw new Error('CALENDAR_OAUTH_FAILED')
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error('CALENDAR_OAUTH_INVALID')
    return token as { access_token: string; refresh_token?: string; expires_in: number }
  }

  async connect(showUrl: (url: string) => void): Promise<void> {
    const client = this.client()
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    const state = crypto.randomBytes(24).toString('hex')
    const server = http.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('CALENDAR_CALLBACK_UNAVAILABLE')
    const redirect = `http://127.0.0.1:${address.port}`
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authorization.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect,
      response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar.events',
      access_type: 'offline', prompt: 'consent', code_challenge: challenge,
      code_challenge_method: 'S256', state }).toString()
    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CALENDAR_AUTH_TIMEOUT')), 5 * 60_000)
        const finish = (value: string | Error) => {
          clearTimeout(timer)
          if (value instanceof Error) reject(value)
          else resolve(value)
        }
        server.on('request', (request, response) => {
          const query = new URL(request.url ?? '/', redirect).searchParams
          if (query.get('state') !== state) {
            response.writeHead(400).end('Authorization failed. Return to the terminal.')
            return
          }
          if (query.get('error') || !query.get('code')) {
            response.writeHead(400).end('Authorization denied. Return to the terminal.')
            finish(new Error('CALENDAR_AUTH_DENIED'))
            return
          }
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end('Google Calendar connected. You can close this tab.')
          finish(query.get('code')!)
        })
        try { showUrl(authorization.toString()) }
        catch (error) { finish(error instanceof Error ? error : new Error('CALENDAR_AUTH_DISPLAY_FAILED')) }
      })
      const token = await this.exchange({ grant_type: 'authorization_code', code,
        code_verifier: verifier, redirect_uri: redirect })
      if (!token.refresh_token) throw new Error('CALENDAR_REFRESH_TOKEN_MISSING')
      await this.save({ refresh_token: token.refresh_token, access_token: token.access_token,
        expires_at: Date.now() + token.expires_in * 1000 })
    } finally { server.close() }
  }
}
