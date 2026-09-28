import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_REMINDER_MS = 366 * 86_400_000
const MIN_PROACTIVE_MS = 4 * 3_600_000
const MAX_PROACTIVE_MS = 18 * 3_600_000
const MIN_REMINDER_REPEAT_MS = 60_000
const MAX_REMINDER_REPEAT_MS = 5 * 60_000

export const PROACTIVE_KINDS = ['followup', 'curiosity', 'playful', 'thought', 'checkin'] as const
export type ProactiveKind = typeof PROACTIVE_KINDS[number]

export function nextProactiveKind(previous = '', random = Math.random): ProactiveKind {
  const choices = PROACTIVE_KINDS.filter(kind => kind !== previous)
  return choices[Math.floor(Math.max(0, Math.min(0.999999, random())) * choices.length)]!
}

export interface ReminderDraft { dueAt: number; text: string }
export interface ReminderRow extends ReminderDraft {
  id: number
  principalId: string
  senderKey: string
  sourceId: string
  scheduledAt: number
  repeatCount: number
  maxSends: number
  lastTone: string
}

export interface CalendarLink {
  reminderId: number
  principalId: string
  senderKey: string
  eventId: string
  state: 'pending' | 'linked' | 'delete_pending' | 'deleted'
  nextCheckAt: number
}

export const REMINDER_TONES = ['lembut', 'santai', 'penasaran', 'gemas', 'kesal ringan', 'pasrah lucu', 'tegas'] as const
export type ReminderTone = typeof REMINDER_TONES[number]

export function nextReminderTone(repeatCount: number, previous = '', random = Math.random): ReminderTone {
  const available = repeatCount === 0
    ? REMINDER_TONES.filter(tone => ['lembut', 'santai', 'penasaran'].includes(tone))
    : repeatCount === 1
      ? REMINDER_TONES.filter(tone => !['kesal ringan', 'pasrah lucu'].includes(tone))
      : [...REMINDER_TONES]
  const choices = available.filter(tone => tone !== previous)
  return choices[Math.floor(Math.max(0, Math.min(0.999999, random())) * choices.length)]!
}

export function nextReminderRepeatDelay(random = Math.random): number {
  return MIN_REMINDER_REPEAT_MS + Math.floor(Math.max(0, Math.min(0.999999, random()))
    * (MAX_REMINDER_REPEAT_MS - MIN_REMINDER_REPEAT_MS))
}

export function reminderMaxSends(random = Math.random): number {
  return 3 + Math.floor(Math.max(0, Math.min(0.999999, random())) * 5)
}

export interface ProactiveRow {
  principalId: string
  senderKey: string
  enabled: number
  nextAt: number
  lastUserAt: number
  lastKind: string
}

export function nextProactiveDelay(random = Math.random): number {
  return MIN_PROACTIVE_MS + Math.floor(Math.max(0, Math.min(0.999999, random()))
    * (MAX_PROACTIVE_MS - MIN_PROACTIVE_MS))
}

function clockTime(text: string): { hours: number; minutes: number } | undefined {
  const match = text.match(/\b(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{1,2}))?\s*(pagi|siang|sore|malam)?\b/iu)
  if (!match) return undefined
  let hours = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  if (hours > 23 || minutes > 59) return undefined
  const period = match[3]?.toLocaleLowerCase('id-ID')
  if (period) {
    if (hours < 1 || hours > 12) return undefined
    if (period === 'pagi') hours = hours === 12 ? 0 : hours
    else if (period === 'siang') {
      if (hours !== 11 && hours !== 12 && hours > 3) return undefined
      if (hours <= 3) hours += 12
    } else if (period === 'sore' || period === 'malam') hours = hours === 12 ? 12 : hours + 12
  }
  return { hours, minutes }
}

function validDue(dueAt: number, now: Date): boolean {
  return Number.isSafeInteger(dueAt) && dueAt > now.getTime() && dueAt - now.getTime() <= MAX_REMINDER_MS
}

