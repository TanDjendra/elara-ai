import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AutonomyStore } from './autonomy.ts'
import { CalendarBridge, CalendarHttpError, GoogleCalendarClient, calendarEventId,
  type CalendarEvent, type CalendarTransport } from './google-calendar.ts'
import { CalendarAuth } from './calendar-auth.ts'

const now = 1_800_000_000_000

class FakeGoogle implements CalendarTransport {
  events = new Map<string, CalendarEvent>()
  creates = 0
  deletes = 0
  async create(event: CalendarEvent): Promise<CalendarEvent> {
    this.creates++
    if (this.events.has(event.id)) throw new CalendarHttpError(409)
    this.events.set(event.id, event)
    return event
  }
  async get(id: string): Promise<CalendarEvent | undefined> { return this.events.get(id) }
  async delete(id: string): Promise<void> { this.deletes++; this.events.delete(id) }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-calendar-'))
  const store = new AutonomyStore(path.join(root, 'autonomy.db'))
  const remote = new FakeGoogle()
  const bridge = new CalendarBridge(store, remote)
  const add = (principal: string, sender: string, source: string, text = 'rapat') => {
    const id = store.addReminder(principal, sender, source, { dueAt: now + 3_600_000, text }, now)
    store.linkCalendar(principal, sender, id, calendarEventId(principal, sender, source))
    return store.calendarLink(principal, sender, id)!
  }
  const close = () => { store.close(); fs.rmSync(root, { recursive: true, force: true }) }
  return { store, remote, bridge, add, close }
}

test('stable event ID makes create and retry idempotent, scoped by sender', async () => {
  const f = fixture()
  try {
    const alice = f.add('owner', 'sender-a', 'message-1')
    const bob = f.add('owner', 'sender-b', 'message-1')
    assert.notEqual(alice.eventId, bob.eventId)
    assert.match(alice.eventId, /^[0-9a-v]{5,1024}$/)
    assert.equal(f.store.calendarLink('owner', 'sender-b', alice.reminderId), undefined)
    assert.equal(await f.bridge.reconcile(alice, undefined, now), 'created')
    assert.equal(f.remote.creates, 1)
    assert.equal(f.store.calendarLink('owner', 'sender-a', alice.reminderId)?.state, 'linked')
    // Simulate a crash after Google accepted create but before local settlement.
    f.store.settleCalendarLink({ ...alice, state: 'linked' }, 'pending', 0)
    assert.equal(await f.bridge.reconcile(f.store.calendarLink('owner', 'sender-a', alice.reminderId)!, undefined, now), 'updated')
    assert.equal(f.remote.events.size, 1)
    assert.equal(f.remote.creates, 2)
  } finally { f.close() }
})

test('Google edits and deletes update only the linked local reminder', async () => {
  const f = fixture()
  try {
    const first = f.add('owner', 'sender-a', 'source-a')
    const other = f.add('owner', 'sender-b', 'source-b', 'other')
    await f.bridge.reconcile(first, undefined, now)
    await f.bridge.reconcile(other, undefined, now)
    f.remote.events.set(first.eventId, { id: first.eventId, summary: 'rapat dipindah',
      start: { dateTime: new Date(now + 7_200_000).toISOString() } })
    const current = f.store.calendarLink('owner', 'sender-a', first.reminderId)!
    assert.equal(await f.bridge.reconcile(current, undefined, now), 'updated')
    assert.deepEqual(f.store.pendingReminders('owner', 'sender-a').map(row => [row.dueAt, row.text]),
      [[now + 7_200_000, 'rapat dipindah']])
    assert.equal(f.store.pendingReminders('owner', 'sender-b')[0]?.text, 'other')
    f.remote.events.delete(first.eventId)
    assert.equal(await f.bridge.reconcile(f.store.calendarLink('owner', 'sender-a', first.reminderId)!, undefined, now), 'deleted')
    assert.equal(f.store.pendingReminders('owner', 'sender-a').length, 0)
    assert.equal(f.store.pendingReminders('owner', 'sender-b').length, 1)
  } finally { f.close() }
})

test('moving a Google event into the past pauses its reminder and a later future move restores it', async () => {
  const f = fixture()
  try {
    const link = f.add('owner', 'sender', 'source')
    await f.bridge.reconcile(link, undefined, now)
    f.remote.events.set(link.eventId, { id: link.eventId, summary: 'jadwal lewat',
      start: { dateTime: new Date(now - 60_000).toISOString() } })
    await f.bridge.reconcile(f.store.calendarLink('owner', 'sender', link.reminderId)!, undefined, now)
    assert.equal(f.store.pendingReminders('owner', 'sender').length, 0)
    assert.equal(f.store.calendarLink('owner', 'sender', link.reminderId)?.state, 'linked')
    f.remote.events.set(link.eventId, { id: link.eventId, summary: 'jadwal baru',
      start: { dateTime: new Date(now + 7_200_000).toISOString() } })
    await f.bridge.reconcile(f.store.calendarLink('owner', 'sender', link.reminderId)!, undefined, now)
    assert.equal(f.store.pendingReminders('owner', 'sender')[0]?.text, 'jadwal baru')
  } finally { f.close() }
})

