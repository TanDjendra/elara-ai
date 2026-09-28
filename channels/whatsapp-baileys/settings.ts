import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseEmotionMode, type EmotionMode } from './emotion.ts'
import { parseTypingSpeed, type TypingSpeed } from './typing.ts'

type UserPreferences = { emotion?: EmotionMode; typing?: TypingSpeed }

export class WhatsAppSettings {
  private users: Record<string, UserPreferences> = {}

  constructor(private readonly filePath: string, private readonly defaultTyping: TypingSpeed) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const record = parsed as Record<string, unknown>
      if (record.version === 2 && record.users && typeof record.users === 'object' && !Array.isArray(record.users)) {
        for (const [key, raw] of Object.entries(record.users)) {
          if (!isUserKey(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
          const values = raw as Record<string, unknown>
          const emotion = parseEmotionMode(String(values.emotion))
          const typing = validTyping(values.typing)
          if (emotion !== undefined || typing) this.users[key] = { emotion, typing }
        }
      } else {
        // Existing installations stored a flat map of hashed sender keys to emotion modes.
        for (const [key, raw] of Object.entries(record)) {
          if (!isUserKey(key)) continue
          const emotion = parseEmotionMode(String(raw))
          if (emotion !== undefined) this.users[key] = { emotion }
        }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.warn('[ELARA] WhatsApp preferences were unreadable; using defaults')
    }
  }

  emotion(key: string): EmotionMode { return this.users[key]?.emotion ?? 'auto' }
  typing(key: string): TypingSpeed { return this.users[key]?.typing ?? this.defaultTyping }

  setEmotion(key: string, value: EmotionMode): void { this.save(key, { emotion: value }) }
  setTyping(key: string, value: TypingSpeed): void { this.save(key, { typing: value }) }

  private save(key: string, patch: UserPreferences): void {
    if (!isUserKey(key)) throw new Error('INVALID_SETTINGS_KEY')
    const next = { ...this.users, [key]: { ...this.users[key], ...patch } }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 2, users: next }, null, 2),
        { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
      this.users = next
    } finally {
      try { fs.unlinkSync(temporary) } catch { /* Already renamed or no temporary file. */ }
    }
  }
}

function isUserKey(value: string): boolean { return /^[a-f0-9]{24}$/.test(value) }

export function validTyping(value: unknown): TypingSpeed | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return normalized === 'instant' || normalized === 'fast' || normalized === 'natural' || normalized === 'slow'
    ? parseTypingSpeed(normalized) : undefined
}
