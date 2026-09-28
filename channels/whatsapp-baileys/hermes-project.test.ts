import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { HermesHttpTransport, HermesProjectJobs, type HermesProjectTransport } from './hermes-project.ts'

const RUN = `run_${'a'.repeat(32)}`
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('Hermes HTTP adapter uses authenticated loopback runs and validates status without leaking errors', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const client = new HermesHttpTransport('http://127.0.0.1:8642/', 'synthetic-key', async (url, init) => {
    requests.push({ url: String(url), init: init! })
    const route = new URL(String(url)).pathname
    const result = route === '/v1/capabilities'
      ? { platform: 'hermes-agent', features: { run_submission: true, run_status: true, run_stop: true } }
      : route === '/v1/runs' ? { run_id: RUN, status: 'started' }
        : route.endsWith('/stop') ? { run_id: RUN, status: 'stopping' }
          : { run_id: RUN, status: 'completed', output: 'Tes lulus.' }
    return new Response(JSON.stringify(result), { status: route === '/v1/runs' ? 202 : 200 })
  })
  await client.capabilities()
  assert.equal(await client.start('Buat proyek contoh', 'fixture-job'), RUN)
  assert.deepEqual(await client.get(RUN), { runId: RUN, status: 'completed', output: 'Tes lulus.' })
  await client.stop(RUN)
  assert.equal(requests.length, 4)
  assert.equal((requests[1]!.init.headers as Record<string, string>)['Idempotency-Key'], 'fixture-job')
  assert.equal((requests[1]!.init.headers as Record<string, string>).Authorization, 'Bearer synthetic-key')
  assert.throws(() => new HermesHttpTransport('http://192.168.1.10:8642/', 'key'), /HERMES_CONFIG_INVALID/)
  assert.throws(() => new HermesHttpTransport('http://127.0.0.1:8642/path', 'key'), /HERMES_CONFIG_INVALID/)
})

test('project stop requests one remote stop, waits for remote settlement, and keeps audit redacted', async () => {
  const running = deferred<{ runId: string; status: 'cancelled' }>()
  const admitted = new Map<string, AbortController>()
  const bindings = new Map<string, string>()
  const audits: any[] = []
  const stopStatuses = new Map<string, any>()
  let stopCalls = 0
  let statusCalls = 0
  const transport: HermesProjectTransport = {
    async start() { return RUN },
    async get() {
      statusCalls++
      if (statusCalls === 1) return { runId: RUN, status: 'running' }
      return running.promise
    },
    async stop() { stopCalls++ },
  }
  const control = {
    admit(context: any, sessionId: string) {
      assert.equal(bindings.get(sessionId), context.principalId)
      return { sessionId, generation: 0, operationId: 'operation-fixture' }
    },
    runDirect(admission: any, operation: (signal: AbortSignal) => Promise<void>) {
      const controller = new AbortController()
      admitted.set(admission.sessionId, controller)
      return operation(controller.signal).finally(() => {
        const status = stopStatuses.get(admission.sessionId)
        if (status) status.outcome = 'unconfirmed'
      })
    },
    requestStop(context: any, sessionId: string) {
      if (bindings.get(sessionId) !== context.principalId) throw new Error('SESSION_NOT_FOUND')
      let status = stopStatuses.get(sessionId)
      if (!status) {
        status = { id: 'stop-fixture', sessionId, outcome: 'stopping', requestedAt: Date.now() }
        stopStatuses.set(sessionId, status)
        admitted.get(sessionId)?.abort()
      }
      return { ...status }
    },
    markDirectUnconfirmed() {},
  }
  const access = {
    bindRootSession(sessionId: string, principalId: string) { bindings.set(sessionId, principalId) },
    recordAudit(row: any) { audits.push(row) },
  }
  const jobs = new HermesProjectJobs(control, access, transport, () => {}, 0)
  const job = jobs.start('owner-a', 'owner-a@s.whatsapp.net', 'synthetic secret marker in task')
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => jobs.start('owner-a', 'owner-a@s.whatsapp.net', 'another task'), /HERMES_JOB_ACTIVE/)
  assert.equal(jobs.current('other-user', 'owner-a@s.whatsapp.net'), undefined)
  assert.equal(jobs.stop('other-user', 'owner-a@s.whatsapp.net'), undefined)
  const stop = jobs.stop('owner-a', 'owner-a@s.whatsapp.net')!
  assert.equal(stop.outcome, 'stopping')
  assert.equal(stopCalls, 1)
  assert.equal(stopStatuses.get(job.sessionId).outcome, 'stopping')
  running.resolve({ runId: RUN, status: 'cancelled' })
  await job.settlement
  assert.equal(stopCalls, 1)
  assert.equal(job.state, 'cancelled')
  assert.equal(job.unconfirmed, true)
  assert.equal(stopStatuses.get(job.sessionId).outcome, 'unconfirmed')
  assert.throws(() => jobs.start('owner-a', 'owner-a@s.whatsapp.net', 'next task'), /HERMES_JOB_ACTIVE/)
  assert.deepEqual(audits.map(row => row.eventType), ['dispatch_started', 'execution_settled'])
  assert.doesNotMatch(JSON.stringify(audits), /synthetic secret marker/)
})

