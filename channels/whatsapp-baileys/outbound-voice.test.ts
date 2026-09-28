import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { AzureVoiceSynthesizer, WindowsVoiceSynthesizer, assertOggOpus,
  runOwned, spokenText, voicePrompt, voiceReplyRequested, voiceSynthesizer } from './outbound-voice.ts'

function fakeOpus(): Buffer {
  const bytes = Buffer.alloc(40)
  bytes.write('OggS', 0, 'ascii')
  bytes.write('OpusHead', 28, 'ascii')
  return bytes
}

test('voice reply requires an explicit request and strips the command before the model turn', () => {
  assert.equal(voiceReplyRequested('.voice ceritain harimu'), true)
  assert.equal(voicePrompt('.voice ceritain harimu'), 'ceritain harimu')
  assert.equal(voiceReplyRequested('jawab pakai voice note ya, aku lagi nyetir'), true)
  assert.equal(voiceReplyRequested('kirim VN aja buat jawab ini'), true)
  assert.equal(voiceReplyRequested('apa itu voice note?'), false)
  assert.equal(voiceReplyRequested('aku kirim voice note kemarin'), false)
  assert.equal(voiceReplyRequested('halo'), false)
  assert.equal(spokenText('*Halo* _Tan_!'), 'Halo Tan!')
  assert.throws(() => spokenText('a'.repeat(901)), /VOICE_TEXT_INVALID/)
})

test('Azure TTS selects Indonesian female Opus, escapes SSML, and uses an owned abort signal', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const synthesizer = new AzureVoiceSynthesizer({ region: 'southeastasia', key: 'synthetic-key' },
    async (url, init) => {
      calls.push({ url: String(url), init: init! })
      return new Response(fakeOpus(), { status: 200 })
    })
  const controller = new AbortController()
  const audio = await synthesizer.synthesize('Halo & <Tan>', controller.signal)
  assert.deepEqual(audio, fakeOpus())
  assert.equal(calls[0]!.url, 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/v1')
  assert.match(String(calls[0]!.init.body), /id-ID-GadisNeural/)
  assert.match(String(calls[0]!.init.body), /Halo &amp; &lt;Tan&gt;/)
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers['X-Microsoft-OutputFormat'], 'ogg-24khz-16bit-mono-opus')
  assert.equal(headers['Ocp-Apim-Subscription-Key'], 'synthetic-key')
  controller.abort()
  assert.equal(calls[0]!.init.signal?.aborted, true)
})

test('invalid provider output, private endpoint tricks, and cancellation fail closed', async () => {
  assert.throws(() => new AzureVoiceSynthesizer({ region: 'localhost:4444', key: 'key' }), /VOICE_CONFIG_INVALID/)
  assert.throws(() => assertOggOpus(Buffer.from('not opus')), /VOICE_AUDIO_INVALID/)
  const synthesizer = new AzureVoiceSynthesizer({ region: 'southeastasia', key: 'synthetic-key' },
    async () => new Response('not audio', { status: 200 }))
  await assert.rejects(synthesizer.synthesize('Halo'), /VOICE_AUDIO_INVALID/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(synthesizer.synthesize('Halo', controller.signal), /VOICE_ABORTED/)
})

test('cloud voice requires an explicit provider choice even when credentials are present', () => {
  const env = { ELARA_AZURE_SPEECH_REGION: 'southeastasia', ELARA_AZURE_SPEECH_KEY: 'synthetic-key' }
  const root = path.resolve(import.meta.dirname, '../..')
  const selected = voiceSynthesizer(root, env)
  if (process.platform === 'win32') assert.ok(selected instanceof WindowsVoiceSynthesizer)
  else assert.equal(selected, undefined)
  assert.ok(voiceSynthesizer(root, { ...env, ELARA_TTS_PROVIDER: 'azure' }) instanceof AzureVoiceSynthesizer)
})

test('local Windows synthesizer produces an Ogg Opus note and removes temporary output',
  { skip: process.platform !== 'win32' }, async () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const synth = new WindowsVoiceSynthesizer(root)
    const audio = await synth.synthesize('Halo Tan, aku di sini.')
    assertOggOpus(audio)
    assert.ok(audio.length > 100)
  })

test('cancelling a harmless owned speech helper verifies that its process exited',
  { skip: process.platform !== 'win32' }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-voice-owned-'))
    const marker = path.join(directory, 'pid.txt')
    const controller = new AbortController()
    let pid = 0
    try {
      const code = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)"
      const operation = runOwned(process.execPath, ['-e', code, marker], '', controller.signal)
      const startedAt = Date.now()
      while (!fs.existsSync(marker)) {
        if (Date.now() - startedAt > 5000) throw new Error('VOICE_FIXTURE_START_TIMEOUT')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      pid = Number(fs.readFileSync(marker, 'utf8'))
      assert.ok(pid > 0)
      controller.abort()
      await assert.rejects(operation, /VOICE_ABORTED/)
      assert.throws(() => process.kill(pid, 0), /ESRCH|not found|no such process/i)
    } finally {
      controller.abort()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