function relativeDue(text: string, now: Date): number | undefined {
  const match = text.match(/\b(?:dalam\s+)?(\d{1,4})\s*(detik|menit|jam|hari)\s*(?:lagi|ke depan)?\b/iu)
  if (!match) return undefined
  const unit = match[2]!.toLocaleLowerCase('id-ID')
  const factor = unit === 'detik' ? 1000 : unit === 'menit' ? 60_000
    : unit === 'jam' ? 3_600_000 : 86_400_000
  const dueAt = now.getTime() + Number(match[1]) * factor
  return validDue(dueAt, now) ? dueAt : undefined
}

function dateDue(text: string, now: Date): number | undefined {
  const time = clockTime(text)
  if (!time) return undefined
  const due = new Date(now)
  const lower = text.toLocaleLowerCase('id-ID')
  const relativeDay = /\blusa\b/u.test(lower) ? 2 : /\bbesok\b/u.test(lower) ? 1 : 0
  const namedMonths = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli',
    'agustus', 'september', 'oktober', 'november', 'desember']
  const dateMatch = lower.match(/\btanggal\s+(\d{1,2})(?:\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember))?\b/u)
  const weekdays = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu']
  const weekday = lower.match(/\b(senin|selasa|rabu|kamis|jumat|sabtu|minggu)\b/u)
  if (relativeDay) due.setDate(due.getDate() + relativeDay)
  else if (dateMatch) {
    const day = Number(dateMatch[1])
    const namedMonth = dateMatch[2] ? namedMonths.indexOf(dateMatch[2]) : undefined
    due.setDate(1)
    if (namedMonth !== undefined) due.setMonth(namedMonth)
    due.setDate(day)
    if (due.getDate() !== day || namedMonth !== undefined && due.getMonth() !== namedMonth) return undefined
  } else if (weekday) {
    const target = weekdays.indexOf(weekday[1])
    due.setDate(due.getDate() + (target - due.getDay() + 7) % 7)
  }
  due.setHours(time.hours, time.minutes, 0, 0)
  if (due.getTime() <= now.getTime()) {
    if (relativeDay) return undefined
    if (dateMatch) {
      if (dateMatch[2]) due.setFullYear(due.getFullYear() + 1)
      else due.setMonth(due.getMonth() + 1)
      if (due.getDate() !== Number(dateMatch[1])) return undefined
    } else if (weekday) due.setDate(due.getDate() + 7)
    else due.setDate(due.getDate() + 1)
  }
  return validDue(due.getTime(), now) ? due.getTime() : undefined
}

function dueFromText(text: string, now: Date): number | undefined {
  return relativeDue(text, now) ?? dateDue(text, now)
}

export function inferReminder(text: string, now = new Date()): ReminderDraft | undefined {
  const message = text.trim()
  if (!message || message.length > 600 || /\b(kemarin|tadi pagi|tadi malam)\b/iu.test(message)
    || /\b(jangan|nggak|tidak|ga)\s+(?:usah\s+)?(?:ingatkan|ingetin)\b/iu.test(message)) return undefined
  if ([...message.matchAll(/\b(?:jam|pukul)\s*\d{1,2}(?:[.:]\d{1,2})?/giu)].length > 1) return undefined
  const explicit = /\b(ingatkan|ingetin|remind|jangan lupa)\b/iu.test(message)
  const plan = /\b(?:aku|saya|gue|gw|kita)\s+(?:harus|mau|akan|bakal|ada|punya|perlu|jadwal)\b/iu.test(message)
    || /^(?:besok|lusa|hari ini|nanti|tanggal|senin|selasa|rabu|kamis|jumat|sabtu|minggu|ada|rapat|meeting|janji|ujian|kelas|deadline|jemput|berangkat|kontrol)\b/iu.test(message)
  if (!explicit && (!plan || /[?？]|\b(kapan|jam berapa|apa|kenapa)\b/iu.test(message))) return undefined
  const dueAt = dueFromText(message, now)
  if (!dueAt) return undefined
  const description = message.replace(/^(?:tolong\s+)?(?:ingatkan|ingetin)\s+(?:aku|saya)\s*/iu, '')
    .trim().slice(0, 500)
  return { dueAt, text: description || message.slice(0, 500) }
}