test('local cancel deletes only its linked Google event and survives restart', async () => {
  const f = fixture()
  try {
    const first = f.add('owner', 'sender-a', 'source-a')
    const other = f.add('owner', 'sender-b', 'source-b')
    await f.bridge.reconcile(first, undefined, now)
    await f.bridge.reconcile(other, undefined, now)
    assert.equal(f.store.cancelReminder('other', 'sender-a', first.reminderId), false)
    assert.equal(f.store.cancelReminder('owner', 'sender-a', first.reminderId), true)
    const pending = f.store.calendarLink('owner', 'sender-a', first.reminderId)!
    assert.equal(pending.state, 'delete_pending')
    assert.equal(await f.bridge.reconcile(pending, undefined, now), 'deleted')
    assert.equal(f.remote.deletes, 1)
    assert.equal(f.remote.events.has(first.eventId), false)
    assert.equal(f.remote.events.has(other.eventId), true)
    assert.equal(f.store.dueCalendarLinks(now).length, 0)
  } finally { f.close() }
})

test('remote completion cannot overwrite a concurrent local cancellation', async () => {
  const f = fixture()
  try {
    const link = f.add('owner', 'sender-a', 'source-a')
    const remote = f.remote
    remote.create = async event => {
      f.store.cancelReminder('owner', 'sender-a', link.reminderId)
      remote.events.set(event.id, event)
      return event
    }
    await f.bridge.reconcile(link, undefined, now)
    assert.equal(f.store.calendarLink('owner', 'sender-a', link.reminderId)?.state, 'delete_pending')
    await f.bridge.reconcile(f.store.calendarLink('owner', 'sender-a', link.reminderId)!, undefined, now)
    assert.equal(remote.events.has(link.eventId), false)
  } finally { f.close() }
})

test('HTTP client uses the primary calendar, a cancellation signal, and no calendar popup updates', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const client = new GoogleCalendarClient(async () => 'synthetic-token', async (url, init) => {
    calls.push({ url: String(url), init: init! })
    return new Response(JSON.stringify({ id: 'elara12345' }), { status: 200 })
  })
  const controller = new AbortController()
  const signal = controller.signal
  await client.create({ id: 'elara12345', summary: 'synthetic plan',
    start: { dateTime: new Date(now).toISOString() } }, signal)
  assert.match(calls[0]!.url, /calendars\/primary\/events\?sendUpdates=none$/)
  assert.ok(calls[0]!.init.signal instanceof AbortSignal)
  controller.abort()
  assert.equal(calls[0]!.init.signal.aborted, true)
  const body = JSON.parse(String(calls[0]!.init.body))
  assert.equal(body.summary, 'synthetic plan')
  assert.equal(body.reminders.useDefault, false)
  assert.equal(Date.parse(body.end.dateTime) - Date.parse(body.start.dateTime), 30 * 60_000)
})

test('local OAuth uses PKCE, a matching callback state, and stores only synthetic token data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-calendar-oauth-'))
  try {
    fs.mkdirSync(path.join(root, '.runtime'))
    fs.writeFileSync(path.join(root, '.runtime', 'google-calendar-client.json'), JSON.stringify({ installed: {
      client_id: 'synthetic.apps.googleusercontent.com', client_secret: 'synthetic-client-secret',
    } }))
    let saved: unknown
    let tokenRequest: URLSearchParams | undefined
    const auth = new CalendarAuth(root, async (_url, init) => {
      tokenRequest = init?.body as URLSearchParams
      return new Response(JSON.stringify({ access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh', expires_in: 3600 }), { status: 200 })
    })
    ;(auth as any).save = async (token: unknown) => { saved = token }
    await auth.connect(url => {
      const authorization = new URL(url)
      const query = authorization.searchParams
      assert.equal(query.get('scope'), 'https://www.googleapis.com/auth/calendar.events')
      assert.equal(query.get('code_challenge_method'), 'S256')
      assert.equal(query.get('access_type'), 'offline')
      const callback = new URL(query.get('redirect_uri')!)
      callback.searchParams.set('state', query.get('state')!)
      callback.searchParams.set('code', 'synthetic-code')
      queueMicrotask(() => { void fetch(callback).catch(() => undefined) })
    })
    assert.equal(tokenRequest?.get('code'), 'synthetic-code')
    assert.ok(tokenRequest?.get('code_verifier'))
    assert.deepEqual(saved, { refresh_token: 'synthetic-refresh', access_token: 'synthetic-access',
      expires_at: (saved as { expires_at: number }).expires_at })
    assert.ok((saved as { expires_at: number }).expires_at > Date.now())
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Windows DPAPI keeps the synthetic refresh token encrypted across process-style reloads',
  { skip: process.platform !== 'win32' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-calendar-dpapi-'))
    try {
      fs.mkdirSync(path.join(root, '.runtime'))
      fs.mkdirSync(path.join(root, 'scripts'))
      fs.copyFileSync(path.resolve(import.meta.dirname, '../../scripts/calendar-dpapi.ps1'),
        path.join(root, 'scripts', 'calendar-dpapi.ps1'))
      fs.writeFileSync(path.join(root, '.runtime', 'google-calendar-client.json'), JSON.stringify({ installed: {
        client_id: 'synthetic.apps.googleusercontent.com',
      } }))
      const auth = new CalendarAuth(root)
      await (auth as any).save({ refresh_token: 'SYNTHETIC_REFRESH_SECRET',
        access_token: 'SYNTHETIC_ACCESS_SECRET', expires_at: Date.now() + 3_600_000 })
      const encrypted = fs.readFileSync(auth.tokenPath, 'utf8')
      assert.doesNotMatch(encrypted, /SYNTHETIC_REFRESH_SECRET|SYNTHETIC_ACCESS_SECRET/)
      const reloaded = new CalendarAuth(root)
      assert.equal(reloaded.configured(), true)
      assert.equal(await reloaded.accessToken(), 'SYNTHETIC_ACCESS_SECRET')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
