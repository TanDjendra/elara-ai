import { randomUUID } from 'node:crypto'
import type { AuditRecord } from '../../packages/policy/audit.ts'
import type { SessionAdmission, StopStatus, TrustedSessionContext } from '../../packages/policy/contracts.ts'

export type HermesRunState = 'queued' | 'running' | 'waiting_for_approval' | 'stopping' |
  'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface HermesRun { runId: string; status: HermesRunState; output?: string }
export interface HermesProjectTransport {
  start(input: string, idempotencyKey: string): Promise<string>
  get(runId: string): Promise<HermesRun>
  stop(runId: string): Promise<void>
  /** Positive confirmation requires inspection of the exact owned process tree. */
  verifyStopped?(runId: string): Promise<boolean>
}

const RUN_ID = /^run_[a-f0-9]{32}$/u
const TERMINAL = new Set<HermesRunState>(['completed', 'failed', 'cancelled', 'interrupted'])
const STATES = new Set<HermesRunState>([
  'queued', 'running', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted',
])

async function limitedJson(response: Response): Promise<any> {
  if (!response.ok) throw new Error('HERMES_API_FAILED')
  if (Number(response.headers.get('content-length')) > 256_000) throw new Error('HERMES_API_INVALID')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('HERMES_API_INVALID')
  const parts: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > 256_000) throw new Error('HERMES_API_INVALID')
      parts.push(Buffer.from(item.value))
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(parts, length).toString('utf8')) }
  catch { throw new Error('HERMES_API_INVALID') }
}

