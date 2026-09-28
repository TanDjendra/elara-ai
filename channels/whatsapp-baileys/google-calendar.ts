import { createHash } from 'node:crypto'
import type { AutonomyStore, CalendarLink } from './autonomy.ts'

export interface CalendarEvent { id: string; summary?: string; start?: { dateTime?: string; date?: string }; status?: string }
export interface CalendarTransport {
  create(event: CalendarEvent, signal?: AbortSignal): Promise<CalendarEvent>
  get(id: string, signal?: AbortSignal): Promise<CalendarEvent | undefined>
  delete(id: string, signal?: AbortSignal): Promise<void>
}

export class CalendarHttpError extends Error {
  constructor(readonly status: number) { super(`CALENDAR_HTTP_${status}`) }
}

// Google permits lowercase base32hex IDs. A SHA-256 hex digest is a subset of that alphabet.
export function calendarEventId(principalId: string, senderKey: string, sourceId: string): string {
  return `elara${createHash('sha256').update(JSON.stringify([principalId, senderKey, sourceId])).digest('hex')}`
}

export class GoogleCalendarClient implements CalendarTransport {
  constructor(private readonly accessToken: (signal?: AbortSignal) => Promise<string>,
    private readonly fetcher: typeof fetch = fetch) {}

  private async request(method: string, id: string | undefined, body: object | undefined,
    signal?: AbortSignal): Promise<CalendarEvent | undefined> {
    if (signal?.aborted) throw new Error('CALENDAR_ABORTED')
    const token = await this.accessToken(signal)
    if (signal?.aborted) throw new Error('CALENDAR_ABORTED')
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events${id ? `/${encodeURIComponent(id)}` : ''}?sendUpdates=none`
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    const response = await this.fetcher(url, { method, signal: requestSignal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined })
    if (response.status === 404 || response.status === 410) return undefined
    if (!response.ok) throw new CalendarHttpError(response.status)
    if (method === 'DELETE') return undefined
    const event = await response.json() as CalendarEvent
    if (!event || typeof event.id !== 'string') throw new Error('CALENDAR_RESPONSE_INVALID')
    return event
  }

  async create(event: CalendarEvent, signal?: AbortSignal): Promise<CalendarEvent> {
    const dueAt = Date.parse(event.start?.dateTime ?? '')
    if (!/^[0-9a-v]{5,1024}$/.test(event.id) || !Number.isFinite(dueAt)) throw new Error('CALENDAR_EVENT_INVALID')
    const result = await this.request('POST', undefined, {
      id: event.id, summary: event.summary?.slice(0, 500),
      start: { dateTime: new Date(dueAt).toISOString() },
      end: { dateTime: new Date(dueAt + 30 * 60_000).toISOString() },
      reminders: { useDefault: false },
    }, signal)
    if (!result) throw new Error('CALENDAR_CREATE_UNCONFIRMED')
    return result
  }
  get(id: string, signal?: AbortSignal): Promise<CalendarEvent | undefined> {
    return this.request('GET', id, undefined, signal)
  }
  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.request('DELETE', id, undefined, signal)
  }
}

export class CalendarBridge {
  constructor(readonly store: AutonomyStore, readonly remote: CalendarTransport) {}

  async reconcile(link: CalendarLink, signal?: AbortSignal, now = Date.now()): Promise<'created' | 'updated' | 'deleted' | 'unchanged'> {
    const latest = this.store.calendarLink(link.principalId, link.senderKey, link.reminderId)
    if (!latest || latest.eventId !== link.eventId || latest.state === 'deleted') return 'unchanged'
    const reminder = this.store.calendarReminder(latest)
    if (!reminder) return 'unchanged'
    if (latest.state === 'delete_pending' || reminder.status === 'cancelled') {
      if (latest.state !== 'pending') await this.remote.delete(latest.eventId, signal)
      this.store.settleCalendarLink(latest, 'deleted', 0)
      return 'deleted'
    }
    if (latest.state === 'pending') {
      if (reminder.dueAt <= now) {
        const existing = await this.remote.get(latest.eventId, signal)
        if (existing) { this.applyRemote(latest, existing, now); return 'updated' }
        this.store.settleCalendarLink(latest, 'deleted', 0)
        return 'deleted'
      }
      const event = { id: latest.eventId, summary: reminder.text,
        start: { dateTime: new Date(reminder.dueAt).toISOString() } }
      try { await this.remote.create(event, signal) }
      catch (error) {
        if (!(error instanceof CalendarHttpError) || error.status !== 409) throw error
        const existing = await this.remote.get(latest.eventId, signal)
        if (!existing) throw new Error('CALENDAR_CREATE_UNCONFIRMED')
        this.applyRemote(latest, existing, now)
        return 'updated'
      }
      this.store.settleCalendarLink(latest, 'linked', now + 5 * 60_000)
      return 'created'
    }
    const event = await this.remote.get(latest.eventId, signal)
    if (!event || event.status === 'cancelled') {
      this.store.applyCalendarEvent(latest, undefined, now)
      return 'deleted'
    }
    const dueAt = Date.parse(event.start?.dateTime ?? '')
    const text = typeof event.summary === 'string' ? event.summary.trim().slice(0, 500) : ''
    if (!Number.isSafeInteger(dueAt) || !text) {
      this.store.settleCalendarLink(latest, 'linked', now + 5 * 60_000)
      return 'unchanged'
    }
    if (dueAt !== reminder.dueAt || text !== reminder.text) {
      this.store.applyCalendarEvent(latest, { dueAt, text }, now)
      return 'updated'
    }
    this.store.settleCalendarLink(latest, 'linked', now + 5 * 60_000)
    return 'unchanged'
  }

  private applyRemote(link: CalendarLink, event: CalendarEvent, now: number): void {
    if (event.status === 'cancelled') { this.store.applyCalendarEvent(link, undefined, now); return }
    const dueAt = Date.parse(event.start?.dateTime ?? '')
    const text = typeof event.summary === 'string' ? event.summary.trim().slice(0, 500) : ''
    if (Number.isSafeInteger(dueAt) && text) this.store.applyCalendarEvent(link, { dueAt, text }, now)
    else this.store.settleCalendarLink(link, 'linked', now + 5 * 60_000)
  }
}
