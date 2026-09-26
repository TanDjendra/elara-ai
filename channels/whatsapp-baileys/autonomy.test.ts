import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AutonomyStore, commandReminder, inferReminder, nextProactiveDelay,
  nextProactiveKind, nextReminderRepeatDelay, nextReminderTone, reminderMaxSends,
  PROACTIVE_KINDS } from './autonomy.ts'

test('clear Indonesian plans schedule reminders and questions do not', () => {
  const now = new Date(2026, 8, 26, 10, 0, 0)
  const tomorrow = inferReminder('besok jam 8 rapat', now)
  assert.ok(tomorrow)
  assert.equal(new Date(tomorrow.dueAt).getDate(), 27)
  assert.equal(new Date(tomorrow.dueAt).getHours(), 8)
  assert.ok(inferReminder('aku harus rapat besok jam 8', now))
  assert.equal(inferReminder('kapan rapat besok jam 8?', now), undefined)
  assert.equal(inferReminder('temanku rapat besok jam 8', now), undefined)
  assert.equal(inferReminder('aku capek', now), undefined)
  assert.equal(inferReminder('aku rapat kemarin jam 8', now), undefined)
  assert.equal(inferReminder('aku ada rapat besok', now), undefined)
  assert.equal(inferReminder('jangan ingetin aku besok jam 8', now), undefined)
  assert.equal(inferReminder('ingatkan aku besok jam 8 atau jam 9', now), undefined)
  assert.equal(inferReminder('ingetin aku 30 menit lagi minum air', now)?.dueAt,
    now.getTime() + 30 * 60_000)
  assert.equal(new Date(inferReminder('Senin jam 8 rapat', now)!.dueAt).getDay(), 1)
  assert.equal(new Date(inferReminder('tanggal 1 November jam 8 ujian', now)!.dueAt).getMonth(), 10)
  assert.equal(commandReminder('10m mandi dulu ya', now)?.dueAt, now.getTime() + 10 * 60_000)
  assert.equal(commandReminder('25:99 salah', now), undefined)
})

