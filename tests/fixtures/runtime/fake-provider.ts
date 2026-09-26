import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = 'elara-runtime-fixture-provider'
export const inject = ['llm']

const blocks = new Map<string, { entered: () => void; release: Promise<void> }>()
export function blockResponse(text: string) {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  blocks.set(text, { entered, release: pending })
  return { started, release: () => { release(); blocks.delete(text) } }
}

class FixtureAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'ELARA fixture provider' }
  }

  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: 'fixture-model', name: 'Fixture model' }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options, signal) }
  }

  async * stream(options, signal) {
    const personaCount = [...options.messages]
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      .join('\n').match(/You are ELARA/g)?.length || 0
    const trustedSpeakerCount = options.messages.filter(message =>
      message.source.kind === 'plugin' && message.source.plugin === 'elara-trusted-speaker').length
    const latestUser = [...options.messages].reverse().find(message => message.role === 'user'
      && (message.source.kind === 'user' || message.source.kind === 'plugin'
        && ['elara-proactive', 'elara-reminder'].includes(message.source.plugin)))
    const proactive = latestUser?.source.kind === 'plugin' && latestUser.source.plugin === 'elara-proactive'
    const reminder = latestUser?.source.kind === 'plugin' && latestUser.source.plugin === 'elara-reminder'
    const text = proactive ? 'fixture proactive turn' : reminder ? 'fixture reminder turn'
      : latestUser?.source.kind === 'user'
      ? latestUser.content.filter(block => block.type === 'text').map(block => block.text).join('') : ''
    const pluginPrompt = proactive || reminder ? (latestUser?.content || []).filter(block => block.type === 'text')
      .map(block => block.text).join('') : ''
    const proactiveKind = pluginPrompt.includes('topik terbuka') ? 'followup'
      : pluginPrompt.includes('pertanyaan penasaran') ? 'curiosity'
      : pluginPrompt.includes('permainan kecil') ? 'playful'
      : pluginPrompt.includes('pemikiran atau pengamatan') ? 'thought'
      : pluginPrompt.includes('check-in') ? 'checkin' : 'unknown'
    const reminderMood = /Nuansa kali ini: ([^.]+)\./u.exec(pluginPrompt)?.[1] || 'unknown'
    const response = proactive ? `fixture proactive: ${proactiveKind}`
      : reminder ? `fixture reminder: ${reminderMood}` : `fixture:${text}`
    const block = blocks.get(text)
    if (block) {
      block.entered()
      await new Promise<void>(resolve => {
        const done = () => { signal?.removeEventListener('abort', done); resolve() }
        signal?.addEventListener('abort', done, { once: true })
        void block.release.then(done)
        if (signal?.aborted) done()
      })
      if (signal?.aborted) return
    }
    if (text === 'fixture screenshot layar') {
      const instruction = options.messages.flatMap(message => message.content
        .filter(part => part.type === 'text').map(part => part.text))
        .find(value => value.includes('Adaptor WhatsApp hanya akan mengirim berkas itu'))
      const target = /path ini: (.+?\.png)\. Adaptor WhatsApp/u.exec(instruction || '')?.[1]
      if (!target) throw new Error('Synthetic screenshot destination is missing')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'))
    }
    if (text.startsWith('fixture kirim dokumen ') || text.startsWith('fixture buatkan xlsx')) {
      const instruction = options.messages.flatMap(message => message.content
        .filter(part => part.type === 'text').map(part => part.text)).reverse()
        .find(value => value.includes('Adaptor hanya membaca lokasi keluaran'))
      for (const format of ['DOCX', 'PDF', 'XLSX']) {
        const target = new RegExp(`${format}: (.+?\\.${format.toLowerCase()})`, 'u').exec(instruction || '')?.[1]
        if (!target) continue
        const fixture = process.env[`ELARA_RUNTIME_DOCUMENT_FIXTURE_${format}`]
        if (!fixture) throw new Error('Synthetic document fixture is missing')
        fs.writeFileSync(target, fs.readFileSync(fixture))
      }
    }
    const logPath = process.env.ELARA_RUNTIME_REQUEST_LOG
    if (logPath) {
      fs.appendFileSync(logPath, `${JSON.stringify({ text, messageCount: options.messages.length,
        personaCount, trustedSpeakerCount })}\n`, 'utf8')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  const unregister = ctx.llm.registerAdapter(['elara-fixture'], new FixtureAdapter())
  ctx.effect(() => () => {
    unregister()
    const marker = process.env.ELARA_RUNTIME_DISPOSE_MARKER
    if (marker) fs.writeFileSync(marker, 'disposed\n', 'utf8')
  })
}
