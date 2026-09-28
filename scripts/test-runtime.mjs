import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { verifyThenCleanup } from '../tests/fixtures/runtime/cleanup.mjs'
import { capabilityForTool } from '../packages/policy/evaluate.ts'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const dshRoot = path.join(repositoryRoot, '.runtime', 'deepseek-harness')
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-runtime-test-'))
const dshHome = path.join(fixtureRoot, 'dsh-home')
const requestLog = path.join(fixtureRoot, 'provider-requests.jsonl')
const disposeMarker = path.join(fixtureRoot, 'provider-disposed.txt')
const dashboardToken = 'fixture-dashboard-token-00000001'
const managedEnvironment = [
  'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'ELARA_ROOT', 'ELARA_MEMORY_DB',
  'ELARA_ACCESS_CONFIG', 'ELARA_CONTROL_DB',
  'ELARA_MODE',
  'ELARA_MOCK_WA', 'ELARA_DASHBOARD_PORT', 'ELARA_DASHBOARD_TOKEN',
  'ELARA_RUNTIME_REQUEST_LOG', 'ELARA_RUNTIME_DISPOSE_MARKER',
  'ELARA_RUNTIME_DOCUMENT_FIXTURE_DOCX', 'ELARA_RUNTIME_DOCUMENT_FIXTURE_PDF',
  'ELARA_RUNTIME_DOCUMENT_FIXTURE_XLSX',
  'ELARA_TRANSCRIPTION_BASE_URL',
]
const previousEnvironment = Object.fromEntries(managedEnvironment.map(name => [name, process.env[name]]))

let ctx
let dashboardPort
let dashboardUrl
let applyWhatsAppPlugin
let blockFixtureResponse
let executeReviewedWindowsTool
let ToolCallId
let RuntimeSessionId
const sent = []
const presence = []
const typing = []
let stopSentListener = () => {}
let stopPresenceListener = () => {}
let stopTypingListener = () => {}

class FixturePluginContext {
  events = new EventEmitter()
  disposers = []
  readySockets = []

  constructor(resolvePreset) {
    this.agentPresets = { resolve: resolvePreset }
    this.on('elara/test-whatsapp-ready', ({ socket }) => this.readySockets.push(socket))
  }

  on(event, listener) {
    this.events.on(event, listener)
    return () => this.events.off(event, listener)
  }

  emit(event, ...args) {
    this.events.emit(event, ...args)
  }

  effect(setup) {
    const dispose = setup()
    if (dispose) this.disposers.push(dispose)
  }

  async dispose() {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.events.removeAllListeners()
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('No TCP fixture port was assigned'))
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

function waitFor(predicate, label, timeoutMs = 15_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const value = await predicate()
      if (value) return resolve(value)
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${label}`))
      setTimeout(() => void poll(), 20)
    }
    void poll()
  })
}

function emitMessage(jid, id, text) {
  emitStructuredMessage(jid, id, { conversation: text })
}

function emitStructuredMessage(jid, id, message) {
  ctx.emit('elara/test-whatsapp-upsert', {
    type: 'notify',
    messages: [{ key: { remoteJid: jid, id, fromMe: false }, message }],
  })
}

function requestRows() {
  if (!fs.existsSync(requestLog)) return []
  return fs.readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function documentFixtureBytes() {
  const channelRequire = createRequire(path.join(repositoryRoot, 'channels', 'whatsapp-baileys', 'package.json'))
  const JSZip = channelRequire('jszip')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Isi DOCX sintetis runtime</w:t></w:r></w:p></w:body></w:document>')
  const docx = await zip.generateAsync({ type: 'nodebuffer' })
  const ExcelJS = channelRequire('exceljs')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  sheet.getCell('A1').value = 'Isi XLSX sintetis runtime'
  sheet.getCell('B1').value = 42
  sheet.getCell('C1').value = { formula: 'B1*2', result: 84 }
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer())
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 55 >>\nstream\nBT /F1 12 Tf 50 750 Td (Isi PDF sintetis runtime) Tj ET\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF\n`
  return { docx, pdf: Buffer.from(pdf), xlsx }
}

async function createLocalAgent(sessionId, cwd = fixtureRoot) {
  ctx.access.bindRootSession(sessionId, 'fixture-operator', 'dashboard')
  const selection = ctx.agentDefaultModel.currentSelection()
  return ctx.agents.create({
    sessionId: RuntimeSessionId(sessionId),
    meta: { cwd, agentPreset: 'elara' },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'elara') },
  })
}

before(async () => {
  assert.equal(fs.existsSync(path.join(dshRoot, 'package.json')), true, 'Audited DSH checkout is required')
  dashboardPort = await freePort()
  dashboardUrl = `http://127.0.0.1:${dashboardPort}`
  fs.mkdirSync(dshHome, { recursive: true })
  const documentFixtures = await documentFixtureBytes()
  const docxFixturePath = path.join(fixtureRoot, 'fixture-document.docx')
  const pdfFixturePath = path.join(fixtureRoot, 'fixture-document.pdf')
  const xlsxFixturePath = path.join(fixtureRoot, 'fixture-document.xlsx')
  fs.writeFileSync(docxFixturePath, documentFixtures.docx)
  fs.writeFileSync(pdfFixturePath, documentFixtures.pdf)
  fs.writeFileSync(xlsxFixturePath, documentFixtures.xlsx)
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), '{}\n')
  const accessConfigPath = path.join(fixtureRoot, 'access.json')
  fs.writeFileSync(accessConfigPath, JSON.stringify({
    schemaVersion: 1,
    policyVersion: 'runtime-test-p2a-v1',
    devices: [
      { id: 'fixture-local', kind: 'local', enabled: true },
      { id: 'fixture-companion', kind: 'companion', enabled: true },
    ],
    principals: [
      {
        id: 'fixture-user-a', role: 'user', enabled: true,
        channelAliases: { whatsapp: ['user-a@s.whatsapp.net'] },
        allowedDeviceIds: ['fixture-companion'],
      },
      {
        id: 'fixture-user-b', role: 'user', enabled: true,
        channelAliases: { whatsapp: ['user-b@s.whatsapp.net'] },
        allowedDeviceIds: ['fixture-companion'],
      },
      {
        id: 'fixture-user-c', role: 'user', enabled: true,
        channelAliases: { whatsapp: ['user-c@s.whatsapp.net'] },
        allowedDeviceIds: ['fixture-local', 'fixture-companion'],
        trustedWhatsAppOwner: { name: 'Tan', aliases: ['user-c@s.whatsapp.net'] },
      },
      {
        id: 'fixture-operator', role: 'operator', enabled: true,
        channelAliases: { dashboard: ['local-dashboard'] },
        allowedDeviceIds: ['fixture-local'],
      },
    ],
    authorities: {
      dashboardPrincipalId: 'fixture-operator',
      hostDeviceId: 'fixture-local',
      channelDefaultDeviceIds: { whatsapp: 'fixture-companion', dashboard: 'fixture-local' },
    },
  }, null, 2))
  Object.assign(process.env, {
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    ELARA_ROOT: fixtureRoot,
    ELARA_MEMORY_DB: path.join(fixtureRoot, 'memory', 'elara.db'),
    ELARA_ACCESS_CONFIG: accessConfigPath,
    ELARA_CONTROL_DB: path.join(fixtureRoot, 'control', 'elara-control.db'),
    ELARA_MODE: 'local',
    ELARA_MOCK_WA: '1',
    ELARA_DASHBOARD_PORT: String(dashboardPort),
    ELARA_DASHBOARD_TOKEN: dashboardToken,
    ELARA_RUNTIME_REQUEST_LOG: requestLog,
    ELARA_RUNTIME_DISPOSE_MARKER: disposeMarker,
    ELARA_RUNTIME_DOCUMENT_FIXTURE_DOCX: docxFixturePath,
    ELARA_RUNTIME_DOCUMENT_FIXTURE_PDF: pdfFixturePath,
    ELARA_RUNTIME_DOCUMENT_FIXTURE_XLSX: xlsxFixturePath,
  })

  const dshRequire = createRequire(path.join(dshRoot, 'apps', 'cli', 'package.json'))
  const {
    boot, createProfileResolutionGeneration, initProfile, loadProfile, PluginPackages,
  } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
  ;({ ToolCallId } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-llm')).href))
  ;({ SessionId: RuntimeSessionId } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-session')).href))
  const installAnchor = path.join(dshRoot, 'apps', 'cli', 'package.json')
  const profileDir = path.join(dshHome, 'profiles', 'runtime-test')
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const profile = loadProfile('elara-runtime-test', 'runtime-test', installAnchor, dshHome, { userLayer: false })
  const resolution = await createProfileResolutionGeneration({ installAnchor, home: dshHome, profile })
  const configPath = path.join(profileDir, 'cordis.yml')
  fs.writeFileSync(configPath, fs.readFileSync(path.join(repositoryRoot, 'tests', 'fixtures', 'runtime', 'cordis.yml')))

  // External TypeScript plugins normally resolve from an installed plugin
  // package. Mirror that layout inside this disposable fixture without
  // modifying the repository's junction or the audited DSH checkout.
  const fixtureSource = path.join(fixtureRoot, 'source')
  const copiedSources = [
    'plugins/elara-access.ts',
    'plugins/elara-control.ts',
    'plugins/elara-core.ts', 'plugins/elara-memory.ts', 'plugins/windows-tools.ts',
    'plugins/windows-tools-local.ts', 'plugins/dashboard-api.ts', 'plugins/companion-api.ts',
    'channels/whatsapp-baileys/plugin.ts', 'channels/whatsapp-baileys/emotion.ts',
    'channels/whatsapp-baileys/settings.ts',
    'channels/whatsapp-baileys/approval-buttons.ts',
    'channels/whatsapp-baileys/autonomy.ts',
    'channels/whatsapp-baileys/google-calendar.ts',
    'channels/whatsapp-baileys/calendar-auth.ts',
    'channels/whatsapp-baileys/outbound-voice.ts',
    'channels/whatsapp-baileys/hermes-project.ts',
    'channels/whatsapp-baileys/outbound-screenshot.ts',
    'channels/whatsapp-baileys/document-media.ts',
    'channels/whatsapp-baileys/ocr-local.ts',
    'channels/whatsapp-baileys/link-download.ts',
    'channels/whatsapp-baileys/format.ts', 'channels/whatsapp-baileys/message-context.ts',
    'channels/whatsapp-baileys/transcription.ts', 'channels/whatsapp-baileys/typing.ts',
    'tests/fixtures/runtime/fake-provider.ts',
    'packages/policy/contracts.ts', 'packages/policy/config.ts',
    'packages/policy/store.ts', 'packages/policy/audit.ts', 'packages/policy/evaluate.ts', 'packages/policy/approvals.ts',
  ]
  for (const relative of copiedSources) {
    const target = path.join(fixtureSource, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repositoryRoot, relative), target)
  }
  fs.symlinkSync(
    path.join(dshRoot, 'node_modules', '.pnpm', 'node_modules'),
    path.join(fixtureSource, 'node_modules'),
    'junction',
  )
  fs.symlinkSync(
    path.join(repositoryRoot, 'channels', 'whatsapp-baileys', 'node_modules'),
    path.join(fixtureSource, 'channels', 'whatsapp-baileys', 'node_modules'),
    'junction',
  )
  const pluginUrl = relative => pathToFileURL(path.join(fixtureSource, relative)).href
  applyWhatsAppPlugin = (await import(pluginUrl('channels/whatsapp-baileys/plugin.ts'))).apply
  blockFixtureResponse = (await import(pluginUrl('tests/fixtures/runtime/fake-provider.ts'))).blockResponse
  executeReviewedWindowsTool = (await import(pluginUrl('plugins/windows-tools.ts'))).executeReviewedWindowsTool
  const overrides = [
    { id: 'settings', config: { path: path.join(dshHome, 'settings.yaml'), watch: false } },
    { id: 'storage-json', config: { root: path.join(dshHome, 'storages') } },
    { id: 'session-persistence-jsonl', config: { root: path.join(dshHome, 'sessions') } },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'hmr', disabled: true },
    { id: 'plugin-manager', disabled: true },
    { id: 'agent-default-model', config: { provider: 'elara-fixture', model: 'fixture-model' } },
    { insert: [
      { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
      { id: 'fixture-provider', name: pluginUrl('tests/fixtures/runtime/fake-provider.ts') },
      { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: {
        default: 'elara',
        roots: [{ path: path.join(repositoryRoot, 'tests', 'fixtures', 'runtime', 'agent-presets'), trust: 'system' }],
        includeShippedRoot: false,
        includeUserRoot: false,
      } },
      { id: 'elara-access', name: pluginUrl('plugins/elara-access.ts') },
      { id: 'elara-control', name: pluginUrl('plugins/elara-control.ts') },
      { id: 'elara-memory', name: pluginUrl('plugins/elara-memory.ts') },
      { id: 'elara-core', name: pluginUrl('plugins/elara-core.ts') },
      { id: 'elara-windows-tools', name: pluginUrl('plugins/windows-tools.ts') },
      { id: 'whatsapp-baileys', name: pluginUrl('channels/whatsapp-baileys/plugin.ts') },
      { id: 'dashboard-api', name: pluginUrl('plugins/dashboard-api.ts') },
      { id: 'companion-api', name: pluginUrl('plugins/companion-api.ts'), disabled: true },
    ] },
  ]
  ctx = await boot(
    'elara-runtime-test',
    configPath,
    [...profile.layers.filter(layer => layer.packageName === '@deepseek-ai/dsh-base').flatMap(layer => layer.patches), ...overrides],
    async bootCtx => {
      bootCtx.provide('profileContext', {
        name: 'runtime-test', dir: profileDir, patchPath: profile.patchPath,
        installAnchor, home: dshHome, cwd: fixtureRoot,
        startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        overlays: overrides, telemetryDisabledEnv: '1',
      })
      await bootCtx.plugin(PluginPackages, { generation: resolution })
    },
  )
  stopSentListener = ctx.on('elara/test-whatsapp-sent', payload => { sent.push(payload) })
  stopPresenceListener = ctx.on('elara/test-whatsapp-presence', payload => { presence.push(payload) })
  stopTypingListener = ctx.on('elara/test-whatsapp-typing-delay', payload => { typing.push(payload) })
  await waitFor(async () => {
    try {
      const response = await fetch(`${dashboardUrl}/api/status`, {
        headers: { Authorization: `Bearer ${dashboardToken}` },
      })
      return response.status === 200
    } catch {
      return false
    }
  }, 'dashboard startup')
})

after(async () => {
  await verifyThenCleanup({
    verify: async () => {
      stopSentListener()
      stopPresenceListener()
      stopTypingListener()
      await ctx?.fiber.dispose()
      if (ctx) {
        assert.equal(fs.readFileSync(disposeMarker, 'utf8').trim(), 'disposed')
        await assert.rejects(fetch(`${dashboardUrl}/api/status?disposed=1`, { headers: { Connection: 'close' } }))
      }
    },
    cleanup: [
      () => {
        for (const name of managedEnvironment) {
          const previous = previousEnvironment[name]
          if (previous === undefined) delete process.env[name]
          else process.env[name] = previous
        }
      },
      async () => {
        const resolved = path.resolve(fixtureRoot)
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
        await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      },
    ],
  })
})