test('failed durable audit prevents Hermes from starting', () => {
  let started = false
  const jobs = new HermesProjectJobs({
    admit(_context, sessionId) { return { sessionId, generation: 0, operationId: 'operation-fixture' } },
    runDirect() { started = true; return Promise.resolve() },
    requestStop() { throw new Error('SHOULD_NOT_STOP') },
    markDirectUnconfirmed() {},
  }, {
    bindRootSession() {},
    recordAudit() { throw new Error('AUDIT_UNAVAILABLE') },
  }, {
    async start() { started = true; return RUN }, async get() { throw new Error('SHOULD_NOT_GET') },
    async stop() { throw new Error('SHOULD_NOT_STOP') },
  })
  assert.throws(() => jobs.start('owner-a', 'owner-a@s.whatsapp.net', 'fixture'), /AUDIT_UNAVAILABLE/)
  assert.equal(started, false)
})

test('stop arriving before Hermes returns a run id still stops that exact run', async () => {
  const accepted = deferred<string>()
  let remoteStops = 0
  const controllers = new Map<string, AbortController>()
  const jobs = new HermesProjectJobs({
    admit(_context, sessionId) { return { sessionId, generation: 0, operationId: 'operation-fixture' } },
    runDirect(admission, operation) {
      const controller = new AbortController()
      controllers.set(admission.sessionId, controller)
      return operation(controller.signal)
    },
    requestStop(_context, sessionId) {
      controllers.get(sessionId)?.abort()
      return { id: 'stop-fixture', sessionId, outcome: 'stopping', requestedAt: Date.now() }
    },
    markDirectUnconfirmed() {},
  }, {
    bindRootSession() {}, recordAudit() {},
  }, {
    async start() { return accepted.promise },
    async get() { return { runId: RUN, status: 'cancelled' } },
    async stop(runId) { assert.equal(runId, RUN); remoteStops++ },
  }, () => {}, 0)
  const job = jobs.start('owner-a', 'owner-a@s.whatsapp.net', 'fixture')
  jobs.stop('owner-a', 'owner-a@s.whatsapp.net')
  assert.equal(remoteStops, 0)
  accepted.resolve(RUN)
  await job.settlement
  assert.equal(remoteStops, 1)
  assert.equal(job.unconfirmed, true)
})

test('confirmed stop waits for termination of a harmless process owned by the fixture', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { shell: false, windowsHide: true, stdio: 'ignore' })
  const pid = child.pid
  assert.ok(pid)
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const entered = deferred<void>()
  const controllers = new Map<string, AbortController>()
  let stopped = false
  let unconfirmed = false
  let settled = false
  const jobs = new HermesProjectJobs({
    admit(_context, sessionId) { return { sessionId, generation: 0, operationId: 'operation-fixture' } },
    runDirect(admission, operation) {
      const controller = new AbortController()
      controllers.set(admission.sessionId, controller)
      return operation(controller.signal).finally(() => { settled = true })
    },
    requestStop(_context, sessionId) {
      controllers.get(sessionId)?.abort()
      return { id: 'stop-fixture', sessionId, outcome: 'stopping', requestedAt: Date.now() }
    },
    markDirectUnconfirmed() { unconfirmed = true },
  }, { bindRootSession() {}, recordAudit() {} }, {
    async start() { return RUN },
    async get() {
      entered.resolve()
      return { runId: RUN, status: stopped ? 'cancelled' : 'running' }
    },
    async stop() { child.kill(); await closed; stopped = true },
    async verifyStopped() {
      assert.equal(stopped, true)
      try { process.kill(pid, 0); return false }
      catch { return true }
    },
  }, () => {}, 0)
  try {
    const job = jobs.start('owner-a', 'owner-a@s.whatsapp.net', 'fixture')
    await entered.promise
    jobs.stop('owner-a', 'owner-a@s.whatsapp.net')
    await job.settlement
    assert.equal(settled, true)
    assert.equal(unconfirmed, false)
    assert.equal(job.unconfirmed, undefined)
    assert.equal(job.state, 'cancelled')
  } finally { child.kill() }
})