/** One authenticated loopback Hermes API. The gateway's workspace isolation is configured separately. */
export class HermesHttpTransport implements HermesProjectTransport {
  readonly base: string
  private checked = false
  constructor(url: string, private readonly key: string, private readonly fetcher: typeof fetch = fetch) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/'
      || !key.trim()) throw new Error('HERMES_CONFIG_INVALID')
    this.base = parsed.origin
  }
  private async request(method: string, route: string, body?: object, idempotencyKey?: string): Promise<any> {
    const response = await this.fetcher(`${this.base}${route}`, {
      method, signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return limitedJson(response)
  }
  async capabilities(): Promise<void> {
    const reply = await this.request('GET', '/v1/capabilities')
    if (reply?.platform !== 'hermes-agent' || !reply.features?.run_submission
      || !reply.features?.run_status || !reply.features?.run_stop) throw new Error('HERMES_CAPABILITY_MISSING')
    this.checked = true
  }
  async start(input: string, idempotencyKey: string): Promise<string> {
    if (!this.checked) await this.capabilities()
    const reply = await this.request('POST', '/v1/runs', { input }, idempotencyKey)
    if (!RUN_ID.test(reply?.run_id)) throw new Error('HERMES_API_INVALID')
    return reply.run_id
  }
  async get(runId: string): Promise<HermesRun> {
    if (!RUN_ID.test(runId)) throw new Error('HERMES_API_INVALID')
    const reply = await this.request('GET', `/v1/runs/${runId}`)
    if (reply?.run_id !== runId || !STATES.has(reply.status)) throw new Error('HERMES_API_INVALID')
    return { runId, status: reply.status,
      output: typeof reply.output === 'string' ? reply.output.slice(0, 4000) : undefined }
  }
  async stop(runId: string): Promise<void> {
    if (!RUN_ID.test(runId)) throw new Error('HERMES_API_INVALID')
    const reply = await this.request('POST', `/v1/runs/${runId}/stop`)
    if (reply?.run_id !== runId || !STATES.has(reply.status)) throw new Error('HERMES_API_INVALID')
  }
}

interface ProjectControl {
  admit(context: TrustedSessionContext, sessionId: string): SessionAdmission
  runDirect<T>(admission: SessionAdmission, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  requestStop(context: TrustedSessionContext, sessionId: string): StopStatus
  markDirectUnconfirmed(admission: SessionAdmission): void
}
interface ProjectAccess {
  bindRootSession(sessionId: string, principalId: string, channel: 'whatsapp'): unknown
  recordAudit(record: AuditRecord): unknown
}
export interface ProjectJob {
  id: string
  sessionId: string
  principalId: string
  senderAlias: string
  state: HermesRunState | 'unknown'
  runId?: string
  output?: string
  unconfirmed?: boolean
  settlement: Promise<void>
}

export class HermesProjectJobs {
  private jobs = new Map<string, ProjectJob>()
  constructor(private readonly control: ProjectControl, private readonly access: ProjectAccess,
    private readonly transport: HermesProjectTransport, private readonly onState: (job: ProjectJob) => void = () => {},
    private readonly pollMs = 1000) {}

  current(principalId: string, senderAlias: string): ProjectJob | undefined {
    const job = this.jobs.get(senderAlias)
    return job?.principalId === principalId ? job : undefined
  }
  start(principalId: string, senderAlias: string, input: string): ProjectJob {
    if (!input.trim() || input.length > 3000) throw new Error('HERMES_INPUT_INVALID')
    const previous = this.current(principalId, senderAlias)
    if (previous && (previous.unconfirmed || !TERMINAL.has(previous.state as HermesRunState)))
      throw new Error('HERMES_JOB_ACTIVE')
    const id = randomUUID()
    const sessionId = `hermes:${id}`
    const owner: TrustedSessionContext = { principalId, originChannel: 'whatsapp' }
    this.access.bindRootSession(sessionId, principalId, 'whatsapp')
    const admission = this.control.admit(owner, sessionId)
    const startedAt = Date.now()
    const auditBase = { schemaVersion: 1 as const, operationId: admission.operationId,
      executionId: id, principalId, sessionId, originChannel: 'whatsapp' as const }
    this.access.recordAudit({ ...auditBase, eventType: 'dispatch_started', reasonCode: 'HERMES_PROJECT_RUN',
      outcome: 'requested', createdAt: startedAt })
    const job: ProjectJob = { id, sessionId, principalId, senderAlias, state: 'queued', settlement: Promise.resolve() }
    this.jobs.set(senderAlias, job)
    job.settlement = this.control.runDirect(admission, async signal => {
      let stopOperation: Promise<void> | undefined
      let stopSince = 0
      const stopRemote = () => {
        stopSince ||= Date.now()
        if (job.runId) stopOperation ??= this.transport.stop(job.runId)
        return stopOperation
      }
      const onAbort = () => { void stopRemote()?.catch(() => undefined) }
      const announce = () => { try { this.onState(job) } catch { /* Notification is observation only. */ } }
      signal.addEventListener('abort', onAbort)
      try {
        if (signal.aborted) { job.state = 'cancelled'; return }
        // A lost start response may mean Hermes accepted the run. The idempotency key is stable.
        job.runId = await this.transport.start(input, id)
        if (signal.aborted) await stopRemote()
        for (;;) {
          const snapshot = await this.transport.get(job.runId)
          job.state = snapshot.status
          if (TERMINAL.has(snapshot.status)) {
            job.output = snapshot.output
            let verifiedStop = false
            if (signal.aborted && snapshot.status === 'cancelled' && this.transport.verifyStopped) {
              try { verifiedStop = await this.transport.verifyStopped(job.runId) }
              catch { /* A failed verification cannot confirm stop. */ }
            }
            if (signal.aborted && !verifiedStop
              || !signal.aborted && (snapshot.status === 'cancelled' || snapshot.status === 'interrupted')) {
              job.unconfirmed = true
              this.control.markDirectUnconfirmed(admission)
            }
            announce()
            return
          }
          if (snapshot.status === 'waiting_for_approval') {
            // Approval forwarding is intentionally absent from this first prototype.
            job.unconfirmed = true
            this.control.markDirectUnconfirmed(admission)
            await stopRemote()
            job.state = 'stopping'
          }
          if (signal.aborted) await stopRemote()
          if (stopSince && Date.now() - stopSince > 12_000) {
            job.state = 'unknown'
            job.unconfirmed = true
            this.control.markDirectUnconfirmed(admission)
            announce()
            return
          }
          announce()
          await new Promise(resolve => setTimeout(resolve, this.pollMs))
        }
      } catch {
        job.state = 'unknown'
        job.unconfirmed = true
        this.control.markDirectUnconfirmed(admission)
        announce()
      } finally { signal.removeEventListener('abort', onAbort) }
    }).catch(() => {
      job.state = 'unknown'
      job.unconfirmed = true
      this.control.markDirectUnconfirmed(admission)
    }).finally(() => {
      const outcome = job.state === 'completed' ? 'completed'
        : job.state === 'cancelled' ? 'cancelled' : job.state === 'failed' ? 'failed' : 'unknown'
      try { this.access.recordAudit({ ...auditBase, eventType: 'execution_settled',
        reasonCode: outcome === 'completed' ? 'HERMES_PROJECT_COMPLETED'
          : outcome === 'cancelled' ? 'HERMES_PROJECT_CANCELLED'
            : outcome === 'failed' ? 'HERMES_PROJECT_FAILED' : 'HERMES_PROJECT_UNCONFIRMED',
        outcome, createdAt: Date.now(), durationMs: Date.now() - startedAt }) }
      catch { /* A stop must settle even if audit storage degrades. */ }
    })
    return job
  }
  stop(principalId: string, senderAlias: string): StopStatus | undefined {
    const job = this.current(principalId, senderAlias)
    return job && job.state !== 'unknown' && !TERMINAL.has(job.state as HermesRunState)
      ? this.control.requestStop({ principalId, originChannel: 'whatsapp' }, job.sessionId) : undefined
  }
  async dispose(): Promise<void> {
    for (const job of this.jobs.values()) if (job.state !== 'unknown' && !TERMINAL.has(job.state as HermesRunState)) {
      try { this.stop(job.principalId, job.senderAlias) } catch { /* Dispose continues. */ }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...this.jobs.values()].map(job => job.settlement)),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 15_000); timer.unref() }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }
}