export function commandReminder(argument: string, now = new Date()): ReminderDraft | undefined {
  const [raw, ...parts] = argument.trim().split(/\s+/u)
  if (!raw) return undefined
  let dueAt: number | undefined
  const relative = raw.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/iu)
  if (relative) {
    const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd']
    dueAt = now.getTime() + Number(relative[1]) * factor
  } else if (/^\d+(?:\.\d+)?$/u.test(raw)) dueAt = now.getTime() + Number(raw) * 60_000
  else if (/^\d{1,2}:\d{2}$/u.test(raw)) dueAt = dateDue(`jam ${raw}`, now)
  if (!dueAt || !validDue(dueAt, now)) return undefined
  return { dueAt, text: parts.join(' ').trim().slice(0, 500) || 'Pengingat dari ELARA' }
}

export class AutonomyStore {
  readonly db: DatabaseSync

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principal_id TEXT NOT NULL,
        sender_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        scheduled_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        repeat_count INTEGER NOT NULL DEFAULT 0,
        max_sends INTEGER NOT NULL DEFAULT 5,
        last_tone TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        UNIQUE(sender_key, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_whatsapp_reminders_due ON whatsapp_reminders(status, due_at);
      CREATE TABLE IF NOT EXISTS whatsapp_proactive (
        sender_key TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        next_at INTEGER NOT NULL,
        last_user_at INTEGER NOT NULL DEFAULT 0,
        last_kind TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS whatsapp_calendar_links (
        reminder_id INTEGER PRIMARY KEY,
        principal_id TEXT NOT NULL,
        sender_key TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('pending','linked','delete_pending','deleted')),
        next_check_at INTEGER NOT NULL,
        FOREIGN KEY(reminder_id) REFERENCES whatsapp_reminders(id)
      );
      CREATE INDEX IF NOT EXISTS idx_whatsapp_calendar_due ON whatsapp_calendar_links(state, next_check_at);
    `)
    const columns = this.db.prepare('PRAGMA table_info(whatsapp_proactive)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'last_kind')) {
      this.db.exec("ALTER TABLE whatsapp_proactive ADD COLUMN last_kind TEXT NOT NULL DEFAULT ''")
    }
    const reminderColumns = this.db.prepare('PRAGMA table_info(whatsapp_reminders)').all() as { name: string }[]
    if (!reminderColumns.some(column => column.name === 'scheduled_at')) {
      this.db.exec('ALTER TABLE whatsapp_reminders ADD COLUMN scheduled_at INTEGER NOT NULL DEFAULT 0')
      this.db.exec('UPDATE whatsapp_reminders SET scheduled_at = due_at WHERE scheduled_at = 0')
    }
    if (!reminderColumns.some(column => column.name === 'repeat_count')) {
      this.db.exec('ALTER TABLE whatsapp_reminders ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 0')
    }
    if (!reminderColumns.some(column => column.name === 'max_sends')) {
      this.db.exec('ALTER TABLE whatsapp_reminders ADD COLUMN max_sends INTEGER NOT NULL DEFAULT 5')
    }
    if (!reminderColumns.some(column => column.name === 'last_tone')) {
      this.db.exec("ALTER TABLE whatsapp_reminders ADD COLUMN last_tone TEXT NOT NULL DEFAULT ''")
    }
    // A send may have completed before a crash. Retrying favors delivery;
    // WhatsApp transport cannot provide exactly-once delivery across restart.
    this.db.prepare("UPDATE whatsapp_reminders SET status = 'pending' WHERE status = 'sending'").run()
  }

  addReminder(principalId: string, senderKey: string, sourceId: string, draft: ReminderDraft,
    now = Date.now(), random = Math.random): number {
    if (!validDue(draft.dueAt, new Date(now)) || !draft.text.trim() || draft.text.length > 500) throw new Error('REMINDER_INVALID')
    const existing = this.db.prepare('SELECT id FROM whatsapp_reminders WHERE sender_key = ? AND source_id = ?')
      .get(senderKey, sourceId) as { id: number } | undefined
    if (existing) return existing.id
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM whatsapp_reminders WHERE sender_key = ? AND status IN ('pending', 'sending', 'awaiting')")
      .get(senderKey) as { count: number }
    if (count.count >= 50) throw new Error('REMINDER_LIMIT')
    this.db.prepare(`INSERT OR IGNORE INTO whatsapp_reminders
      (principal_id, sender_key, source_id, due_at, scheduled_at, text, status, created_at, max_sends)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(principalId, senderKey, sourceId, draft.dueAt, draft.dueAt, draft.text, now, reminderMaxSends(random))
    const row = this.db.prepare('SELECT id FROM whatsapp_reminders WHERE sender_key = ? AND source_id = ?')
      .get(senderKey, sourceId) as { id: number }
    return row.id
  }