test('reminders survive restart, stay sender-scoped, and settle once per claim', () => {
  assert.equal(nextReminderRepeatDelay(() => 0), 60_000)
  assert.ok(nextReminderRepeatDelay(() => 0.999) < 5 * 60_000)
  assert.equal(reminderMaxSends(() => 0), 3)
  assert.equal(reminderMaxSends(() => 0.999), 7)
  assert.notEqual(nextReminderTone(2, 'kesal ringan', () => 0.75), 'kesal ringan')
  assert.notEqual(nextReminderTone(0, '', () => 0), 'kesal ringan')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-autonomy-test-'))
  const file = path.join(root, 'autonomy.db')
  const now = 1_800_000_000_000
  try {
    let store = new AutonomyStore(file)
    const id = store.addReminder('owner', 'sender-a', 'message-1',
      { dueAt: now + 1_000, text: 'synthetic reminder' }, now, () => 0)
    assert.equal(store.addReminder('owner', 'sender-a', 'message-1',
      { dueAt: now + 1_000, text: 'synthetic reminder' }, now), id)
    assert.equal(store.pendingReminders('other', 'sender-a').length, 0)
    assert.equal(store.pendingReminders('owner', 'sender-b').length, 0)
    assert.equal(store.cancelReminder('other', 'sender-a', id), false)
    store.close()

    store = new AutonomyStore(file)
    assert.equal(store.pendingReminders('owner', 'sender-a').length, 1)
    assert.equal(store.takeDueReminder(now), undefined)
    assert.equal(store.takeDueReminder(now + 1_000)?.id, id)
    assert.equal(store.takeDueReminder(now + 1_000), undefined)
    assert.equal(store.setReminderTone('other', 'sender-a', id, 'pasrah lucu'), false)
    assert.equal(store.setReminderTone('owner', 'sender-a', id, 'pasrah lucu'), true)
    assert.equal(store.isReminderSending('owner', 'sender-a', id), true)
    store.settleReminder(id, true, now + 1_001, () => 0)
    assert.equal(store.pendingReminders('owner', 'sender-a')[0]?.repeatCount, 1)
    assert.equal(store.pendingReminders('owner', 'sender-a')[0]?.scheduledAt, now + 1_000)
    assert.equal(store.pendingReminders('owner', 'sender-a')[0]?.lastTone, 'pasrah lucu')
    assert.equal(store.nextReminderAt(), now + 61_001)
    assert.equal(store.acknowledgeReminders('other', 'sender-a'), 0)
    assert.equal(store.acknowledgeReminders('owner', 'sender-b'), 0)
    assert.equal(store.acknowledgeReminders('owner', 'sender-a'), 1)
    assert.equal(store.isReminderSending('owner', 'sender-a', id), false)
    assert.equal(store.pendingReminders('owner', 'sender-a').length, 0)
    store.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('reminder follow-ups stop at the chosen limit without a reply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-reminder-repeat-'))
  try {
    const store = new AutonomyStore(path.join(root, 'autonomy.db'))
    const now = 1_800_000_000_000
    const id = store.addReminder('owner', 'sender', 'source',
      { dueAt: now + 1_000, text: 'minum air' }, now, () => 0)
    let due = now + 1_000
    for (let count = 0; count < 3; count++) {
      assert.equal(store.takeDueReminder(due)?.id, id)
      store.settleReminder(id, true, due, () => 0)
      due += 60_000
    }
    assert.equal(store.pendingReminders('owner', 'sender').length, 0)
    assert.equal(store.nextReminderAt(), undefined)
    assert.equal(store.db.prepare('SELECT status, repeat_count FROM whatsapp_reminders WHERE id = ?')
      .get(id).status, 'sent')
    store.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('legacy reminder rows migrate without changing their due time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-reminder-migration-'))
  const file = path.join(root, 'autonomy.db')
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE whatsapp_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL,
      sender_key TEXT NOT NULL, source_id TEXT NOT NULL, due_at INTEGER NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, sent_at INTEGER,
      UNIQUE(sender_key, source_id))`)
    legacy.prepare("INSERT INTO whatsapp_reminders (principal_id, sender_key, source_id, due_at, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run('owner', 'sender', 'source', 10_000, 'legacy plan', 1_000)
    legacy.close()
    const store = new AutonomyStore(file)
    const row = store.pendingReminders('owner', 'sender')[0]
    assert.equal(row?.scheduledAt, 10_000)
    assert.equal(row?.repeatCount, 0)
    assert.equal(row?.maxSends, 5)
    assert.equal(row?.lastTone, '')
    store.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('proactive schedule is random, restart-safe, and owner-controlled', () => {
  assert.equal(nextProactiveDelay(() => 0), 4 * 3_600_000)
  assert.ok(nextProactiveDelay(() => 0.99) < 18 * 3_600_000)
  for (const previous of PROACTIVE_KINDS) {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
      const next = nextProactiveKind(previous, () => random)
      assert.ok(PROACTIVE_KINDS.includes(next))
      assert.notEqual(next, previous)
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-proactive-test-'))
  try {
    const file = path.join(root, 'autonomy.db')
    let store = new AutonomyStore(file)
    store.ensureProactive('owner', 'sender-a', 1_000, () => 0)
    assert.equal(store.proactive('owner', 'sender-a')?.nextAt, 1_000 + 4 * 3_600_000)
    store.advanceProactive('owner', 'sender-a', 'curiosity', 1_500, () => 0)
    assert.equal(store.proactive('owner', 'sender-a')?.lastKind, 'curiosity')
    store.touchOwner('owner', 'sender-a', 2_000, () => 0.5)
    assert.equal(store.proactive('owner', 'sender-a')?.lastUserAt, 2_000)
    store.setProactive('owner', 'sender-a', false, 3_000, () => 0)
    assert.equal(store.nextProactiveAt(), undefined)
    store.close()
    store = new AutonomyStore(file)
    store.ensureProactive('owner', 'sender-a', 4_000, () => 0)
    assert.equal(store.proactive('owner', 'sender-a')?.enabled, 0)
    assert.equal(store.proactive('owner', 'sender-a')?.lastKind, 'curiosity')
    store.setProactive('owner', 'sender-a', true, 5_000, () => 0)
    assert.equal(store.proactive('owner', 'sender-a')?.enabled, 1)
    store.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('existing proactive schedule receives the additive kind column', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-proactive-migration-'))
  const file = path.join(root, 'autonomy.db')
  try {
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE whatsapp_proactive (
      sender_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL, enabled INTEGER NOT NULL,
      next_at INTEGER NOT NULL, last_user_at INTEGER NOT NULL DEFAULT 0)`)
    legacy.prepare('INSERT INTO whatsapp_proactive VALUES (?, ?, ?, ?, ?)')
      .run('sender-a', 'owner', 1, 10_000, 3_000)
    legacy.close()
    const store = new AutonomyStore(file)
    assert.equal(store.proactive('owner', 'sender-a')?.nextAt, 10_000)
    assert.equal(store.proactive('owner', 'sender-a')?.lastKind, '')
    store.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