describe('offline DSH-loader composition', () => {
  test('disposal waits for delayed startup and prevents late socket creation', async () => {
    const gate = deferred()
    const lifecycleCtx = new FixturePluginContext(() => gate.promise)
    applyWhatsAppPlugin(lifecycleCtx)

    let disposalFinished = false
    const disposal = lifecycleCtx.dispose().then(() => { disposalFinished = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposalFinished, false, 'disposal must account for the pending startup')

    gate.resolve()
    await disposal
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(lifecycleCtx.readySockets.length, 0, 'a disposed instance must not create a socket')
  })

  test('parallel plugin instances own independent mutable transport state', async () => {
    const first = new FixturePluginContext(async () => ({}))
    const second = new FixturePluginContext(async () => ({}))
    applyWhatsAppPlugin(first)
    applyWhatsAppPlugin(second)

    await waitFor(
      () => first.readySockets.length === 1 && second.readySockets.length === 1,
      'independent fixture sockets',
    )
    const firstSocket = first.readySockets[0]
    const secondSocket = second.readySockets[0]
    assert.notEqual(firstSocket, secondSocket)
    assert.notEqual(firstSocket.ev, secondSocket.ev)
    assert.equal(firstSocket.ev.listenerCount('messages.upsert'), 1)
    assert.equal(secondSocket.ev.listenerCount('messages.upsert'), 1)

    firstSocket.ev.removeAllListeners('messages.upsert')
    assert.equal(firstSocket.ev.listenerCount('messages.upsert'), 0)
    assert.equal(secondSocket.ev.listenerCount('messages.upsert'), 1)
    await Promise.all([first.dispose(), second.dispose()])
  })

  test('fixture cleanup still completes and preserves a verification failure', async () => {
    const failureRoot = fs.mkdtempSync(path.join(fixtureRoot, 'forced-cleanup-failure-'))
    const marker = path.join(failureRoot, 'marker.txt')
    const variable = 'ELARA_RUNTIME_CLEANUP_PROBE'
    const previous = process.env[variable]
    const originalFailure = new Error('forced fixture verification failure')
    fs.writeFileSync(marker, 'temporary fixture\n')
    process.env[variable] = 'temporary-value'

    let observedFailure
    try {
      await verifyThenCleanup({
        verify: async () => { throw originalFailure },
        cleanup: [
          () => {
            if (previous === undefined) delete process.env[variable]
            else process.env[variable] = previous
          },
          () => fs.rmSync(failureRoot, { recursive: true, force: true }),
        ],
      })
    } catch (error) {
      observedFailure = error
    }

    assert.equal(observedFailure, originalFailure)
    assert.equal(process.env[variable], previous)
    assert.equal(fs.existsSync(failureRoot), false)
  })

  test('mounts the synthetic ELARA preset through the DSH roster', async () => {
    const preset = await ctx.agentPresets.resolve('elara')
    assert.equal(preset.id, 'elara')
    const key = await ctx.agentPresets.standingKeyFor('elara')
    assert.equal(key.agentPreset, 'elara')
  })

  test('the enabled tool inventory has an explicit P2A classification', () => {
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    const unknown = names.filter(toolName => capabilityForTool(toolName, {}).risk === 'unknown')
    assert.deepEqual(unknown, [], `unclassified enabled tools: ${unknown.join(', ')}`)
  })

  test('dashboard authentication accepts only the fixture token', async () => {
    const unauthorized = await fetch(`${dashboardUrl}/api/status`)
    assert.equal(unauthorized.status, 401)
    const authorized = await fetch(`${dashboardUrl}/api/status`, {
      headers: { Authorization: `Bearer ${dashboardToken}` },
    })
    assert.equal(authorized.status, 200)
    assert.equal((await authorized.json()).status, 'running')
    assert.equal(fs.existsSync(path.join(fixtureRoot, '.runtime', 'dashboard-token.txt')), false)
  })

  test('fake WhatsApp transport rejects groups and deduplicates delivery', async () => {
    const initialRequests = requestRows().length
    emitMessage('group@g.us', 'group-message', 'ignored group')
    emitMessage('user-a@s.whatsapp.net', 'duplicate-message', 'first hello')
    emitMessage('user-a@s.whatsapp.net', 'duplicate-message', 'first hello')
    await waitFor(() => sent.find(item => item.remoteJid === 'user-a@s.whatsapp.net'), 'first WhatsApp response')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(sent.filter(item => item.remoteJid === 'group@g.us').length, 0)
    assert.equal(sent.filter(item => item.remoteJid === 'user-a@s.whatsapp.net').length, 1)
    assert.equal(requestRows().length, initialRequests + 1)
    assert.equal(requestRows().at(-1).personaCount, 1, 'fixture persona must appear once in the model request')
  })

  test('unknown WhatsApp senders cannot trigger a reply, model request, or session', async () => {
    const requestCount = requestRows().length
    const sentCount = sent.length
    emitMessage('unknown@s.whatsapp.net', 'unknown-user-1', 'should be ignored')
    ctx.emit('elara/test-whatsapp-upsert', {
      type: 'notify',
      messages: [{
        key: { remoteJid: 'unknown@s.whatsapp.net', id: 'unknown-media-1', fromMe: false },
        message: { imageMessage: { caption: 'unknown media', fileLength: 128, mimetype: 'image/png' } },
      }],
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(requestRows().length, requestCount)
    assert.equal(sent.length, sentCount)
    assert.equal(ctx.agents.get('whatsapp:unknown@s.whatsapp.net'), undefined)
  })

  test('two users receive separate sessions and one user reuses its session', async () => {
    const userAId = 'whatsapp:user-a@s.whatsapp.net'
    const userBId = 'whatsapp:user-b@s.whatsapp.net'
    const firstAgent = ctx.agents.get(userAId)
    assert.ok(firstAgent)

    emitMessage('user-b@s.whatsapp.net', 'user-b-1', 'hello from b')
    await waitFor(() => sent.find(item => item.remoteJid === 'user-b@s.whatsapp.net'), 'second user response')
    const secondAgent = ctx.agents.get(userBId)
    assert.ok(secondAgent)
    assert.notEqual(firstAgent, secondAgent)

    const before = requestRows().at(-1).messageCount
    emitMessage('user-a@s.whatsapp.net', 'user-a-2', 'second hello')
    await waitFor(() => sent.filter(item => item.remoteJid === 'user-a@s.whatsapp.net').length === 2, 'reused-session response')
    assert.equal(ctx.agents.get(userAId), firstAgent)
    assert.ok(requestRows().at(-1).messageCount > before)
  })

  test('distinct WhatsApp message IDs with identical text both reach the agent', async () => {
    const before = requestRows().length
    emitMessage('user-a@s.whatsapp.net', 'same-text-one', 'same fixture text')
    emitMessage('user-a@s.whatsapp.net', 'same-text-two', 'same fixture text')
    await waitFor(() => requestRows().length >= before + 2, 'both identical-text requests')
    assert.deepEqual(requestRows().slice(before, before + 2).map(row => row.text),
      ['same fixture text', 'same fixture text'])
  })

  test('a later pre-execute listener cannot override the final sensitive-operation denial', async () => {
    const agent = ctx.agents.get(RuntimeSessionId('whatsapp:user-a@s.whatsapp.net'))
    assert.ok(agent)
    const stopOverride = ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('fixture-sensitive-override'),
        name: 'elara_project_test',
        arguments: { cwd: fixtureRoot },
        agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /P2A_APPROVAL_REQUIRED/)
    } finally {
      stopOverride()
    }
  })

  test('a local runtime-owned child inherits host authority while an unbound root fails closed', async () => {
    const parentHandle = await createLocalAgent('fixture-local-parent')
    const parent = parentHandle.agent
    const selection = ctx.agentDefaultModel.currentSelection()
    const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'elara') }
    const childHandle = await ctx.agents.create({
      sessionId: RuntimeSessionId('fixture-owned-child'),
      parentAgent: parent,
      meta: { cwd: fixtureRoot, parentSession: parent.id, origin: 'subagent', agentPreset: 'elara' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
    const rootHandle = await ctx.agents.create({
      sessionId: RuntimeSessionId('fixture-unbound-root'),
      meta: { cwd: fixtureRoot, agentPreset: 'elara' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    })
    assert.equal(ctx.access.bindingForSession('fixture-owned-child')?.principalId, 'fixture-operator')
    assert.equal(ctx.access.bindingForSession('fixture-unbound-root'), undefined)
    const notePath = path.join(fixtureRoot, 'read-only-note.txt')
    fs.writeFileSync(notePath, 'reviewed read only fixture\n')
    try {
      const childResult = await ctx.tools.execute({
        callId: ToolCallId('fixture-child-read'), name: 'read',
        arguments: { file_path: notePath, limit: 5 }, agent: childHandle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(childResult.isError, false)
      const rootResult = await ctx.tools.execute({
        callId: ToolCallId('fixture-unbound-read'), name: 'read',
        arguments: { file_path: notePath, limit: 5 }, agent: rootHandle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(rootResult.isError, true)
      assert.match(rootResult.error.message, /PRINCIPAL_DISABLED_OR_UNKNOWN/)
    } finally {
      await Promise.all([childHandle.dispose(), rootHandle.dispose(), parentHandle.dispose()])
    }
  })

  test('companion-selected authority cannot execute a native host read', async () => {
    const agent = ctx.agents.get(RuntimeSessionId('whatsapp:user-a@s.whatsapp.net'))
    assert.ok(agent)
    const notePath = path.join(fixtureRoot, 'companion-host-note.txt')
    fs.writeFileSync(notePath, 'must stay on host\n')
    let resolveCalls = 0
    const originalResolve = ctx.fs.resolve
    ctx.fs.resolve = (...args) => {
      resolveCalls++
      return originalResolve.call(ctx.fs, ...args)
    }
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('fixture-companion-host-read'), name: 'read',
        arguments: { file_path: notePath, limit: 5 }, agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /EXECUTION_TARGET_MISMATCH/)
      const nonexistent = await ctx.tools.execute({
        callId: ToolCallId('fixture-companion-host-read-nonexistent'), name: 'read',
        arguments: { file_path: path.join(fixtureRoot, 'definitely-not-present.txt'), limit: 5 }, agent,
        signal: new AbortController().signal,
      })
      assert.equal(nonexistent.isError, true)
      assert.match(nonexistent.error.message, /EXECUTION_TARGET_MISMATCH/)
      assert.equal(resolveCalls, 0, 'the native filesystem resolver must not run')
    } finally {
      ctx.fs.resolve = originalResolve
    }
  })

  test('canonical private reads are denied before the normal loader invokes the filesystem tool', async () => {
    const privateDir = path.join(fixtureRoot, '.runtime')
    const privateFile = path.join(privateDir, 'synthetic-secret.txt')
    const safeDir = path.join(fixtureRoot, 'safe')
    fs.mkdirSync(privateDir, { recursive: true })
    fs.mkdirSync(safeDir, { recursive: true })
    fs.writeFileSync(privateFile, 'synthetic fixture secret only\n')
    const handle = await createLocalAgent('fixture-private-read-root')
    const cwdHandle = await createLocalAgent('fixture-private-cwd-root', privateDir)
    const cases = [
      { agent: handle.agent, path: path.join('.runtime', 'synthetic-secret.txt') },
      { agent: handle.agent, path: path.join('safe', '..', '.runtime', 'synthetic-secret.txt') },
      { agent: handle.agent, path: privateFile },
      { agent: cwdHandle.agent, path: 'synthetic-secret.txt' },
    ]
    if (process.platform === 'win32') {
      cases.push({ agent: handle.agent, path: '.runtime/synthetic-secret.txt' })
      const envFile = path.join(fixtureRoot, '.env')
      fs.writeFileSync(envFile, 'synthetic fixture only\n')
      fs.writeFileSync(`${envFile}:fixture`, 'synthetic stream only\n')
      cases.push({ agent: handle.agent, path: '.env:fixture' })
      cases.push({ agent: handle.agent, path: `${envFile}:fixture:$DATA` })
    }
    let resolveCalls = 0
    const originalResolve = ctx.fs.resolve
    ctx.fs.resolve = (...args) => {
      resolveCalls++
      return originalResolve.call(ctx.fs, ...args)
    }
    try {
      for (const [index, entry] of cases.entries()) {
        const result = await ctx.tools.execute({
          callId: ToolCallId(`fixture-private-read-${index}`), name: 'read',
          arguments: { file_path: entry.path, limit: 5 }, agent: entry.agent,
          signal: new AbortController().signal,
        })
        assert.equal(result.isError, true, entry.path)
        assert.match(result.error.message, /P2A_APPROVAL_REQUIRED/, entry.path)
      }
      assert.equal(resolveCalls, 0, 'protected reads must not reach the filesystem resolver')
    } finally {
      ctx.fs.resolve = originalResolve
      await Promise.all([handle.dispose(), cwdHandle.dispose()])
    }
  })

  test('link traversal to a protected target is denied before filesystem resolution', async t => {
    const privateDir = path.join(fixtureRoot, '.runtime')
    const linkDir = path.join(fixtureRoot, 'synthetic-private-link')
    fs.mkdirSync(privateDir, { recursive: true })
    fs.writeFileSync(path.join(privateDir, 'linked-secret.txt'), 'synthetic fixture secret only\n')
    try {
      fs.symlinkSync(privateDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`link creation unavailable: ${error.code || error.message}`)
      return
    }
    const handle = await createLocalAgent('fixture-linked-read-root')
    let resolveCalls = 0
    const originalResolve = ctx.fs.resolve
    ctx.fs.resolve = (...args) => {
      resolveCalls++
      return originalResolve.call(ctx.fs, ...args)
    }
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('fixture-linked-private-read'), name: 'read',
        arguments: { file_path: path.join(linkDir, 'linked-secret.txt'), limit: 5 }, agent: handle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /P2A_APPROVAL_REQUIRED|FILESYSTEM_LINK_SCOPE_DISABLED/)
      assert.equal(resolveCalls, 0)
    } finally {
      ctx.fs.resolve = originalResolve
      await handle.dispose()
    }
  })

  test('broad glob and grep fail closed before ripgrep is spawned', async () => {
    const handle = await createLocalAgent('fixture-search-root')
    let spawnCalls = 0
    const originalSpawn = ctx.subprocess.spawn
    ctx.subprocess.spawn = (...args) => {
      spawnCalls++
      return originalSpawn.call(ctx.subprocess, ...args)
    }
    try {
      for (const request of [
        { name: 'glob', arguments: { pattern: '**/*', path: fixtureRoot } },
        { name: 'grep', arguments: { pattern: 'synthetic', path: fixtureRoot } },
      ]) {
        const result = await ctx.tools.execute({
          callId: ToolCallId(`fixture-disabled-${request.name}`), ...request, agent: handle.agent,
          signal: new AbortController().signal,
        })
        assert.equal(result.isError, true)
        assert.match(result.error.message, /SEARCH_SCOPE_UNENFORCEABLE/)
      }
      assert.equal(spawnCalls, 0, 'ripgrep must not spawn for a denied search')
    } finally {
      ctx.subprocess.spawn = originalSpawn
      await handle.dispose()
    }
  })

  test('cloud mode denies native host reads before filesystem resolution', async () => {
    const handle = await createLocalAgent('fixture-cloud-host-root')
    const notePath = path.join(fixtureRoot, 'cloud-host-note.txt')
    fs.writeFileSync(notePath, 'local-only fixture\n')
    let resolveCalls = 0
    const originalResolve = ctx.fs.resolve
    const previousMode = process.env.ELARA_MODE
    ctx.fs.resolve = (...args) => {
      resolveCalls++
      return originalResolve.call(ctx.fs, ...args)
    }
    process.env.ELARA_MODE = 'cloud'
    try {
      const result = await ctx.tools.execute({
        callId: ToolCallId('fixture-cloud-host-read'), name: 'read',
        arguments: { file_path: notePath, limit: 5 }, agent: handle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /HOST_EXECUTION_DISABLED_IN_CLOUD/)
      assert.equal(resolveCalls, 0)
    } finally {
      process.env.ELARA_MODE = previousMode
      ctx.fs.resolve = originalResolve
      await handle.dispose()
    }
  })

  test('dashboard token cannot take over a WhatsApp-owned session', async () => {
    const response = await fetch(`${dashboardUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dashboardToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'whatsapp:user-a@s.whatsapp.net', message: 'dashboard ping',
        principalId: 'fixture-user-a', role: 'operator',
      }),
    })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error, 'Session not found')
  })

  test('dashboard stop endpoints authorize every read and expose redacted audit history', async () => {
    const sessionId = 'fixture-control-dashboard'
    const handle = await createLocalAgent(sessionId)
    const headers = { Authorization: `Bearer ${dashboardToken}` }
    try {
      const foreign = await fetch(`${dashboardUrl}/api/sessions/${encodeURIComponent('whatsapp:user-a@s.whatsapp.net')}/stop`, {
        method: 'POST', headers,
      })
      assert.equal(foreign.status, 404)
      const request = await fetch(`${dashboardUrl}/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: 'POST', headers,
      })
      assert.equal(request.status, 202)
      const { stopRequestId } = await request.json()
      assert.ok(stopRequestId)
      const settled = await waitFor(async () => {
        const response = await fetch(`${dashboardUrl}/api/stops/${stopRequestId}`, { headers })
        const body = await response.json()
        return body.outcome !== 'stopping' ? body : undefined
      }, 'stop settlement')
      assert.equal(settled.outcome, 'stopped')
      const audit = await fetch(`${dashboardUrl}/api/sessions/${encodeURIComponent(sessionId)}/audit?limit=1`, { headers })
      assert.equal(audit.status, 200)
      const page = await audit.json()
      assert.equal(page.events.length, 1)
      assert.equal(page.events[0].stopRequestId, stopRequestId)
      assert.doesNotMatch(JSON.stringify(page), /synthetic-secret|stdout|arguments|rawPath/)
      const unknown = await fetch(`${dashboardUrl}/api/stops/${crypto.randomUUID()}`, { headers })
      assert.equal(unknown.status, 404)
      assert.throws(() => ctx.control.getStopStatus({ principalId: 'fixture-user-a', originChannel: 'dashboard' }, stopRequestId), /SESSION_NOT_FOUND/)
      assert.throws(() => ctx.control.listAudit({ principalId: 'fixture-operator', originChannel: 'whatsapp' }, sessionId), /SESSION_NOT_FOUND/)
      assert.doesNotThrow(() => ctx.control.admit({ principalId: 'fixture-operator', originChannel: 'dashboard' }, sessionId))
    } finally { await handle.dispose() }
  })

  test('dashboard project execution stops at approval-required before dispatch', async () => {
    const response = await fetch(`${dashboardUrl}/api/project/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${dashboardToken}` },
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.decision, 'approval_required')
    assert.equal(body.reasonCode, 'P2A_APPROVAL_REQUIRED')
  })

  test('dashboard creates an owned agent session and does not claim an unrun project action', async () => {
    const headers = { Authorization: `Bearer ${dashboardToken}`, 'Content-Type': 'application/json' }
    const created = await fetch(`${dashboardUrl}/api/sessions`, {
      method: 'POST', headers, body: '{}',
    })
    assert.equal(created.status, 201)
    const { sessionId } = await created.json()
    assert.match(sessionId, /^dashboard:/)
    assert.equal(ctx.access.bindingForSession(sessionId)?.principalId, 'fixture-operator')
    const project = await fetch(`${dashboardUrl}/api/project/test`, {
      method: 'POST', headers, body: JSON.stringify({ sessionId }),
    })
    assert.equal(project.status, 409)
    assert.match((await project.json()).error, /did not run/)
  })

  test('P2B grants only one live DSH tool call from the owning dashboard', async () => {
    const handle = await createLocalAgent('fixture-p2b-root')
    const agent = handle.agent
    const file = path.join(fixtureRoot, 'p2b-synthetic.txt')
    const deniedFile = path.join(fixtureRoot, 'p2b-denied.txt')
    const controller = new AbortController()
    const headers = { Authorization: `Bearer ${dashboardToken}`, 'Content-Type': 'application/json' }
    const begin = (callId, target) => ctx.tools.execute({
      callId: ToolCallId(callId), name: 'write',
      arguments: { file_path: target, content: 'synthetic approval fixture\n' },
      agent, signal: controller.signal,
    })
    agent.session.append('turn/start', { turn: 1 })
    try {
      const pendingWrite = begin('fixture-p2b-write', file)
      const first = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0], 'first approval')
      assert.equal(first.toolName, 'write')
      assert.equal(first.targetDeviceId, 'fixture-local')
      assert.equal(ctx.access.answerApproval(first.id, 'fixture-user-a', 'dashboard', true), false)
      const listResponse = await fetch(`${dashboardUrl}/api/approvals`, { headers })
      assert.equal(listResponse.status, 200)
      assert.ok((await listResponse.json()).approvals.some(item => item.id === first.id))
      const approved = await fetch(`${dashboardUrl}/api/approvals/answer`, {
        method: 'POST', headers, body: JSON.stringify({ id: first.id, allow: true }),
      })
      assert.equal(approved.status, 200)
      assert.equal(ctx.access.answerApproval(first.id, 'fixture-operator', 'dashboard', true), false)
      let settled = false
      void pendingWrite.finally(() => { settled = true })
      const next = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0] || settled,
        'approved execution settlement', 3_000)
      assert.equal(next, true, 'the same tool call must not ask for a second approval')
      const result = await pendingWrite
      assert.equal(result.isError, false, result.error?.message)
      assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic approval fixture\n')

      const pendingDenied = begin('fixture-p2b-denied', deniedFile)
      const denied = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0], 'rejection approval')
      assert.equal(ctx.access.answerApproval(denied.id, 'fixture-operator', 'dashboard', false), true)
      assert.equal((await pendingDenied).isError, true)
      assert.equal(fs.existsSync(deniedFile), false)
      assert.equal(ctx.access.answerApproval(denied.id, 'fixture-operator', 'dashboard', true), false)

      const scopeFile = path.join(fixtureRoot, 'p2b-changed-scope.txt')
      const changing = begin('fixture-p2b-changing-scope', scopeFile)
      const scopeQuestion = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0],
        'changed-scope approval')
      const defaults = ctx.access.state.config.authorities.channelDefaultDeviceIds
      const originalTarget = defaults.dashboard
      defaults.dashboard = 'fixture-companion'
      try {
        assert.equal(ctx.access.answerApproval(scopeQuestion.id, 'fixture-operator', 'dashboard', true), true)
        assert.equal((await changing).isError, true)
        assert.equal(fs.existsSync(scopeFile), false)
      } finally {
        defaults.dashboard = originalTarget
      }
    } finally {
      controller.abort()
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
      await handle.dispose()
    }
  })

  test('a managed session switched to never still asks for ELARA one-time approval', async () => {
    const handle = await createLocalAgent('fixture-never-policy')
    const agent = handle.agent
    const file = path.join(fixtureRoot, 'never-policy-must-not-write.txt')
    const controller = new AbortController()
    ctx.approval.setPolicy(agent, 'never')
    assert.equal(ctx.approval.overrideOf(agent.session), 'never')
    agent.session.append('turn/start', { turn: 1 })
    try {
      const pending = ctx.tools.execute({
        callId: ToolCallId('fixture-never-policy-write'), name: 'write',
        arguments: { file_path: file, content: 'synthetic fixture only\n' },
        agent, signal: controller.signal,
      })
      const question = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0],
        'ELARA approval after never policy')
      assert.equal(question.toolName, 'write')
      assert.equal(ctx.approval.overrideOf(agent.session), 'ask')
      assert.equal(fs.existsSync(file), false)
      assert.equal(ctx.access.answerApproval(question.id, 'fixture-operator', 'dashboard', false), true)
      const result = await pending
      assert.equal(result.isError, true)
      assert.match(result.error.message, /APPROVAL_REJECTED/)
      assert.equal(fs.existsSync(file), false)
    } finally {
      controller.abort()
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
      await handle.dispose()
    }
  })

  test('one approval covers a harmless shell call and its native sandbox check', async () => {
    const handle = await createLocalAgent('fixture-shell-one-approval')
    const agent = handle.agent
    const controller = new AbortController()
    const toolName = process.platform === 'win32' ? 'pwsh' : 'bash'
    const command = process.platform === 'win32' ? 'Write-Output ELARA_APPROVAL_FIXTURE'
      : 'printf ELARA_APPROVAL_FIXTURE'
    agent.session.append('turn/start', { turn: 1 })
    try {
      const pending = ctx.tools.execute({ callId: ToolCallId('fixture-shell-one-approval'), name: toolName,
        arguments: { command, description: 'Harmless synthetic approval fixture' },
        agent, signal: controller.signal })
      const question = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0],
        'shell approval')
      assert.equal(question.toolName, toolName)
      assert.equal(ctx.access.answerApproval(question.id, 'fixture-operator', 'dashboard', true), true)
      let settled = false
      void pending.finally(() => { settled = true })
      const next = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0] || settled,
        'shell completion without duplicate approval', 5_000)
      assert.equal(next, true, 'the sandbox must reuse the answer for this exact shell call')
      const result = await pending
      assert.equal(result.isError, false, result.error?.message)
    } finally {
      controller.abort()
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
      await handle.dispose()
    }
  })

  test('stop cancels a pending one-time approval and fences its old tool call', async () => {
    const handle = await createLocalAgent('fixture-control-approval')
    const agent = handle.agent
    const file = path.join(fixtureRoot, 'stop-must-not-write.txt')
    const controller = new AbortController()
    agent.session.append('turn/start', { turn: 1 })
    try {
      const pending = ctx.tools.execute({ callId: ToolCallId('fixture-stop-write'), name: 'write',
        arguments: { file_path: file, content: 'synthetic-secret-must-not-persist' },
        agent, signal: controller.signal })
      const approval = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0], 'stop approval')
      const stop = ctx.control.requestStop({ principalId: 'fixture-operator', originChannel: 'dashboard' }, String(agent.id))
      assert.equal(ctx.access.answerApproval(approval.id, 'fixture-operator', 'dashboard', true), false)
      assert.equal((await pending).isError, true)
      assert.equal(fs.existsSync(file), false)
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-operator', originChannel: 'dashboard' }, stop.id).outcome !== 'stopping', 'approval stop settlement')
      const audit = ctx.control.listAudit({ principalId: 'fixture-operator', originChannel: 'dashboard' }, String(agent.id))
      assert.ok(audit.some(row => row.eventType === 'approval_resolved' && row.outcome === 'cancelled'))
      assert.doesNotMatch(JSON.stringify(audit), /synthetic-secret-must-not-persist/)
    } finally {
      controller.abort()
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
      await handle.dispose()
    }
  })

  test('synthetic audit append failure denies sensitive dispatch', async () => {
    const handle = await createLocalAgent('fixture-audit-failure')
    const agent = handle.agent
    const file = path.join(fixtureRoot, 'audit-failure-must-not-write.txt')
    const controller = new AbortController()
    const original = ctx.access.recordAudit
    agent.session.append('turn/start', { turn: 1 })
    try {
      const pending = ctx.tools.execute({ callId: ToolCallId('fixture-audit-failure-write'), name: 'write',
        arguments: { file_path: file, content: 'synthetic audit failure marker' },
        agent, signal: controller.signal })
      const approval = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0], 'audit failure approval')
      ctx.access.recordAudit = () => { throw new Error('SYNTHETIC_AUDIT_WRITE_FAILURE') }
      assert.equal(ctx.access.answerApproval(approval.id, 'fixture-operator', 'dashboard', true), true)
      const result = await pending
      assert.equal(result.isError, true)
      assert.match(result.error.message, /AUDIT_UNAVAILABLE/)
      assert.equal(fs.existsSync(file), false)
    } finally {
      ctx.access.recordAudit = original
      controller.abort()
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
      await handle.dispose()
    }
  })

  test('approval answer racing with stop cannot dispatch a stale write', async () => {
    const handle = await createLocalAgent('fixture-approval-stop-race')
    const agent = handle.agent
    const file = path.join(fixtureRoot, 'approval-stop-race.txt')
    const controller = new AbortController()
    agent.session.append('turn/start', { turn: 1 })
    try {
      const pending = ctx.tools.execute({ callId: ToolCallId('fixture-approval-stop-race-write'), name: 'write',
        arguments: { file_path: file, content: 'race marker' }, agent, signal: controller.signal })
      const approval = await waitFor(() => ctx.access.pendingApprovals('fixture-operator', 'dashboard')[0], 'racing approval')
      assert.equal(ctx.access.answerApproval(approval.id, 'fixture-operator', 'dashboard', true), true)
      const stop = ctx.control.requestStop({ principalId: 'fixture-operator', originChannel: 'dashboard' }, String(agent.id))
      assert.equal((await pending).isError, true)
      assert.equal(fs.existsSync(file), false)
      const rows = ctx.control.listAudit({ principalId: 'fixture-operator', originChannel: 'dashboard' }, String(agent.id))
      assert.ok(rows.some(row => row.stopRequestId === stop.id))
    } finally {
      controller.abort()
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
      await handle.dispose()
    }
  })

  test('WhatsApp approval replies release only the matching pending tool call', async () => {
    const defaults = ctx.access.state.config.authorities.channelDefaultDeviceIds
    const previousTarget = defaults.whatsapp
    defaults.whatsapp = 'fixture-local'
    const jid = 'user-c@s.whatsapp.net'
    const sessionId = `whatsapp:${jid}`
    const sentBefore = sent.length
    emitMessage(jid, 'fixture-whatsapp-approval-seed', 'hello approval fixture')
    await waitFor(() => sent.length > sentBefore && ctx.agents.get(RuntimeSessionId(sessionId)), 'authorized WhatsApp seed')
    const agent = ctx.agents.get(RuntimeSessionId(sessionId))
    const file = path.join(fixtureRoot, 'p2b-whatsapp-synthetic.txt')
    const controller = new AbortController()
    agent.session.append('turn/start', { turn: 2 })
    try {
      const pending = ctx.tools.execute({ callId: ToolCallId('fixture-whatsapp-write'), name: 'write',
        arguments: { file_path: file, content: 'synthetic WhatsApp grant\n' },
        agent, signal: controller.signal })
      const question = await waitFor(() => ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0], 'WhatsApp approval')
      const firstPreview = await waitFor(() => sent.slice(sentBefore).find(item => item.remoteJid === jid
        && item.text?.includes('Persetujuan ELARA')), 'approval message')
      assert.doesNotMatch(firstPreview.text, new RegExp(question.id))
      const card = await waitFor(() => sent.find(item => item.remoteJid === jid
        && item.approvalButtons?.[0]?.id.includes(question.id)), 'approval buttons')
      assert.deepEqual(card.approvalButtons.map(item => item.text), ['Izinkan sekali', 'Tolak'])
      const buttonReply = { interactiveResponseMessage: { nativeFlowResponseMessage: {
        name: 'quick_reply', paramsJson: JSON.stringify({ id: card.approvalButtons[0].id }),
      } } }
      emitStructuredMessage('user-a@s.whatsapp.net', 'fixture-wrong-owner-approval', buttonReply)
      await waitFor(() => sent.find(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.includes('tidak tersedia')), 'wrong-owner rejection')
      assert.equal(ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0]?.id, question.id)
      emitStructuredMessage(jid, 'fixture-whatsapp-approval-reply', buttonReply)
      let settled = false
      void pending.finally(() => { settled = true })
      const next = await waitFor(() => ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0] || settled,
        'approved WhatsApp execution settlement', 3_000)
      assert.equal(next, true, 'the same tool call must not ask for a second WhatsApp approval')
      const result = await pending
      assert.equal(result.isError, false, result.error?.message)
      assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic WhatsApp grant\n')
      assert.equal(ctx.access.answerApproval(question.id, 'fixture-user-c', 'whatsapp', true), false)
      emitStructuredMessage(jid, 'fixture-whatsapp-approval-replay', buttonReply)
      await waitFor(() => sent.find(item => item.remoteJid === jid && item.text?.includes('sudah berakhir')),
        'replayed button rejection')

      const quotedFile = path.join(fixtureRoot, 'quoted-approval-write.txt')
      const quotedStart = sent.length
      const quotedCall = ctx.tools.execute({ callId: ToolCallId('fixture-whatsapp-quoted-allow'), name: 'write',
        arguments: { file_path: quotedFile, content: 'quoted approval fixture\n' }, agent, signal: controller.signal })
      const quotedQuestion = await waitFor(() => ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0],
        'quoted approval')
      const quotedPreview = await waitFor(() => sent.slice(quotedStart).find(item => item.remoteJid === jid
        && item.text?.includes('Persetujuan ELARA')), 'quoted approval preview')
      assert.doesNotMatch(quotedPreview.text, new RegExp(quotedQuestion.id))
      const quotedReply = { extendedTextMessage: { text: '.approve',
        contextInfo: { stanzaId: quotedPreview.messageId } } }
      emitStructuredMessage('user-a@s.whatsapp.net', 'fixture-wrong-owner-quoted', quotedReply)
      assert.equal(ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0]?.id, quotedQuestion.id)
      emitStructuredMessage(jid, 'fixture-whatsapp-quoted-allow', quotedReply)
      const quotedResult = await quotedCall
      assert.equal(quotedResult.isError, false, quotedResult.error?.message)
      assert.equal(fs.readFileSync(quotedFile, 'utf8'), 'quoted approval fixture\n')
      assert.equal(ctx.access.answerApproval(quotedQuestion.id, 'fixture-user-c', 'whatsapp', true), false)

      const rejectedFile = path.join(fixtureRoot, 'reaction-must-not-write.txt')
      const rejectedCall = ctx.tools.execute({ callId: ToolCallId('fixture-whatsapp-reaction-reject'), name: 'write',
        arguments: { file_path: rejectedFile, content: 'must not exist' }, agent, signal: controller.signal })
      const reactionQuestion = await waitFor(() => ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0],
        'reaction approval')
      const preview = await waitFor(() => sent.find(item => item.remoteJid === jid
        && item.text?.includes('reaction-must-not-write.txt')), 'reaction approval preview')
      const reaction = { reactionMessage: { key: { remoteJid: jid, id: preview.messageId }, text: '❌' } }
      emitStructuredMessage('user-a@s.whatsapp.net', 'fixture-wrong-owner-reaction', reaction)
      assert.equal(ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0]?.id, reactionQuestion.id)
      emitStructuredMessage(jid, 'fixture-whatsapp-reaction-reject', reaction)
      const rejectedResult = await rejectedCall
      assert.equal(rejectedResult.isError, true)
      assert.equal(fs.existsSync(rejectedFile), false)
    } finally {
      defaults.whatsapp = previousTarget
      controller.abort()
      agent.session.append('turn/end', { turn: 2, reason: { kind: 'stop' } })
    }
  })

  test('owner auto mode cancels a waiting approval, runs reviewed tools, and turns off', async () => {
    const defaults = ctx.access.state.config.authorities.channelDefaultDeviceIds
    const previousTarget = defaults.whatsapp
    defaults.whatsapp = 'fixture-local'
    const jid = 'user-c@s.whatsapp.net'
    const sessionId = `whatsapp:${jid}`
    const agent = ctx.agents.get(RuntimeSessionId(sessionId))
    assert.ok(agent)
    const controller = new AbortController()
    const waitingFile = path.join(fixtureRoot, 'auto-waiting-must-not-write.txt')
    const approvedFile = path.join(fixtureRoot, 'auto-reviewed-write.txt')
    const disabledFile = path.join(fixtureRoot, 'auto-off-must-not-write.txt')
    agent.session.append('turn/start', { turn: 3 })
    try {
      const pending = ctx.tools.execute({ callId: ToolCallId('fixture-auto-waiting'), name: 'write',
        arguments: { file_path: waitingFile, content: 'must not exist' }, agent, signal: controller.signal })
      const question = await waitFor(() => ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0], 'auto waiting approval')
      const beforeOn = sent.length
      emitMessage(jid, 'fixture-auto-on', '.auto on')
      await waitFor(() => sent.slice(beforeOn).some(item => item.remoteJid === jid
        && item.text?.includes('Mode otomatis aktif')), 'auto on acknowledgment')
      assert.equal((await pending).isError, true)
      assert.equal(fs.existsSync(waitingFile), false)
      assert.equal(ctx.access.answerApproval(question.id, 'fixture-user-c', 'whatsapp', true), false)
      assert.equal(ctx.access.getAutoMode({ principalId: 'fixture-user-c', originChannel: 'whatsapp', senderAlias: jid }, sessionId), true)

      const result = await ctx.tools.execute({ callId: ToolCallId('fixture-auto-write'), name: 'write',
        arguments: { file_path: approvedFile, content: 'reviewed auto fixture\n' }, agent, signal: controller.signal })
      assert.equal(result.isError, false, result.error?.message)
      assert.equal(fs.readFileSync(approvedFile, 'utf8'), 'reviewed auto fixture\n')
      assert.equal(ctx.access.pendingApprovals('fixture-user-c', 'whatsapp').length, 0)

      const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'
      const shellCommand = process.platform === 'win32'
        ? 'Write-Output ELARA_AUTO_FIXTURE' : 'printf ELARA_AUTO_FIXTURE'
      const shell = await ctx.tools.execute({ callId: ToolCallId('fixture-auto-shell'), name: shellTool,
        arguments: { command: shellCommand, description: 'Harmless auto mode fixture' },
        agent, signal: controller.signal })
      assert.equal(shell.isError, false, shell.error?.message)
      assert.equal(ctx.access.pendingApprovals('fixture-user-c', 'whatsapp').length, 0)

      const enteredGuard = deferred()
      const releaseGuard = deferred()
      const staleFile = path.join(fixtureRoot, 'auto-old-instance-must-not-write.txt')
      const removeBarrier = ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.callId === ToolCallId('fixture-auto-old-instance')) {
          enteredGuard.resolve()
          await releaseGuard.promise
        }
        return next()
      })
      try {
        const stale = ctx.tools.execute({ callId: ToolCallId('fixture-auto-old-instance'), name: 'write',
          arguments: { file_path: staleFile, content: 'must not exist' }, agent, signal: controller.signal })
        await enteredGuard.promise
        const context = { principalId: 'fixture-user-c', originChannel: 'whatsapp', senderAlias: jid }
        ctx.access.setAutoMode(context, sessionId, false)
        ctx.access.setAutoMode(context, sessionId, true)
        releaseGuard.resolve()
        const staleResult = await stale
        assert.equal(staleResult.isError, true)
        assert.match(staleResult.error?.message || '', /AUTO_MODE_REVOKED/)
        assert.equal(fs.existsSync(staleFile), false)
      } finally {
        releaseGuard.resolve()
        removeBarrier()
      }

      const beforeWrong = sent.length
      emitMessage('user-a@s.whatsapp.net', 'fixture-auto-non-owner', '.auto on')
      await waitFor(() => sent.slice(beforeWrong).some(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.includes('hanya tersedia untuk owner')), 'non-owner auto denial')
      const beforeOff = sent.length
      emitMessage(jid, 'fixture-auto-off', '.auto off')
      await waitFor(() => sent.slice(beforeOff).some(item => item.remoteJid === jid
        && item.text?.includes('Mode otomatis mati')), 'auto off acknowledgment')
      assert.equal(ctx.access.getAutoMode({ principalId: 'fixture-user-c', originChannel: 'whatsapp', senderAlias: jid }, sessionId), false)
      const denied = ctx.tools.execute({ callId: ToolCallId('fixture-auto-off-write'), name: 'write',
        arguments: { file_path: disabledFile, content: 'must not exist' }, agent, signal: controller.signal })
      const offQuestion = await waitFor(() => ctx.access.pendingApprovals('fixture-user-c', 'whatsapp')[0], 'approval after auto off')
      assert.equal(ctx.access.answerApproval(offQuestion.id, 'fixture-user-c', 'whatsapp', false), true)
      assert.equal((await denied).isError, true)
      assert.equal(fs.existsSync(disabledFile), false)
      const audit = ctx.control.listAudit({ principalId: 'fixture-user-c', originChannel: 'whatsapp' }, sessionId)
      assert.ok(audit.some(row => row.eventType === 'auto_mode_changed' && row.reasonCode === 'AUTO_MODE_ENABLED'))
      assert.ok(audit.some(row => row.eventType === 'auto_mode_changed' && row.reasonCode === 'AUTO_MODE_DISABLED'))
      assert.ok(audit.some(row => row.eventType === 'policy_decision' && row.reasonCode === 'AUTO_MODE_ALLOWED'))
      assert.doesNotMatch(JSON.stringify(audit), /reviewed auto fixture|must not exist/)
    } finally {
      defaults.whatsapp = previousTarget
      controller.abort()
      agent.session.append('turn/end', { turn: 3, reason: { kind: 'stop' } })
    }
  })

  test('owner WhatsApp settings change live preferences and keep other senders isolated', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const other = 'user-a@s.whatsapp.net'
    const beforeOther = sent.length
    emitMessage(other, 'fixture-settings-non-owner', '.settings')
    await waitFor(() => sent.slice(beforeOther).find(item => item.remoteJid === other
      && item.text?.includes('hanya tersedia untuk nomor owner')), 'non-owner settings denial')

    const beforeMenu = sent.length
    emitMessage(jid, 'fixture-settings-menu', '.settings')
    const menu = await waitFor(() => sent.slice(beforeMenu).find(item => item.remoteJid === jid
      && item.text?.includes('*Pengaturan ELARA*')), 'owner settings menu')
    assert.match(menu.text, /Emosi:|Mengetik:|Chat spontan:|Mode otomatis:/)
    assert.doesNotMatch(menu.text, /fixture-dashboard-token|\.runtime|accessToken|client_secret/)

    const beforeTyping = sent.length
    emitMessage(jid, 'fixture-settings-typing', '.settings typing instant')
    await waitFor(() => sent.slice(beforeTyping).find(item => item.remoteJid === jid
      && item.text?.includes('typing sekarang instant')), 'live typing preference')
    const key = crypto.createHash('sha256').update(jid).digest('hex').slice(0, 24)
    const preferences = JSON.parse(fs.readFileSync(path.join(fixtureRoot, '.runtime', 'whatsapp-preferences.json'), 'utf8'))
    assert.equal(preferences.version, 2)
    assert.equal(preferences.users[key].typing, 'instant')
    assert.equal(preferences.users[crypto.createHash('sha256').update(other).digest('hex').slice(0, 24)]?.typing,
      undefined)
    const beforeReply = typing.length
    emitMessage(jid, 'fixture-settings-typing-proof', 'fixture settings typing proof')
    await waitFor(() => typing.slice(beforeReply).find(item => item.jid === jid
      && item.bubble.includes('fixture:fixture settings typing proof')), 'instant typing reply')
    assert.equal(typing.slice(beforeReply).find(item => item.jid === jid
      && item.bubble.includes('fixture:fixture settings typing proof')).milliseconds, 0)

    const beforeEmotion = sent.length
    emitMessage(jid, 'fixture-settings-emotion', '.settings emotion 3')
    await waitFor(() => sent.slice(beforeEmotion).find(item => item.remoteJid === jid
      && item.text?.includes('emotion sekarang 3')), 'live emotion preference')
    const beforeInitiative = sent.length
    emitMessage(jid, 'fixture-settings-initiative-off', '.settings initiative off')
    await waitFor(() => sent.slice(beforeInitiative).find(item => item.remoteJid === jid
      && item.text?.includes('chat spontan mati')), 'settings initiative alias')
    const beforeInitiativeOn = sent.length
    emitMessage(jid, 'fixture-settings-initiative-on', '.settings initiative on')
    await waitFor(() => sent.slice(beforeInitiativeOn).find(item => item.remoteJid === jid
      && item.text?.includes('chat spontan aktif')), 'settings initiative restored')
    const beforeInvalid = sent.length
    emitMessage(jid, 'fixture-settings-invalid', '.settings auto definitely')
    await waitFor(() => sent.slice(beforeInvalid).find(item => item.remoteJid === jid
      && item.text?.includes('belum tersedia')), 'invalid settings denial')
    emitMessage(jid, 'fixture-settings-reset-typing', '.settings typing natural')
    emitMessage(jid, 'fixture-settings-reset-emotion', '.settings emotion auto')
    await waitFor(() => {
      const stored = JSON.parse(fs.readFileSync(path.join(fixtureRoot, '.runtime', 'whatsapp-preferences.json'), 'utf8'))
      return stored.users[key]?.typing === 'natural' && stored.users[key]?.emotion === 'auto'
    }, 'restored settings defaults')
  })

  test('owner adds a chat-only member, then revokes it while model work is pending', async () => {
    const owner = 'user-c@s.whatsapp.net'
    const number = '6281234567890'
    const memberJid = `${number}@s.whatsapp.net`
    const beforeUnauthorized = sent.length
    emitMessage('user-a@s.whatsapp.net', 'fixture-member-non-owner', `.settings users add ${number}`)
    await waitFor(() => sent.slice(beforeUnauthorized).find(item => item.remoteJid === 'user-a@s.whatsapp.net'
      && item.text?.includes('hanya tersedia untuk nomor owner')), 'non-owner member mutation denied')
    assert.equal(ctx.access.principalForAlias('whatsapp', memberJid), undefined)

    const beforeAdd = sent.length
    emitMessage(owner, 'fixture-member-add', `.settings users add ${number}`)
    await waitFor(() => sent.slice(beforeAdd).find(item => item.remoteJid === owner
      && item.text?.includes('sekarang pengguna biasa')), 'member add acknowledgment')
    const member = ctx.access.principalForAlias('whatsapp', memberJid)
    assert.equal(member?.role, 'user')
    assert.equal(member?.chatOnly, true)
    assert.deepEqual(member?.allowedDeviceIds, [])
    const beforeDuplicate = sent.length
    emitMessage(owner, 'fixture-member-duplicate', `.settings users add ${number}`)
    await waitFor(() => sent.slice(beforeDuplicate).find(item => item.remoteJid === owner
      && item.text?.includes('sudah punya akses')), 'duplicate member denied')
    const beforeCommand = sent.length
    emitMessage(memberJid, 'fixture-member-command', '.pc')
    await waitFor(() => sent.slice(beforeCommand).find(item => item.remoteJid === memberJid
      && item.text?.includes('hanya bisa mengobrol')), 'member command denied')
    const bindingId = `whatsapp:${crypto.createHash('sha256').update(memberJid).digest('hex').slice(0, 24)}:${member.id}:root`
    const decision = ctx.access.decideDirect({ principalId: member.id, sessionId: bindingId,
      originChannel: 'whatsapp', targetDeviceId: 'fixture-companion', source: 'fixture:member',
      capabilityId: 'system.status' })
    assert.equal(decision.reasonCode, 'CHAT_ONLY_ROLE')

    const blockedText = 'fixture chat-only blocked model'
    const block = blockFixtureResponse(blockedText)
    const beforeRevocation = sent.length
    try {
      emitMessage(memberJid, 'fixture-member-blocked', blockedText)
      await block.started
      emitMessage(memberJid, 'fixture-member-queued', 'fixture member queued')
      emitMessage(owner, 'fixture-member-remove', `.settings users remove ${number}`)
      await waitFor(() => sent.slice(beforeRevocation).find(item => item.remoteJid === owner
        && item.text?.includes('Akses 6281234567890 dicabut')), 'member revoke acknowledgment')
      assert.equal(ctx.access.principalForAlias('whatsapp', memberJid), undefined)
      block.release()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(sent.slice(beforeRevocation).some(item => item.remoteJid === memberJid
        && item.text?.includes(`fixture:${blockedText}`)), false)
      assert.equal(requestRows().some(row => row.text === 'fixture member queued'), false)
      const beforeDenied = sent.length
      emitMessage(memberJid, 'fixture-member-revoked-ingress', 'hello after revoke')
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(sent.slice(beforeDenied).some(item => item.remoteJid === memberJid), false)
      assert.equal(ctx.access.state.config.principals.find(item => item.id === member.id)?.enabled, false)
      const beforeReadd = sent.length
      emitMessage(owner, 'fixture-member-readd', `.settings users add ${number}`)
      await waitFor(() => sent.slice(beforeReadd).find(item => item.remoteJid === owner
        && item.text?.includes('sekarang pengguna biasa')), 'member readd acknowledgment')
      const replacement = ctx.access.principalForAlias('whatsapp', memberJid)
      assert.ok(replacement)
      assert.notEqual(replacement.id, member.id)
      const beforeReplacementStatus = sent.length
      emitMessage(memberJid, 'fixture-member-replacement-status', '.status')
      await waitFor(() => sent.slice(beforeReplacementStatus).find(item => item.remoteJid === memberJid
        && item.text?.includes('Status:')), 'replacement member status')
      const newBindingId = `whatsapp:${crypto.createHash('sha256').update(memberJid).digest('hex').slice(0, 24)}:${replacement.id}:root`
      assert.equal(ctx.access.bindingForSession(newBindingId)?.principalId, replacement.id)
      assert.equal(ctx.access.bindingForSession(bindingId)?.principalId, member.id)
      const beforeSecondRemove = sent.length
      emitMessage(owner, 'fixture-member-remove-again', `.settings users remove ${number}`)
      await waitFor(() => sent.slice(beforeSecondRemove).find(item => item.remoteJid === owner
        && item.text?.includes('Akses 6281234567890 dicabut')), 'replacement revoke')
      const db = new DatabaseSync(path.join(fixtureRoot, 'control', 'elara-control.db'))
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM whatsapp_members WHERE alias = ? AND revoked_at IS NULL')
          .get(memberJid).n, 0)
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'membership_changed' AND execution_id = ?")
          .get(member.id).n, 2)
      } finally { db.close() }
    } finally { block.release() }
  })

  test('owner plans become durable reminders and proactive turns start without user input', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const db = new DatabaseSync(path.join(fixtureRoot, '.runtime', 'whatsapp-autonomy.db'))
    try {
      const before = sent.length
      emitMessage(jid, 'fixture-natural-reminder', 'besok jam 8 rapat')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('kuingetin')), 'natural reminder acknowledgment')
      const reminder = db.prepare("SELECT id, status, text FROM whatsapp_reminders WHERE source_id = 'fixture-natural-reminder'").get()
      assert.equal(reminder.status, 'pending')
      assert.equal(reminder.text, 'besok jam 8 rapat')

      const questionBefore = sent.length
      emitMessage(jid, 'fixture-reminder-question', 'kapan rapat besok jam 8?')
      await waitFor(() => sent.slice(questionBefore).find(item => item.remoteJid === jid
        && item.text?.includes('fixture:kapan rapat')), 'question handled as conversation')
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM whatsapp_reminders WHERE source_id = 'fixture-reminder-question'").get().count, 0)

      const otherBefore = sent.length
      emitMessage('user-a@s.whatsapp.net', 'fixture-reminder-other-list', '.remind list')
      await waitFor(() => sent.slice(otherBefore).find(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.includes('belum ada pengingat')), 'other sender reminder isolation')
      const cancelBefore = sent.length
      emitMessage(jid, 'fixture-reminder-cancel', `.remind cancel ${reminder.id}`)
      await waitFor(() => sent.slice(cancelBefore).find(item => item.remoteJid === jid
        && item.text?.includes('pengingat dibatalkan')), 'reminder cancellation')
      assert.equal(db.prepare('SELECT status FROM whatsapp_reminders WHERE id = ?').get(reminder.id).status, 'cancelled')

      const commandBefore = sent.length
      emitMessage(jid, 'fixture-command-reminder', '.remind 10m minum air')
      await waitFor(() => sent.slice(commandBefore).find(item => item.remoteJid === jid
        && item.text?.includes('kuingetin')), 'command reminder acknowledgment')
      db.prepare("UPDATE whatsapp_reminders SET due_at = ? WHERE source_id = 'fixture-command-reminder'").run(Date.now() - 1)
      const deliveryBefore = sent.length
      const reminderGate = blockFixtureResponse('fixture reminder turn')
      try {
        ctx.emit('elara/test-autonomy-tick', {})
        await reminderGate.started
        const agent = ctx.agents.get(RuntimeSessionId(`whatsapp:${jid}`))
        const blockedFile = path.join(fixtureRoot, 'reminder-must-not-write.txt')
        const blocked = await ctx.tools.execute({ callId: ToolCallId('fixture-reminder-blocked-tool'), name: 'write',
          arguments: { file_path: blockedFile, content: 'must not exist' },
          agent, signal: new AbortController().signal })
        assert.equal(blocked.isError, true)
        assert.match(blocked.error?.message || '', /reminder chat cannot use tools/)
        assert.equal(fs.existsSync(blockedFile), false)
      } finally { reminderGate.release() }
      const firstDelivery = await waitFor(() => sent.slice(deliveryBefore).find(item => item.remoteJid === jid
        && item.text?.startsWith('fixture reminder: ')), 'model-composed reminder delivery')
      assert.equal(sent.slice(deliveryBefore).some(item => item.text?.includes('*Pengingat*')), false)
      assert.equal(db.prepare("SELECT status FROM whatsapp_reminders WHERE source_id = 'fixture-command-reminder'").get().status, 'awaiting')
      const otherReplyBefore = sent.length
      emitMessage('user-a@s.whatsapp.net', 'fixture-reminder-other-reply', 'oke, makasih')
      await waitFor(() => sent.slice(otherReplyBefore).find(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.includes('fixture:oke, makasih')), 'other sender ordinary reply')
      assert.equal(db.prepare("SELECT status FROM whatsapp_reminders WHERE source_id = 'fixture-command-reminder'").get().status, 'awaiting')
      db.prepare("UPDATE whatsapp_reminders SET due_at = ? WHERE source_id = 'fixture-command-reminder'").run(Date.now() - 1)
      const repeatBefore = sent.length
      ctx.emit('elara/test-autonomy-tick', {})
      const secondDelivery = await waitFor(() => sent.slice(repeatBefore).find(item => item.remoteJid === jid
        && item.text?.startsWith('fixture reminder: ')), 'model-composed reminder follow-up')
      assert.notEqual(secondDelivery.text, firstDelivery.text)
      db.prepare("UPDATE whatsapp_reminders SET due_at = ? WHERE source_id = 'fixture-command-reminder'").run(Date.now() - 1)
      const thirdBefore = sent.length
      const pendingGate = blockFixtureResponse('fixture reminder turn')
      let replyBefore = sent.length
      try {
        ctx.emit('elara/test-autonomy-tick', {})
        await pendingGate.started
        replyBefore = sent.length
        emitMessage(jid, 'fixture-reminder-owner-reply', 'oke, udah')
        await waitFor(() => db.prepare("SELECT status FROM whatsapp_reminders WHERE source_id = 'fixture-command-reminder'")
          .get().status === 'acknowledged', 'reply acknowledges pending reminder')
      } finally { pendingGate.release() }
      await waitFor(() => sent.slice(replyBefore).find(item => item.remoteJid === jid
        && item.text?.includes('fixture:oke, udah')), 'owner reminder reply')
      assert.equal(db.prepare("SELECT status FROM whatsapp_reminders WHERE source_id = 'fixture-command-reminder'").get().status, 'acknowledged')
      assert.equal(sent.slice(thirdBefore).some(item => item.remoteJid === jid
        && item.text?.startsWith('fixture reminder: ')), false)

      const proactiveBefore = sent.length
      const proactiveGate = blockFixtureResponse('fixture proactive turn')
      try {
        ctx.emit('elara/test-autonomy-tick', { jid })
        await proactiveGate.started
        const agent = ctx.agents.get(RuntimeSessionId(`whatsapp:${jid}`))
        const blockedFile = path.join(fixtureRoot, 'proactive-must-not-write.txt')
        const blocked = await ctx.tools.execute({ callId: ToolCallId('fixture-proactive-blocked-tool'), name: 'write',
          arguments: { file_path: blockedFile, content: 'must not exist' },
          agent, signal: new AbortController().signal })
        assert.equal(blocked.isError, true)
        assert.match(blocked.error?.message || '', /proactive chat cannot use tools/)
        assert.equal(fs.existsSync(blockedFile), false)
      } finally { proactiveGate.release() }
      const firstProactive = await waitFor(() => sent.slice(proactiveBefore).find(item => item.remoteJid === jid
        && item.text?.startsWith('fixture proactive: ')), 'owner proactive message')
      const firstKind = db.prepare('SELECT last_kind AS kind FROM whatsapp_proactive WHERE principal_id = ?')
        .get('fixture-user-c').kind
      assert.equal(firstProactive.text, `fixture proactive: ${firstKind}`)
      assert.equal(sent.slice(proactiveBefore).some(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.startsWith('fixture proactive: ')), false)
      const secondBefore = sent.length
      ctx.emit('elara/test-autonomy-tick', { jid })
      const secondProactive = await waitFor(() => sent.slice(secondBefore).find(item => item.remoteJid === jid
        && item.text?.startsWith('fixture proactive: ')), 'varied owner proactive message')
      const secondKind = db.prepare('SELECT last_kind AS kind FROM whatsapp_proactive WHERE principal_id = ?')
        .get('fixture-user-c').kind
      assert.notEqual(secondKind, firstKind)
      assert.equal(secondProactive.text, `fixture proactive: ${secondKind}`)
      const offBefore = sent.length
      emitMessage(jid, 'fixture-proactive-off', '.inisiatif off')
      await waitFor(() => sent.slice(offBefore).find(item => item.remoteJid === jid
        && item.text?.includes('chat spontan mati')), 'proactive off')
      assert.equal(db.prepare('SELECT enabled FROM whatsapp_proactive WHERE principal_id = ?').get('fixture-user-c').enabled, 0)
    } finally { db.close() }
  })

  test('owner calendar events sync both ways through synthetic Google transport', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const events = new Map()
    const remote = {
      async create(event) { events.set(event.id, event); return event },
      async get(id) { return events.get(id) },
      async delete(id) { events.delete(id) },
    }
    ctx.emit('elara/test-calendar-handler', remote)
    const db = new DatabaseSync(path.join(fixtureRoot, '.runtime', 'whatsapp-autonomy.db'))
    try {
      const before = sent.length
      emitMessage(jid, 'fixture-calendar-plan', 'lusa jam 10 rapat CALENDAR_SECRET_MARKER')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Acara Google Calendar juga sudah tercatat')), 'calendar create acknowledgment')
      const row = db.prepare(`SELECT r.id, r.text, c.event_id AS eventId FROM whatsapp_reminders r
        JOIN whatsapp_calendar_links c ON c.reminder_id = r.id WHERE r.source_id = ?`).get('fixture-calendar-plan')
      assert.ok(row)
      assert.equal(events.has(row.eventId), true)
      const changedAt = Date.now() + 4 * 3_600_000
      events.set(row.eventId, { id: row.eventId, summary: 'jadwal digeser',
        start: { dateTime: new Date(changedAt).toISOString() } })
      db.prepare('UPDATE whatsapp_calendar_links SET next_check_at = 0 WHERE reminder_id = ?').run(row.id)
      ctx.emit('elara/test-autonomy-tick', {})
      await waitFor(() => db.prepare('SELECT text FROM whatsapp_reminders WHERE id = ?').get(row.id)?.text === 'jadwal digeser',
        'Google edit reflected locally')
      const cancelBefore = sent.length
      emitMessage(jid, 'fixture-calendar-cancel', `.remind cancel ${row.id}`)
      await waitFor(() => sent.slice(cancelBefore).find(item => item.remoteJid === jid
        && item.text?.includes('pengingat dibatalkan')), 'calendar cancellation acknowledgment')
      assert.equal(events.has(row.eventId), false)
      const sessionId = ctx.access.bindingForSession(`whatsapp:${jid}`)?.sessionId
      const audit = ctx.control.listAudit({ principalId: 'fixture-user-c', originChannel: 'whatsapp' }, sessionId)
      assert.ok(audit.some(item => item.reasonCode === 'CALENDAR_SYNC_COMPLETED'))
      assert.doesNotMatch(JSON.stringify(audit), /CALENDAR_SECRET_MARKER/)
      const otherBefore = sent.length
      emitMessage('user-a@s.whatsapp.net', 'fixture-calendar-wrong-owner', '.calendar status')
      await waitFor(() => sent.slice(otherBefore).find(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.includes('hanya tersedia untuk owner')), 'calendar owner restriction')
    } finally { ctx.emit('elara/test-calendar-handler', undefined); db.close() }
  })

  test('calendar dispatch is denied when durable audit append fails', async () => {
    const jid = 'user-c@s.whatsapp.net'
    let creates = 0
    ctx.emit('elara/test-calendar-handler', {
      async create(event) { creates++; return event },
      async get() { return undefined },
      async delete() {},
    })
    const original = ctx.access.recordAudit
    const db = new DatabaseSync(path.join(fixtureRoot, '.runtime', 'whatsapp-autonomy.db'))
    try {
      ctx.access.recordAudit = () => { throw new Error('SYNTHETIC_AUDIT_FAILURE') }
      const before = sent.length
      emitMessage(jid, 'fixture-calendar-audit-denial', 'lusa jam 11 rapat sintetis')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('masih menunggu sinkronisasi')), 'calendar audit denial reply')
      assert.equal(creates, 0)
      const row = db.prepare(`SELECT c.state, c.reminder_id AS reminderId FROM whatsapp_calendar_links c
        JOIN whatsapp_reminders r ON r.id = c.reminder_id WHERE r.source_id = ?`).get('fixture-calendar-audit-denial')
      assert.equal(row.state, 'pending')
      db.prepare("UPDATE whatsapp_calendar_links SET state = 'deleted' WHERE reminder_id = ?").run(row.reminderId)
    } finally {
      ctx.access.recordAudit = original
      ctx.emit('elara/test-calendar-handler', undefined)
      db.close()
    }
  })

  test('a fresh session screenshot is delivered as a WhatsApp image, with an honest missing-file result', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const sentBefore = sent.length
    emitMessage(jid, 'fixture-screenshot-send', 'fixture screenshot layar')
    const image = await waitFor(() => sent.slice(sentBefore).find(item => item.remoteJid === jid
      && Buffer.isBuffer(item.image)), 'WhatsApp screenshot image')
    assert.equal(image.caption, 'Ini screenshot layarnya.')
    assert.deepEqual([...image.image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(sent.slice(sentBefore).some(item => item.remoteJid === jid
      && item.text?.includes('fixture:fixture screenshot layar')), false)

    const missingStart = sent.length
    emitMessage(jid, 'fixture-screenshot-missing', 'fixture screenshot layar tanpa file')
    const failure = await waitFor(() => sent.slice(missingStart).find(item => item.remoteJid === jid
      && item.text?.includes('belum berhasil kukirim')), 'missing screenshot response')
    assert.equal(failure.image, undefined)
    assert.equal(sent.slice(missingStart).some(item => item.remoteJid === jid && item.image), false)
  })

  test('DOCX, PDF, and XLSX attachments are read, and owner-requested documents are sent from scoped outputs', async () => {
    const jid = 'user-c@s.whatsapp.net'
    for (const format of ['docx', 'pdf', 'xlsx']) {
      const fixture = fs.readFileSync(process.env[`ELARA_RUNTIME_DOCUMENT_FIXTURE_${format.toUpperCase()}`])
      const text = `fixture baca dokumen ${format}`
      emitStructuredMessage(jid, `fixture-inbound-${format}`, { documentMessage: {
        caption: text, fileName: `contoh.${format}`,
        mimetype: format === 'pdf' ? 'application/pdf'
          : format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        __fixtureBytes: [...fixture],
      } })
      await waitFor(() => requestRows().find(row => row.text.startsWith(text)
        && row.text.includes(`Isi ${format.toUpperCase()} sintetis runtime`)), `inbound ${format} extraction`)

      const before = sent.length
      emitMessage(jid, `fixture-outbound-${format}`, `fixture kirim dokumen ${format}`)
      const output = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && Buffer.isBuffer(item.document)), `outbound ${format} document`, 4_000).catch(error => {
          const replies = sent.slice(before).filter(item => item.remoteJid === jid)
            .map(item => item.text || (item.document ? 'document' : 'other'))
          throw new Error(`${error.message}; fixture replies: ${JSON.stringify(replies)}`)
        })
      assert.equal(output.fileName, `dokumen-elara.${format}`)
      assert.ok(output.document.equals(fixture))
      assert.equal(output.mimetype, format === 'pdf' ? 'application/pdf'
        : format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      assert.equal(sent.slice(before).some(item => item.remoteJid === jid
        && item.text?.includes(`fixture:fixture kirim dokumen ${format}`)), false)
    }

    const createBefore = sent.length
    emitMessage(jid, 'fixture-create-xlsx', 'fixture buatkan xlsx laporan')
    const created = await waitFor(() => sent.slice(createBefore).find(item => item.remoteJid === jid
      && Buffer.isBuffer(item.document)), 'XLSX creation intent')
    assert.equal(created.fileName, 'dokumen-elara.xlsx')
    assert.equal(created.mimetype, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    const missingStart = sent.length
    emitMessage(jid, 'fixture-document-missing', 'kirim dokumen docx yang belum ada')
    await waitFor(() => sent.slice(missingStart).find(item => item.remoteJid === jid
      && item.text?.includes('belum berhasil')), 'missing document response')
    assert.equal(sent.slice(missingStart).some(item => item.remoteJid === jid && item.document), false)

    const otherStart = sent.length
    emitMessage('user-a@s.whatsapp.net', 'fixture-document-nonowner', 'kirim dokumen pdf')
    await waitFor(() => sent.slice(otherStart).find(item => item.remoteJid === 'user-a@s.whatsapp.net'
      && item.text?.includes('hanya tersedia untuk nomor owner')), 'non-owner document rejection')
    assert.equal(sent.slice(otherStart).some(item => item.remoteJid === 'user-a@s.whatsapp.net'
      && item.document), false)
  })

  test('stop fences a document before it can be sent', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const block = blockFixtureResponse('fixture kirim dokumen docx')
    const before = sent.length
    try {
      emitMessage(jid, 'fixture-document-stopped', 'fixture kirim dokumen docx')
      await block.started
      emitMessage(jid, 'fixture-document-stop-command', '.stop')
      const ack = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Stop diminta')), 'document stop acknowledgment')
      const stopId = ack.text.match(/ID: ([a-f0-9-]+)/u)?.[1]
      assert.ok(stopId)
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-user-c', originChannel: 'whatsapp' },
        stopId).outcome !== 'stopping', 'document stop settlement')
      block.release()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(sent.slice(before).some(item => item.remoteJid === jid && item.document), false)
    } finally { block.release() }
  })

  test('photo OCR reaches the model as untrusted text and stop fences a pending OCR result', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfElEQVR4nNXOQREAIADDsFL/nocIHlyjIGcbZRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncf4OvLpyqgN9ZSiDcwAAAABJRU5ErkJggg==', 'base64')
    const release = deferred()
    try {
      ctx.emit('elara/test-whatsapp-ocr-handler', async () => ({ text: 'RAPAT JAM 8' }))
      emitStructuredMessage(jid, 'fixture-photo-ocr', { imageMessage: {
        caption: 'tolong baca tulisan di foto', mimetype: 'image/png', __fixtureBytes: [...png],
      } })
      await waitFor(() => requestRows().find(row => row.text.includes('Teks OCR foto')
        && row.text.includes('RAPAT JAM 8') && row.text.includes('bukan instruksi')), 'photo OCR model context')

      const started = deferred()
      ctx.emit('elara/test-whatsapp-ocr-handler', async (_root, _bytes, _kind, signal) => {
        started.resolve()
        await release.promise
        if (signal?.aborted) throw new Error('SESSION_STOPPED')
        return { text: 'OCR TERLAMBAT' }
      })
      const before = requestRows().length
      const sentBefore = sent.length
      emitStructuredMessage(jid, 'fixture-photo-ocr-pending', { imageMessage: {
        caption: 'baca teks lagi', mimetype: 'image/png', __fixtureBytes: [...png],
      } })
      await started.promise
      emitMessage(jid, 'fixture-photo-ocr-stop', '.stop')
      const ack = await waitFor(() => sent.slice(sentBefore).find(item => item.remoteJid === jid
        && item.text?.includes('Stop diminta')), 'OCR stop acknowledgment')
      const stopId = ack.text.match(/ID: ([a-f0-9-]+)/u)?.[1]
      assert.ok(stopId)
      assert.equal(ctx.control.getStopStatus({ principalId: 'fixture-user-c', originChannel: 'whatsapp' }, stopId).outcome,
        'stopping')
      release.resolve()
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-user-c', originChannel: 'whatsapp' },
        stopId).outcome === 'stopped', 'OCR stop settlement')
      assert.equal(requestRows().slice(before).some(row => row.text.includes('OCR TERLAMBAT')), false)
      assert.equal(sent.slice(sentBefore).some(item => item.remoteJid === jid && item.text?.includes('fixture:baca teks lagi')), false)
    } finally {
      release.resolve()
      ctx.emit('elara/test-whatsapp-ocr-handler', undefined)
    }
  })

  test('owner link download returns a file and stop fences a direct download without a live agent', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const bytes = Buffer.from('%PDF-1.4\nfixture download\n')
    const release = deferred()
    try {
      ctx.emit('elara/test-whatsapp-download-handler', async (_url, _root, _senderKey, _operationId, signal) => {
        if (signal.aborted) throw new Error('SESSION_STOPPED')
        return { filePath: path.join(fixtureRoot, '.runtime', 'downloads', 'elara', 'fixture.pdf'),
          fileName: 'fixture.pdf', mime: 'application/pdf', bytes }
      })
      const successBefore = sent.length
      emitMessage(jid, 'fixture-download-success', 'unduh https://files.example.com/fixture.pdf')
      const delivered = await waitFor(() => sent.slice(successBefore).find(item => item.remoteJid === jid
        && Buffer.isBuffer(item.document)), 'downloaded file delivery')
      assert.ok(delivered.document.equals(bytes))
      assert.equal(delivered.fileName, 'fixture.pdf')
      const auditDb = new DatabaseSync(path.join(fixtureRoot, 'control', 'elara-control.db'))
      try {
        const rows = auditDb.prepare("SELECT operation_id, execution_id, event_type, reason_code FROM audit_events WHERE reason_code IN ('PUBLIC_FILE_DOWNLOAD', 'DOWNLOAD_COMPLETED') ORDER BY id DESC LIMIT 2").all()
        assert.equal(rows.length, 2)
        assert.equal(rows[0].operation_id, rows[1].operation_id)
        assert.equal(rows[0].execution_id, rows[1].execution_id)
        assert.equal(JSON.stringify(rows).includes('files.example.com'), false)
      } finally { auditDb.close() }
      const otherBefore = sent.length
      emitMessage('user-a@s.whatsapp.net', 'fixture-download-other', '.download https://files.example.com/fixture.pdf')
      await waitFor(() => sent.slice(otherBefore).find(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.includes('hanya tersedia untuk nomor owner')), 'nonowner download denial')
      assert.equal(sent.slice(otherBefore).some(item => item.remoteJid === 'user-a@s.whatsapp.net' && item.document), false)

      const originalAudit = ctx.access.recordAudit
      let downloadStarted = false
      ctx.emit('elara/test-whatsapp-download-handler', async () => {
        downloadStarted = true
        return { filePath: 'fixture.pdf', fileName: 'fixture.pdf', mime: 'application/pdf', bytes }
      })
      const failureBefore = sent.length
      try {
        ctx.access.recordAudit = () => { throw new Error('AUDIT_UNAVAILABLE') }
        emitMessage(jid, 'fixture-download-audit-failure', '.download https://files.example.com/fixture.pdf')
        await waitFor(() => sent.slice(failureBefore).find(item => item.remoteJid === jid
          && item.text?.includes('pencatatan audit sedang bermasalah')), 'download audit failure')
        assert.equal(downloadStarted, false)
      } finally { ctx.access.recordAudit = originalAudit }

      const freshBefore = sent.length
      emitMessage(jid, 'fixture-download-new-session', '.new')
      await waitFor(() => sent.slice(freshBefore).find(item => item.remoteJid === jid
        && item.text?.includes('konteks baru')), 'fresh download session')
      const started = deferred()
      ctx.emit('elara/test-whatsapp-download-handler', async (_url, _root, _senderKey, _operationId, signal) => {
        started.resolve()
        await release.promise
        if (signal.aborted) throw new Error('SESSION_STOPPED')
        return { filePath: 'fixture.pdf', fileName: 'fixture.pdf', mime: 'application/pdf', bytes }
      })
      const stoppedBefore = sent.length
      emitMessage(jid, 'fixture-download-pending', '.download https://files.example.com/fixture.pdf')
      await started.promise
      emitMessage(jid, 'fixture-download-stop', '.stop')
      const ack = await waitFor(() => sent.slice(stoppedBefore).find(item => item.remoteJid === jid
        && item.text?.includes('Stop diminta')), 'download stop acknowledgment')
      const stopId = ack.text.match(/ID: ([a-f0-9-]+)/u)?.[1]
      assert.ok(stopId)
      const context = { principalId: 'fixture-user-c', originChannel: 'whatsapp' }
      assert.equal(ctx.control.getStopStatus(context, stopId).outcome, 'stopping')
      release.resolve()
      await waitFor(() => ctx.control.getStopStatus(context, stopId).outcome === 'stopped',
        'direct download stop settlement')
      assert.equal(sent.slice(stoppedBefore).some(item => item.remoteJid === jid && item.document), false)
    } finally {
      release.resolve()
      ctx.emit('elara/test-whatsapp-download-handler', undefined)
    }
  })

  test('only the exact trusted owner alias receives owner identity in the model context', async () => {
    emitMessage('user-c@s.whatsapp.net', 'fixture-owner-identity', 'siapa aku fixture owner')
    const owner = await waitFor(() => requestRows().find(row => row.text === 'siapa aku fixture owner'),
      'trusted owner model request')
    assert.equal(owner.trustedSpeakerCount, 1)

    emitMessage('user-a@s.whatsapp.net', 'fixture-nonowner-identity', 'siapa aku fixture nonowner')
    const other = await waitFor(() => requestRows().find(row => row.text === 'siapa aku fixture nonowner'),
      'ordinary sender model request')
    assert.equal(other.trustedSpeakerCount, 0)
  })

  test('trusted WhatsApp ingress preserves quoted context and adaptive typing lifecycle', async () => {
    const jid = 'user-a@s.whatsapp.net'
    const beforeSent = sent.length
    emitStructuredMessage(jid, 'fixture-quoted-context', {
      extendedTextMessage: {
        text: 'bagian mana yang perlu dicek?',
        contextInfo: { quotedMessage: { imageMessage: { caption: 'diagram kiri' } } },
      },
    })
    await waitFor(() => requestRows().find(row => row.text.includes('bagian mana yang perlu dicek?')),
      'quoted provider request')
    const quoted = requestRows().find(row => row.text.includes('bagian mana yang perlu dicek?'))
    assert.match(quoted.text, /Jenis gambar/)
    assert.match(quoted.text, /diagram kiri/)
    await waitFor(() => sent.length > beforeSent, 'quoted WhatsApp reply')

    const beforePresence = presence.length
    emitMessage(jid, 'fixture-short-typing', 'iya')
    const short = await waitFor(() => typing.find(item => item.jid === jid
      && item.bubble.includes('fixture:iya'))?.milliseconds, 'short typing plan')
    const longMessage = 'tolong jelaskan langkah pemeriksaan ini secara terperinci untuk proyek fixture '
      + 'dan tunjukkan urutan yang aman untuk menjalankannya'
    emitMessage(jid, 'fixture-long-typing', longMessage)
    const long = await waitFor(() => typing.find(item => item.jid === jid
      && item.bubble.includes('fixture:tolong jelaskan langkah pemeriksaan ini'))?.milliseconds, 'long typing plan')
    assert.ok(long > short)
    await waitFor(() => presence.slice(beforePresence).filter(item => item.jid === jid && item.state === 'paused').length >= 2,
      'typing pauses')
    const states = presence.slice(beforePresence).filter(item => item.jid === jid).map(item => item.state)
    assert.ok(states.includes('composing'))
    assert.ok(states.includes('paused'))
  })

  test('trusted WhatsApp voice note reaches the configured synthetic transcription service', async () => {
    const server = http.createServer((request, response) => {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/audio/transcriptions')
      request.resume()
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ text: 'voice fixture terverifikasi' }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const previous = process.env.ELARA_TRANSCRIPTION_BASE_URL
    process.env.ELARA_TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${address.port}/v1`
    const jid = 'user-a@s.whatsapp.net'
    try {
      emitStructuredMessage(jid, 'fixture-voice-note', {
        audioMessage: { ptt: true, mimetype: 'audio/ogg', __fixtureBytes: [79, 103, 103, 83, 1, 2, 3] },
      })
      const row = await waitFor(() => requestRows().find(item => item.text.includes('voice fixture terverifikasi')),
        'voice transcript in provider request')
      assert.match(row.text, /Transkripsi voice note/)
      await waitFor(() => sent.find(item => item.remoteJid === jid && item.text?.includes('voice fixture terverifikasi')),
        'voice note reply')
    } finally {
      if (previous === undefined) delete process.env.ELARA_TRANSCRIPTION_BASE_URL
      else process.env.ELARA_TRANSCRIPTION_BASE_URL = previous
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('owner explicitly requests an Opus voice reply while other senders cannot', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const audio = Buffer.alloc(40)
    audio.write('OggS', 0, 'ascii')
    audio.write('OpusHead', 28, 'ascii')
    const spoken = []
    ctx.emit('elara/test-whatsapp-voice-handler', {
      async synthesize(text) { spoken.push(text); return audio },
    })
    try {
      const before = sent.length
      emitMessage(jid, 'fixture-voice-outbound', '.voice ceritain kabarmu')
      const note = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && Buffer.isBuffer(item.audio) && item.ptt === true), 'owner voice reply')
      assert.deepEqual(note.audio, audio)
      assert.equal(note.mimetype, 'audio/ogg; codecs=opus')
      assert.ok(spoken.some(text => text.includes('ceritain kabarmu')))
      assert.ok(requestRows().some(row => row.text.includes('ceritain kabarmu') && !row.text.includes('.voice ceritain kabarmu')))
      assert.equal(sent.slice(before).some(item => item.remoteJid === jid && item.text?.includes('fixture:ceritain kabarmu')), false)
      const senderKey = crypto.createHash('sha256').update(jid).digest('hex').slice(0, 24)
      const sessionState = JSON.parse(fs.readFileSync(path.join(fixtureRoot, '.runtime', 'whatsapp-sessions.json'), 'utf8'))
      const sessionId = sessionState[senderKey] || `whatsapp:${jid}`
      const audit = await waitFor(() => {
        const rows = ctx.control.listAudit({ principalId: 'fixture-user-c', originChannel: 'whatsapp' },
          sessionId)
        return rows.some(row => row.reasonCode === 'VOICE_REPLY_COMPLETED') ? rows : undefined
      }, 'voice audit settlement')
      assert.doesNotMatch(JSON.stringify(audit), /ceritain kabarmu/)
      const otherBefore = sent.length
      emitMessage('user-a@s.whatsapp.net', 'fixture-voice-other', '.voice hai')
      await waitFor(() => sent.slice(otherBefore).some(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.includes('hanya untuk nomor owner')), 'non-owner voice denial')
      assert.equal(sent.slice(otherBefore).some(item => item.remoteJid === 'user-a@s.whatsapp.net' && item.audio), false)
    } finally { ctx.emit('elara/test-whatsapp-voice-handler', undefined) }
  })

  test('voice dispatch fails closed when durable audit cannot record it', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const originalAudit = ctx.access.recordAudit
    let syntheses = 0
    const before = sent.length
    ctx.emit('elara/test-whatsapp-voice-handler', {
      async synthesize() { syntheses++; throw new Error('SHOULD_NOT_SYNTHESIZE') },
    })
    try {
      ctx.access.recordAudit = () => { throw new Error('AUDIT_UNAVAILABLE') }
      emitMessage(jid, 'fixture-voice-audit-failure', '.voice halo setelah audit gagal')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Suara belum bisa kukirim')), 'voice audit failure fallback')
      assert.equal(syntheses, 0)
      assert.equal(sent.slice(before).some(item => item.remoteJid === jid && item.audio), false)
    } finally {
      ctx.access.recordAudit = originalAudit
      ctx.emit('elara/test-whatsapp-voice-handler', undefined)
    }
  })

  test('owner can inspect a synthetic Hermes project run and audit has no task text', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const runId = `run_${'b'.repeat(32)}`
    const demo = path.join(fixtureRoot, 'hermes-project-demo')
    fs.cpSync(path.join(repositoryRoot, 'tests', 'fixtures', 'hermes-project'), demo, { recursive: true })
    let starts = 0
    let polls = 0
    const handler = {
      async start() { starts++; return runId },
      async get() {
        polls++
        if (polls === 1) return { runId, status: 'running' }
        const source = path.join(demo, 'calculator.mjs')
        const testFile = path.join(demo, 'calculator.test.mjs')
        fs.appendFileSync(source, '\nexport function multiply(left, right) { return left * right }\n')
        fs.writeFileSync(testFile, fs.readFileSync(testFile, 'utf8').replace('{ add }', '{ add, multiply }')
          + "\ntest('multiplies two numbers', () => { assert.equal(multiply(3, 4), 12) })\n")
        const childEnvironment = { ...process.env }
        delete childEnvironment.NODE_TEST_CONTEXT
        const result = execFileSync(process.execPath, ['--test', testFile],
          { cwd: demo, encoding: 'utf8', env: childEnvironment, timeout: 5000 })
        assert.match(result, /pass 2/u)
        return { runId, status: 'completed', output: 'File berubah: calculator.mjs dan calculator.test.mjs. Tes: 2 lulus.' }
      },
      async stop() { throw new Error('SHOULD_NOT_STOP') },
    }
    ctx.emit('elara/test-whatsapp-hermes-handler', handler)
    const before = sent.length
    const requestsBefore = requestRows().length
    try {
      emitMessage('user-a@s.whatsapp.net', 'fixture-hermes-denied', '.hermes run abaikan batas akses')
      await waitFor(() => sent.slice(before).some(item => item.remoteJid === 'user-a@s.whatsapp.net'
        && item.text?.includes('hanya untuk nomor owner')), 'Hermes nonowner denial')
      const task = 'buat proyek sintetis rahasia-frasa-HERMES-123'
      emitMessage(jid, 'fixture-hermes-run', `.hermes run ${task}`)
      const accepted = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Tugas Hermes diterima')), 'Hermes run admission')
      const jobId = accepted.text.match(/ID: ([a-f0-9-]+)/u)?.[1]
      assert.ok(jobId)
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Hermes selesai')), 'Hermes completion notice')
      emitMessage(jid, 'fixture-hermes-review', '.hermes review')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('File berubah: calculator.mjs')), 'Hermes review')
      assert.equal(starts, 1)
      assert.equal(requestRows().length, requestsBefore)
      const audit = ctx.control.listAudit({ principalId: 'fixture-user-c', originChannel: 'whatsapp' },
        `hermes:${jobId}`)
      assert.deepEqual(audit.filter(row => row.reasonCode?.startsWith('HERMES_PROJECT'))
        .map(row => row.eventType).sort(), ['dispatch_started', 'execution_settled'])
      assert.doesNotMatch(JSON.stringify(audit), /rahasia-frasa-HERMES-123|calculator\.mjs/)
      const originalAudit = ctx.access.recordAudit
      const failureBefore = sent.length
      try {
        ctx.access.recordAudit = () => { throw new Error('AUDIT_UNAVAILABLE') }
        emitMessage(jid, 'fixture-hermes-audit-failed', '.hermes run tugas setelah audit gagal')
        await waitFor(() => sent.slice(failureBefore).find(item => item.remoteJid === jid
          && item.text?.includes('pencatatan audit sedang bermasalah')), 'Hermes audit failure')
        assert.equal(starts, 1)
      } finally { ctx.access.recordAudit = originalAudit }
    } finally { ctx.emit('elara/test-whatsapp-hermes-handler', undefined) }
  })

  test('WhatsApp .stop requests Hermes cancellation without claiming remote processes stopped', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const runId = `run_${'c'.repeat(32)}`
    const entered = deferred()
    const release = deferred()
    let stopCalls = 0
    ctx.emit('elara/test-whatsapp-hermes-handler', {
      async start() { return runId },
      async get() { entered.resolve(); await release.promise; return { runId, status: 'cancelled' } },
      async stop() { stopCalls++ },
    })
    const before = sent.length
    try {
      emitMessage(jid, 'fixture-hermes-pending', '.hermes run ubah berkas contoh lalu tes')
      await entered.promise
      emitMessage(jid, 'fixture-hermes-stop', '.stop')
      const ack = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Hermes: stopping')), 'Hermes stop acknowledgment')
      const stopId = ack.text.match(/Hermes: stopping \(ID ([a-f0-9-]+)\)/u)?.[1]
      assert.ok(stopId)
      assert.equal(stopCalls, 1)
      assert.equal(ctx.control.getStopStatus({ principalId: 'fixture-user-c', originChannel: 'whatsapp' },
        stopId).outcome, 'stopping')
      release.resolve()
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-user-c', originChannel: 'whatsapp' },
        stopId).outcome === 'unconfirmed', 'Hermes remote stop uncertainty')
      emitMessage(jid, 'fixture-hermes-status-after-stop', '.hermes status')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('proses turunan belum terverifikasi')), 'Hermes honest status')
      emitMessage('user-b@s.whatsapp.net', 'fixture-other-after-hermes-stop', 'sesi lain tetap jalan')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === 'user-b@s.whatsapp.net'
        && item.text?.includes('fixture:sesi lain tetap jalan')), 'unaffected session after Hermes stop')
    } finally {
      release.resolve()
      ctx.emit('elara/test-whatsapp-hermes-handler', undefined)
    }
  })

  test('a fixture-owned process settles a Hermes stop only after its exit is verified', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const runId = `run_${'d'.repeat(32)}`
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { shell: false, windowsHide: true, stdio: 'ignore' })
    const pid = child.pid
    assert.ok(pid)
    const closed = new Promise(resolve => child.once('close', resolve))
    const entered = deferred()
    let stopped = false
    ctx.emit('elara/test-whatsapp-hermes-handler', {
      async start() { return runId },
      async get() { entered.resolve(); return { runId, status: stopped ? 'cancelled' : 'running' } },
      async stop() { child.kill(); await closed; stopped = true },
      async verifyStopped() {
        if (!stopped) return false
        try { process.kill(pid, 0); return false }
        catch { return true }
      },
    })
    const before = sent.length
    try {
      emitMessage(jid, 'fixture-hermes-owned-run', '.hermes run proses contoh yang bisa dihentikan')
      await entered.promise
      emitMessage(jid, 'fixture-hermes-owned-stop', '.hermes stop')
      const ack = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Stop Hermes diminta')), 'owned Hermes stop acknowledgment')
      const stopId = ack.text.match(/ID: ([a-f0-9-]+)/u)?.[1]
      assert.ok(stopId)
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-user-c', originChannel: 'whatsapp' },
        stopId).outcome === 'stopped', 'verified fixture stop')
      assert.equal(stopped, true)
      assert.throws(() => process.kill(pid, 0), /ESRCH|not found|no such process/i)
      emitMessage(jid, 'fixture-hermes-owned-status', '.hermes status')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Hermes (proyek contoh): cancelled')
        && !item.text.includes('belum terverifikasi')), 'verified fixture status')
    } finally {
      child.kill()
      ctx.emit('elara/test-whatsapp-hermes-handler', undefined)
    }
  })

  test('WhatsApp memory commands isolate principals and reset only the requesting session', async () => {
    const a = 'user-a@s.whatsapp.net'
    const b = 'user-b@s.whatsapp.net'
    emitMessage(a, 'fixture-remember-a', '.remember fixture aprikot biru')
    await waitFor(() => ctx.memory.list('fixture-user-a').some(row => row.content.includes('aprikot biru')),
      'principal-a memory')
    emitMessage(b, 'fixture-memory-list-b', '.memories')
    await waitFor(() => sent.find(item => item.remoteJid === b && item.text === 'belum ada ingatan'),
      'principal-b empty memory')
    assert.deepEqual(ctx.memory.list('fixture-user-b'), [])
    emitMessage(a, 'fixture-memory-list-a', '.memories')
    await waitFor(() => sent.find(item => item.remoteJid === a && item.text?.includes('fixture aprikot biru')),
      'principal-a memory reply')

    const oldSession = `whatsapp:${b}`
    const beforeSent = sent.length
    emitMessage(b, 'fixture-session-reset-b', '.new')
    await waitFor(() => sent.length > beforeSent && sent.at(-1).remoteJid === b
      && sent.at(-1).text?.includes('konteks baru'), 'session reset reply')
    const saved = JSON.parse(fs.readFileSync(path.join(fixtureRoot, '.runtime', 'whatsapp-sessions.json'), 'utf8'))
    const newSession = saved[crypto.createHash('sha256').update(b).digest('hex').slice(0, 24)]
    assert.match(newSession, /^whatsapp:[a-f0-9]{24}:/)
    assert.equal(ctx.access.bindingForSession(newSession)?.principalId, 'fixture-user-b')
    emitMessage(b, 'fixture-session-after-reset', 'pesan setelah reset')
    await waitFor(() => ctx.agents.get(RuntimeSessionId(newSession)), 'fresh session after reset')
    await waitFor(() => sent.find(item => item.remoteJid === b && item.text?.includes('fixture:pesan setelah reset')),
      'reply from fresh session')
    assert.equal(ctx.access.bindingForSession(oldSession)?.principalId, 'fixture-user-b')
  })

  test('WhatsApp .stop bypasses the conversation queue and acknowledges only its sender scope', async () => {
    const jid = 'user-a@s.whatsapp.net'
    const beforeRequests = requestRows().length
    const beforeSent = sent.length
    emitMessage(jid, 'fixture-stop-command', '.stop')
    const ack = await waitFor(() => sent.slice(beforeSent).find(item => item.remoteJid === jid
      && item.text?.includes('ID')), 'stop acknowledgment')
    assert.match(ack.text, /Stop diminta|Tidak ada pekerjaan aktif/)
    assert.equal(requestRows().length, beforeRequests)
    emitMessage('user-b@s.whatsapp.net', 'fixture-other-after-stop', 'tetap jalan')
    await waitFor(() => sent.find(item => item.remoteJid === 'user-b@s.whatsapp.net'
      && item.text?.includes('fixture:tetap jalan')), 'other session reply after stop')
    emitMessage(jid, 'fixture-new-after-stop', 'mulai lagi')
    await waitFor(() => sent.find(item => item.remoteJid === jid && item.text?.includes('fixture:mulai lagi')),
      'fresh work after confirmed stop')
  })

  test('a delayed .pc result cannot reply or finish stop before its direct operation settles', async () => {
    const jid = 'user-a@s.whatsapp.net'
    const original = ctx.access.executeDirect
    const entered = deferred()
    const release = deferred()
    const before = sent.length
    ctx.access.executeDirect = async request => {
      entered.resolve(request.signal)
      await release.promise // Synthetic adapter ignores abort so settlement remains observable.
      return 'fixture stale pc result'
    }
    try {
      emitMessage(jid, 'fixture-delayed-pc', '.pc')
      const signal = await entered.promise
      emitMessage(jid, 'fixture-stop-delayed-pc', '.stop')
      const ack = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Stop diminta')), 'direct stop acknowledgment')
      const id = ack.text.match(/ID: ([a-f0-9-]+)/)?.[1]
      assert.ok(id)
      assert.equal(signal.aborted, true)
      assert.equal(ctx.control.getStopStatus({ principalId: 'fixture-user-a', originChannel: 'whatsapp' }, id).outcome,
        'stopping')
      release.resolve()
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-user-a', originChannel: 'whatsapp' }, id).outcome
        === 'stopped', 'direct stop settlement')
      assert.equal(sent.slice(before).some(item => item.text?.includes('fixture stale pc result')), false)
      ctx.access.executeDirect = async () => 'fixture fresh pc result'
      emitMessage(jid, 'fixture-fresh-pc', '.pc')
      await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('fixture fresh pc result')), 'fresh direct status reply')
    } finally {
      release.resolve()
      ctx.access.executeDirect = original
    }
  })

  test('dashboard status returns a stop response after its direct operation is cancelled', async () => {
    const original = ctx.access.executeDirect
    const entered = deferred()
    const release = deferred()
    const headers = { Authorization: `Bearer ${dashboardToken}` }
    ctx.access.executeDirect = async request => {
      entered.resolve(request.signal)
      await release.promise
      return 'fixture stale dashboard status'
    }
    try {
      const statusRequest = fetch(`${dashboardUrl}/api/status`, { headers })
      const signal = await entered.promise
      const stopResponse = await fetch(`${dashboardUrl}/api/sessions/${encodeURIComponent('dashboard:control')}/stop`,
        { method: 'POST', headers })
      assert.equal(stopResponse.status, 202)
      const { stopRequestId } = await stopResponse.json()
      assert.equal(signal.aborted, true)
      assert.equal(ctx.control.getStopStatus({ principalId: 'fixture-operator', originChannel: 'dashboard' },
        stopRequestId).outcome, 'stopping')
      release.resolve()
      const response = await statusRequest
      assert.equal(response.status, 409)
      assert.doesNotMatch(JSON.stringify(await response.json()), /fixture stale dashboard status/)
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-operator', originChannel: 'dashboard' },
        stopRequestId).outcome === 'stopped', 'dashboard direct stop settlement')
    } finally {
      release.resolve()
      ctx.access.executeDirect = original
    }
  })

  test('a cancelled companion status wait cannot confirm remote termination', async () => {
    const sessionId = 'dashboard:remote-status-fixture'
    const owner = { principalId: 'fixture-operator', originChannel: 'dashboard' }
    ctx.access.bindRootSession(sessionId, owner.principalId, owner.originChannel)
    const admission = ctx.control.admit(owner, sessionId)
    const entered = deferred()
    const release = deferred()
    const adapter = {
      control: ctx.control,
      access: { executeDirect: async (_request, operation) => operation(), deviceKind: () => 'companion' },
      companion: { executeTool: async () => { entered.resolve(); await release.promise; return 'remote finished' } },
    }
    const operation = executeReviewedWindowsTool(adapter,
      { ...owner, sessionId, targetDeviceId: 'synthetic-companion', source: 'dashboard:status',
        capabilityId: 'system.status' }, 'elara_windows_status', {}, admission)
    try {
      await entered.promise
      const stop = ctx.control.requestStop(owner, sessionId)
      assert.equal(stop.outcome, 'stopping')
      release.resolve()
      await operation
      await waitFor(() => ctx.control.getStopStatus(owner, stop.id).outcome === 'unconfirmed',
        'remote wait unconfirmed settlement')
    } finally { release.resolve() }
  })

  test('stop during model work invalidates an older queued WhatsApp message', async () => {
    const jid = 'user-a@s.whatsapp.net'
    const firstText = 'fixture blocked model work'
    const queuedText = 'fixture queued before stop'
    const block = blockFixtureResponse(firstText)
    let started = false
    void block.started.then(() => { started = true })
    const beforeSent = sent.length
    try {
      emitMessage(jid, 'fixture-blocked-model', firstText)
      await waitFor(() => started, 'blocked model request')
      emitMessage(jid, 'fixture-queued-before-stop', queuedText)
      emitMessage(jid, 'fixture-stop-model-queue', '.stop')
      const ack = await waitFor(() => sent.slice(beforeSent).find(item => item.remoteJid === jid
        && item.text?.includes('Stop diminta')), 'model stop acknowledgment')
      const id = ack.text.match(/ID: ([a-f0-9-]+)/)?.[1]
      assert.ok(id)
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-user-a', originChannel: 'whatsapp' }, id).outcome !== 'stopping',
        'model stop settlement')
      block.release()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(requestRows().some(row => row.text === queuedText), false)
      assert.equal(sent.slice(beforeSent).some(item => item.text?.includes(`fixture:${queuedText}`)), false)
      assert.equal(sent.slice(beforeSent).some(item => item.text?.includes(`fixture:${firstText}`)), false)
      emitMessage(jid, 'fixture-fresh-after-model-stop', 'fresh after model stop')
      await waitFor(() => sent.find(item => item.remoteJid === jid
        && item.text?.includes('fixture:fresh after model stop')), 'fresh model work after stop')
    } finally { block.release() }
  })

  test('stop during voice transcription suppresses the stale model submission', async () => {
    let releaseResponse
    let entered
    const enteredPromise = new Promise(resolve => { entered = resolve })
    const responseGate = new Promise(resolve => { releaseResponse = resolve })
    const server = http.createServer(async (request, response) => {
      request.resume()
      entered()
      await responseGate
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ text: 'fixture stopped transcription' }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const previous = process.env.ELARA_TRANSCRIPTION_BASE_URL
    process.env.ELARA_TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
    const jid = 'user-a@s.whatsapp.net'
    const before = requestRows().length
    try {
      emitStructuredMessage(jid, 'fixture-voice-stop', {
        audioMessage: { ptt: true, mimetype: 'audio/ogg', __fixtureBytes: [79, 103, 103, 83, 4, 5, 6] },
      })
      await enteredPromise
      const stop = ctx.control.requestStop({ principalId: 'fixture-user-a', originChannel: 'whatsapp' }, `whatsapp:${jid}`)
      releaseResponse()
      await waitFor(() => ctx.control.getStopStatus({ principalId: 'fixture-user-a', originChannel: 'whatsapp' },
        stop.id).outcome !== 'stopping', 'voice stop settlement')
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(requestRows().slice(before).some(row => row.text.includes('fixture stopped transcription')), false)
    } finally {
      releaseResponse()
      if (previous === undefined) delete process.env.ELARA_TRANSCRIPTION_BASE_URL
      else process.env.ELARA_TRANSCRIPTION_BASE_URL = previous
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('stop at typing boundary suppresses a stale reply bubble', async () => {
    const jid = 'user-a@s.whatsapp.net'
    const text = 'fixture typing stop boundary'
    const before = sent.length
    let stopped = false
    const off = ctx.on('elara/test-whatsapp-typing-delay', payload => {
      if (payload.jid !== jid || !payload.bubble?.includes(text) || stopped) return
      stopped = true
      ctx.control.requestStop({ principalId: 'fixture-user-a', originChannel: 'whatsapp' }, `whatsapp:${jid}`)
    })
    try {
      emitMessage(jid, 'fixture-stop-typing', text)
      await waitFor(() => stopped, 'typing boundary stop')
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(sent.slice(before).some(item => item.remoteJid === jid && item.text?.includes(`fixture:${text}`)), false)
    } finally { off() }
  })

  test('stop during agent setup prevents the admitted message from reaching the model', async () => {
    const jid = 'user-b@s.whatsapp.net'
    const statePath = path.join(fixtureRoot, '.runtime', 'whatsapp-sessions.json')
    const previousSessions = new Set(Object.values(JSON.parse(fs.readFileSync(statePath, 'utf8'))))
    const beforeSent = sent.length
    emitMessage(jid, 'fixture-setup-reset', '.new')
    await waitFor(() => sent.slice(beforeSent).some(item => item.remoteJid === jid
      && item.text?.includes('konteks baru')), 'setup reset')
    const currentSessions = Object.values(JSON.parse(fs.readFileSync(statePath, 'utf8')))
    const sessionId = currentSessions.find(id => !previousSessions.has(id))
    assert.ok(sessionId)
    let entered
    let release
    const enteredPromise = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const off = ctx.on('agent/created', async ({ agent }) => {
      if (String(agent.id) !== sessionId) return undefined
      entered()
      await gate
      return undefined
    })
    const text = 'fixture stopped during setup'
    try {
      emitMessage(jid, 'fixture-setup-blocked', text)
      await enteredPromise
      ctx.control.requestStop({ principalId: 'fixture-user-b', originChannel: 'whatsapp' }, sessionId)
      release()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(requestRows().some(row => row.text === text), false)
    } finally { release(); off() }
  })

  test('stop waits for voice synthesis and prevents a stale audio send', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const resetBefore = sent.length
    emitMessage(jid, 'fixture-voice-stop-reset', '.new')
    await waitFor(() => sent.slice(resetBefore).some(item => item.remoteJid === jid
      && item.text?.includes('konteks baru')), 'voice stop fresh session')
    const entered = deferred()
    const release = deferred()
    const audio = Buffer.alloc(40)
    audio.write('OggS', 0, 'ascii')
    audio.write('OpusHead', 28, 'ascii')
    ctx.emit('elara/test-whatsapp-voice-handler', {
      async synthesize() { entered.resolve(); await release.promise; return audio },
    })
    const before = sent.length
    try {
      emitMessage(jid, 'fixture-voice-stopped-request', '.voice kabar terbaru')
      await entered.promise
      emitMessage(jid, 'fixture-voice-stop-command', '.stop')
      const ack = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Stop diminta')), 'voice stop acknowledgment')
      const id = ack.text.match(/ID: ([a-f0-9-]+)/)?.[1]
      assert.ok(id)
      const scope = { principalId: 'fixture-user-c', originChannel: 'whatsapp' }
      assert.equal(ctx.control.getStopStatus(scope, id).outcome, 'stopping')
      release.resolve()
      await waitFor(() => ctx.control.getStopStatus(scope, id).outcome !== 'stopping', 'voice stop settlement')
      assert.equal(ctx.control.getStopStatus(scope, id).outcome, 'stopped')
      assert.equal(sent.slice(before).some(item => item.remoteJid === jid && item.audio), false)
    } finally { release.resolve(); ctx.emit('elara/test-whatsapp-voice-handler', undefined) }
  })

  test('calendar creation in a direct operation keeps stop pending and suppresses the stale reply', async () => {
    const jid = 'user-c@s.whatsapp.net'
    const resetBefore = sent.length
    emitMessage(jid, 'fixture-calendar-stop-reset', '.new')
    await waitFor(() => sent.slice(resetBefore).some(item => item.remoteJid === jid
      && item.text?.includes('konteks baru')), 'calendar stop fresh session')
    const entered = deferred()
    const release = deferred()
    const remote = {
      async create(event) { entered.resolve(); await release.promise; return event },
      async get() { return undefined },
      async delete() {},
    }
    ctx.emit('elara/test-calendar-handler', remote)
    const before = sent.length
    try {
      emitMessage(jid, 'fixture-calendar-stopped-plan', 'lusa jam 9 rapat sintetis')
      await entered.promise
      emitMessage(jid, 'fixture-calendar-stop-command', '.stop')
      const ack = await waitFor(() => sent.slice(before).find(item => item.remoteJid === jid
        && item.text?.includes('Stop diminta')), 'calendar stop acknowledgment')
      const id = ack.text.match(/ID: ([a-f0-9-]+)/)?.[1]
      assert.ok(id)
      const scope = { principalId: 'fixture-user-c', originChannel: 'whatsapp' }
      assert.equal(ctx.control.getStopStatus(scope, id).outcome, 'stopping')
      release.resolve()
      await waitFor(() => ctx.control.getStopStatus(scope, id).outcome !== 'stopping', 'calendar stop settlement')
      assert.equal(ctx.control.getStopStatus(scope, id).outcome, 'unconfirmed')
      assert.equal(sent.slice(before).some(item => item.remoteJid === jid && item.text?.includes('kuingetin')), false)
    } finally { release.resolve(); ctx.emit('elara/test-calendar-handler', undefined) }
  })
})
