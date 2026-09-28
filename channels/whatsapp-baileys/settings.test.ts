import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WhatsAppSettings, validTyping } from './settings.ts'

test('settings migrate legacy emotion preferences and persist typed values without sender aliases', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-settings-'))
  try {
    const file = path.join(directory, 'preferences.json')
    const alias = '628123456789@s.whatsapp.net'
    const key = crypto.createHash('sha256').update(alias).digest('hex').slice(0, 24)
    fs.writeFileSync(file, JSON.stringify({ [key]: 3, ignored: 'not-a-setting' }))
    const settings = new WhatsAppSettings(file, 'natural')
    assert.equal(settings.emotion(key), 3)
    assert.equal(settings.typing(key), 'natural')
    settings.setTyping(key, 'fast')
    settings.setEmotion(key, 'auto')
    const saved = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(saved, /628123456789|ignored/)
    assert.deepEqual(JSON.parse(saved), { version: 2, users: { [key]: { emotion: 'auto', typing: 'fast' } } })
    const reloaded = new WhatsAppSettings(file, 'slow')
    assert.equal(reloaded.emotion(key), 'auto')
    assert.equal(reloaded.typing(key), 'fast')
    assert.equal(validTyping('FAST'), 'fast')
    assert.equal(validTyping('fast; command'), undefined)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