  pendingReminders(principalId: string, senderKey: string): ReminderRow[] {
    return this.db.prepare(`SELECT id, principal_id AS principalId, sender_key AS senderKey,
      source_id AS sourceId, due_at AS dueAt, scheduled_at AS scheduledAt,
      repeat_count AS repeatCount, max_sends AS maxSends, last_tone AS lastTone,
      text FROM whatsapp_reminders
      WHERE principal_id = ? AND sender_key = ? AND status IN ('pending', 'sending', 'awaiting')
      ORDER BY scheduled_at LIMIT 50`)
      .all(principalId, senderKey) as unknown as ReminderRow[]
  }

  cancelReminder(principalId: string, senderKey: string, id: number): boolean {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE whatsapp_reminders SET status = 'cancelled' WHERE id = ? AND principal_id = ? AND sender_key = ? AND status IN ('pending', 'sending', 'awaiting')")
        .run(id, principalId, senderKey).changes > 0
      if (changed) this.db.prepare("UPDATE whatsapp_calendar_links SET state = 'delete_pending', next_check_at = 0 WHERE reminder_id = ? AND principal_id = ? AND sender_key = ? AND state IN ('pending','linked')")
        .run(id, principalId, senderKey)
      return changed
    })
  }

  linkCalendar(principalId: string, senderKey: string, reminderId: number, eventId: string): void {
    const row = this.db.prepare('SELECT id FROM whatsapp_reminders WHERE id = ? AND principal_id = ? AND sender_key = ?')
      .get(reminderId, principalId, senderKey)
    if (!row || !/^[0-9a-v]{5,1024}$/.test(eventId)) throw new Error('CALENDAR_LINK_INVALID')
    this.db.prepare("INSERT OR IGNORE INTO whatsapp_calendar_links (reminder_id,principal_id,sender_key,event_id,state,next_check_at) VALUES (?,?,?,?, 'pending',0)")
      .run(reminderId, principalId, senderKey, eventId)
  }

  calendarLink(principalId: string, senderKey: string, reminderId: number): CalendarLink | undefined {
    return this.db.prepare(`SELECT reminder_id AS reminderId, principal_id AS principalId,
      sender_key AS senderKey, event_id AS eventId, state, next_check_at AS nextCheckAt
      FROM whatsapp_calendar_links WHERE reminder_id = ? AND principal_id = ? AND sender_key = ?`)
      .get(reminderId, principalId, senderKey) as unknown as CalendarLink | undefined
  }

  dueCalendarLinks(now = Date.now(), limit = 20): CalendarLink[] {
    return this.db.prepare(`SELECT reminder_id AS reminderId, principal_id AS principalId,
      sender_key AS senderKey, event_id AS eventId, state, next_check_at AS nextCheckAt
      FROM whatsapp_calendar_links WHERE state != 'deleted' AND next_check_at <= ?
      ORDER BY next_check_at, reminder_id LIMIT ?`).all(now, limit) as unknown as CalendarLink[]
  }

  nextCalendarAt(): number | undefined {
    const row = this.db.prepare("SELECT MIN(next_check_at) AS at FROM whatsapp_calendar_links WHERE state != 'deleted'").get() as { at: number | null }
    return row.at ?? undefined
  }

  calendarReminder(link: CalendarLink): (ReminderDraft & { status: string }) | undefined {
    return this.db.prepare('SELECT due_at AS dueAt, text, status FROM whatsapp_reminders WHERE id = ? AND principal_id = ? AND sender_key = ?')
      .get(link.reminderId, link.principalId, link.senderKey) as unknown as (ReminderDraft & { status: string }) | undefined
  }

  settleCalendarLink(link: CalendarLink, state: CalendarLink['state'], nextCheckAt: number): void {
    this.db.prepare('UPDATE whatsapp_calendar_links SET state = ?, next_check_at = ? WHERE reminder_id = ? AND principal_id = ? AND sender_key = ? AND state = ?')
      .run(state, nextCheckAt, link.reminderId, link.principalId, link.senderKey, link.state)
  }

  applyCalendarEvent(link: CalendarLink, event: { dueAt: number; text: string } | undefined, now = Date.now()): void {
    this.transaction(() => {
      if (!event) {
        this.db.prepare("UPDATE whatsapp_reminders SET status = 'cancelled' WHERE id = ? AND principal_id = ? AND sender_key = ? AND status IN ('pending','sending','awaiting')")
          .run(link.reminderId, link.principalId, link.senderKey)
        this.settleCalendarLink(link, 'deleted', 0)
        return
      }
      if (!Number.isSafeInteger(event.dueAt) || !event.text.trim()) return
      this.db.prepare(`UPDATE whatsapp_reminders SET due_at = ?, scheduled_at = ?, text = ?,
        status = ?, repeat_count = 0 WHERE id = ? AND principal_id = ? AND sender_key = ?
        AND status IN ('pending','sending','awaiting','sent','acknowledged','calendar_paused')`)
        .run(event.dueAt, event.dueAt, event.text.slice(0, 500),
          event.dueAt <= now ? 'calendar_paused' : 'pending', link.reminderId, link.principalId, link.senderKey)
      this.settleCalendarLink(link, 'linked', now + 5 * 60_000)
    })
  }

  acknowledgeReminders(principalId: string, senderKey: string): number {
    return Number(this.db.prepare("UPDATE whatsapp_reminders SET status = 'acknowledged' WHERE principal_id = ? AND sender_key = ? AND (status = 'awaiting' OR (status = 'sending' AND repeat_count > 0))")
      .run(principalId, senderKey).changes)
  }

  setReminderTone(principalId: string, senderKey: string, id: number, tone: ReminderTone): boolean {
    return this.db.prepare("UPDATE whatsapp_reminders SET last_tone = ? WHERE id = ? AND principal_id = ? AND sender_key = ? AND status = 'sending'")
      .run(tone, id, principalId, senderKey).changes > 0
  }

  isReminderSending(principalId: string, senderKey: string, id: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM whatsapp_reminders WHERE id = ? AND principal_id = ? AND sender_key = ? AND status = 'sending'")
      .get(id, principalId, senderKey)
  }

  nextReminderAt(): number | undefined {
    const row = this.db.prepare("SELECT MIN(due_at) AS at FROM whatsapp_reminders WHERE status IN ('pending', 'awaiting')").get() as { at: number | null }
    return row.at ?? undefined
  }

  takeDueReminder(now = Date.now()): ReminderRow | undefined {
    const row = this.db.prepare(`SELECT id, principal_id AS principalId, sender_key AS senderKey,
      source_id AS sourceId, due_at AS dueAt, scheduled_at AS scheduledAt,
      repeat_count AS repeatCount, max_sends AS maxSends, last_tone AS lastTone,
      text FROM whatsapp_reminders
      WHERE status IN ('pending', 'awaiting') AND due_at <= ? ORDER BY due_at LIMIT 1`).get(now) as unknown as ReminderRow | undefined
    if (!row) return undefined
    const changed = this.db.prepare("UPDATE whatsapp_reminders SET status = 'sending' WHERE id = ? AND status IN ('pending', 'awaiting')").run(row.id)
    return changed.changes ? row : undefined
  }

  settleReminder(id: number, sent: boolean, now = Date.now(), random = Math.random): void {
    if (sent) this.db.prepare("UPDATE whatsapp_reminders SET status = CASE WHEN repeat_count + 1 >= max_sends THEN 'sent' ELSE 'awaiting' END, sent_at = ?, due_at = ?, repeat_count = repeat_count + 1 WHERE id = ? AND status = 'sending'")
      .run(now, now + nextReminderRepeatDelay(random), id)
    else this.db.prepare("UPDATE whatsapp_reminders SET status = 'pending', due_at = ? WHERE id = ? AND status = 'sending'")
      .run(now + 60_000, id)
  }

  discardReminder(id: number): void {
    this.db.prepare("UPDATE whatsapp_reminders SET status = 'cancelled' WHERE id = ? AND status = 'sending'").run(id)
  }

  ensureProactive(principalId: string, senderKey: string, now = Date.now(), random = Math.random): void {
    this.db.prepare(`INSERT OR IGNORE INTO whatsapp_proactive
      (sender_key, principal_id, enabled, next_at, last_user_at) VALUES (?, ?, 1, ?, 0)`)
      .run(senderKey, principalId, now + nextProactiveDelay(random))
  }

  proactive(principalId: string, senderKey: string): ProactiveRow | undefined {
    return this.db.prepare(`SELECT principal_id AS principalId, sender_key AS senderKey,
      enabled, next_at AS nextAt, last_user_at AS lastUserAt, last_kind AS lastKind FROM whatsapp_proactive
      WHERE principal_id = ? AND sender_key = ?`).get(principalId, senderKey) as unknown as ProactiveRow | undefined
  }

  setProactive(principalId: string, senderKey: string, enabled: boolean, now = Date.now(), random = Math.random): void {
    this.ensureProactive(principalId, senderKey, now, random)
    this.db.prepare('UPDATE whatsapp_proactive SET enabled = ?, next_at = ? WHERE principal_id = ? AND sender_key = ?')
      .run(enabled ? 1 : 0, now + nextProactiveDelay(random), principalId, senderKey)
  }

  touchOwner(principalId: string, senderKey: string, now = Date.now(), random = Math.random): void {
    this.ensureProactive(principalId, senderKey, now, random)
    this.db.prepare('UPDATE whatsapp_proactive SET last_user_at = ?, next_at = ? WHERE principal_id = ? AND sender_key = ?')
      .run(now, now + nextProactiveDelay(random), principalId, senderKey)
  }

  nextProactiveAt(): number | undefined {
    const row = this.db.prepare('SELECT MIN(next_at) AS at FROM whatsapp_proactive WHERE enabled = 1').get() as { at: number | null }
    return row.at ?? undefined
  }

  dueProactive(now = Date.now()): ProactiveRow | undefined {
    return this.db.prepare(`SELECT principal_id AS principalId, sender_key AS senderKey,
      enabled, next_at AS nextAt, last_user_at AS lastUserAt, last_kind AS lastKind FROM whatsapp_proactive
      WHERE enabled = 1 AND next_at <= ? ORDER BY next_at LIMIT 1`).get(now) as unknown as ProactiveRow | undefined
  }

  advanceProactive(principalId: string, senderKey: string, kind: ProactiveKind,
    now = Date.now(), random = Math.random): void {
    this.db.prepare('UPDATE whatsapp_proactive SET next_at = ?, last_kind = ? WHERE principal_id = ? AND sender_key = ? AND enabled = 1')
      .run(now + nextProactiveDelay(random), kind, principalId, senderKey)
  }

  close(): void { this.db.close() }
}
