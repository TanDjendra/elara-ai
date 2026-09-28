import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadAccessConfig, validateAccessConfig } from '../packages/policy/config.ts'
import {
  assessFilesystemTool,
  capabilityForTool,
  evaluatePolicy,
  executionRoute,
  isP2ARemoteCapability,
} from '../packages/policy/evaluate.ts'
import { AccessStore } from '../packages/policy/store.ts'

const temporaryRoots = []

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elara-access-test-'))
  temporaryRoots.push(root)
  return root
}

function config() {
  return {
    schemaVersion: 1,
    policyVersion: 'test-p2a-v1',
    devices: [
      { id: 'local-test', kind: 'local', enabled: true },
      { id: 'remote-test', kind: 'companion', enabled: true },
    ],
    principals: [
      {
        id: 'alice', role: 'user', enabled: true,
        channelAliases: { whatsapp: ['alice@s.whatsapp.net'] },
        allowedDeviceIds: ['local-test'],
      },
      {
        id: 'operator', role: 'operator', enabled: true,
        channelAliases: { dashboard: ['local-dashboard'] },
        allowedDeviceIds: ['local-test', 'remote-test'],
      },
    ],
    authorities: {
      dashboardPrincipalId: 'operator',
      hostDeviceId: 'local-test',
      channelDefaultDeviceIds: { whatsapp: 'local-test', dashboard: 'local-test' },
    },
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})

describe('access configuration', () => {
  test('accepts exact configured aliases without normalizing JID forms', () => {
    const parsed = validateAccessConfig(config())
    assert.deepEqual(parsed.principals[0].channelAliases.whatsapp, ['alice@s.whatsapp.net'])
    assert.equal(parsed.principals[0].channelAliases.whatsapp.includes('alice@lid'), false)
  })

  test('rejects an alias assigned to conflicting principals', () => {
    const value = config()
    value.principals[1].channelAliases = { whatsapp: ['alice@s.whatsapp.net'] }
    assert.throws(() => validateAccessConfig(value), /alias conflict/)
  })

  test('rejects unknown device references', () => {
    const value = config()
    value.principals[0].allowedDeviceIds = ['not-configured']
    assert.throws(() => validateAccessConfig(value), /unknown device/)
  })

  test('rejects unknown configuration fields', () => {
    const value = config()
    value.principals[0].principalId = 'spoofed'
    assert.throws(() => validateAccessConfig(value), /unknown fields/)
  })

  test('trusted owner identity must name an exact configured WhatsApp alias', () => {
    const value = config()
    value.principals[0].trustedWhatsAppOwner = { name: 'Tan', aliases: ['alice@s.whatsapp.net'] }
    assert.deepEqual(validateAccessConfig(value).principals[0].trustedWhatsAppOwner,
      { name: 'Tan', aliases: ['alice@s.whatsapp.net'] })
    value.principals[0].trustedWhatsAppOwner.aliases = ['unlisted@lid']
    assert.throws(() => validateAccessConfig(value), /configured WhatsApp aliases/)
  })

  test('requires an enabled local device as the actual DSH host', () => {
    const missing = config()
    delete missing.authorities.hostDeviceId
    assert.throws(() => validateAccessConfig(missing), /hostDeviceId/)
    const companion = config()
    companion.authorities.hostDeviceId = 'remote-test'
    assert.throws(() => validateAccessConfig(companion), /enabled local device/)
  })

  test('missing and corrupt local configuration disable managed execution with redacted diagnostics', () => {
    const root = temporaryRoot()
    const missing = loadAccessConfig(root)
    assert.equal(missing.enabled, false)
    assert.match(missing.diagnostic, /Managed execution disabled/)
    const target = path.join(root, 'access.json')
    fs.writeFileSync(target, '{broken')
    const corrupt = loadAccessConfig(root, target)
    assert.equal(corrupt.enabled, false)
    assert.doesNotMatch(corrupt.diagnostic, /\{broken/)
  })
})

test('managed WhatsApp membership persists and rolls back when audit cannot be recorded', () => {
  const file = path.join(temporaryRoot(), 'control.db')
  const alias = '6281234567890@s.whatsapp.net'
  const audit = (id, reasonCode) => ({ schemaVersion: 1, operationId: crypto.randomUUID(),
    executionId: id, principalId: 'owner', sessionId: 'whatsapp:owner', originChannel: 'whatsapp',
    eventType: 'membership_changed', reasonCode, outcome: 'completed', createdAt: Date.now() })
  let store = new AccessStore(file)
  try {
    assert.throws(() => store.addWhatsAppMember('wa-bad', alias, audit('wa-bad', 'invalid reason')),
      /AUDIT_FIELD_INVALID/)
    assert.deepEqual(store.listWhatsAppMembers(), [])
    store.addWhatsAppMember('wa-first', alias, audit('wa-first', 'MEMBER_ADDED'))
    assert.deepEqual(store.listWhatsAppMembers(), [{ id: 'wa-first', alias }])
    assert.throws(() => store.revokeWhatsAppMember('wa-first', audit('wa-first', 'invalid reason')),
      /AUDIT_FIELD_INVALID/)
    assert.equal(store.listWhatsAppMembers().length, 1)
    store.close()
    store = new AccessStore(file)
    assert.deepEqual(store.listWhatsAppMembers(), [{ id: 'wa-first', alias }])
    store.revokeWhatsAppMember('wa-first', audit('wa-first', 'MEMBER_REVOKED'))
    assert.deepEqual(store.listWhatsAppMembers(), [])
    store.addWhatsAppMember('wa-second', alias, audit('wa-second', 'MEMBER_ADDED'))
    assert.deepEqual(store.listWhatsAppMembers(), [{ id: 'wa-second', alias }])
    store.revokeWhatsAppMemberWithoutAudit('wa-second')
    assert.deepEqual(store.listWhatsAppMembers(), [])
  } finally { store.close() }
})

describe('durable immutable session ownership', () => {
  test('restores a binding after reopening the control database', () => {
    const dbPath = path.join(temporaryRoot(), 'control.db')
    const first = new AccessStore(dbPath)
    first.bindSession('session-a', 'alice', 'whatsapp')
    first.close()
    const second = new AccessStore(dbPath)
    assert.equal(second.bindingFor('session-a')?.principalId, 'alice')
    second.close()
  })

  test('allows idempotent binding but rejects cross-principal rebinding', () => {
    const store = new AccessStore(path.join(temporaryRoot(), 'control.db'))
    assert.equal(store.bindSession('session-a', 'alice', 'whatsapp').principalId, 'alice')
    assert.equal(store.bindSession('session-a', 'alice', 'whatsapp').principalId, 'alice')
    assert.throws(() => store.bindSession('session-a', 'operator', 'dashboard'), /SESSION_OWNER_CONFLICT/)
    store.close()
  })

  test('decision rows contain attribution but no prompt or argument column', () => {
    const store = new AccessStore(path.join(temporaryRoot(), 'control.db'))
    store.record({
      principalId: 'alice', sessionId: 'session-a', capabilityId: 'system.status',
      targetDeviceId: 'local-test', decision: 'allow', reasonCode: 'READ_ONLY_ALLOWED',
      policyVersion: 'test-p2a-v1', source: 'unit-test', createdAt: 1,
    })
    const columns = store.db.prepare('PRAGMA table_info(policy_decisions)').all().map(row => row.name)
    assert.equal(columns.includes('principal_id'), true)
    assert.equal(columns.includes('prompt'), false)
    assert.equal(columns.includes('arguments'), false)
    store.close()
  })
})

describe('P2A policy', () => {
  const parsed = validateAccessConfig(config())
  const context = {
    principalId: 'alice', sessionId: 'session-a', targetDeviceId: 'local-test',
    selectedDeviceId: 'local-test', runtimeMode: 'local', source: 'test',
  }

  test('allows reviewed read-only capability for the bound principal and device', () => {
    const decision = evaluatePolicy(parsed, context, capabilityForTool('elara_windows_status', {}), 'alice')
    assert.equal(decision.outcome, 'allow')
    assert.equal(decision.reasonCode, 'READ_ONLY_ALLOWED')
  })

  test('requires unavailable P2B approval for project and shell execution', () => {
    for (const tool of ['elara_project_test', 'pwsh', 'write']) {
      const decision = evaluatePolicy(parsed, context, capabilityForTool(tool, {}), 'alice')
      assert.equal(decision.outcome, 'approval_required')
      assert.equal(decision.reasonCode, 'P2A_APPROVAL_REQUIRED')
    }
  })

  test('unknown tools fail closed', () => {
    const decision = evaluatePolicy(parsed, context, capabilityForTool('invented_tool', {}), 'alice')
    assert.equal(decision.outcome, 'deny')
    assert.equal(decision.reasonCode, 'CAPABILITY_UNKNOWN')
  })

  test('rejects forged ownership and unauthorized targets', () => {
    assert.equal(
      evaluatePolicy(parsed, context, capabilityForTool('read', { path: 'README.md' }), 'operator').reasonCode,
      'SESSION_OWNER_UNTRUSTED',
    )
    assert.equal(
      evaluatePolicy(
        parsed,
        { ...context, selectedDeviceId: 'remote-test' },
        capabilityForTool('read', {}),
        'alice',
      ).reasonCode,
      'EXECUTION_TARGET_MISMATCH',
    )
  })

  test('missing policy state denies execution', () => {
    const decision = evaluatePolicy(undefined, context, capabilityForTool('read', {}), 'alice')
    assert.equal(decision.reasonCode, 'ACCESS_CONFIG_UNAVAILABLE')
  })

  test('companion admission permits only the reviewed read-only remote capability', () => {
    assert.equal(isP2ARemoteCapability('elara_windows_status'), true)
    for (const tool of ['elara_fs_write', 'elara_process_exec', 'elara_project_test', 'invented_tool']) {
      assert.equal(isP2ARemoteCapability(tool), false)
    }
  })

  test('authorized companion status remains available as a routed capability', () => {
    const decision = evaluatePolicy(
      parsed,
      {
        principalId: 'operator', sessionId: 'session-operator', targetDeviceId: 'remote-test',
        selectedDeviceId: 'remote-test', runtimeMode: 'local', source: 'test',
      },
      capabilityForTool('elara_windows_status', {}),
      'operator',
    )
    assert.equal(decision.outcome, 'allow')
    assert.equal(decision.capability.executionLocation, 'routed_device')
  })

  test('cloud mode never substitutes the server local machine for a local target', async () => {
    assert.throws(() => executionRoute('cloud', 'local'), /CLOUD_TARGET_MUST_BE_COMPANION/)
    assert.equal(executionRoute('cloud', 'companion'), 'companion')
    assert.equal(executionRoute('local', 'local'), 'local')
  })

  test('native host capability cannot be authorized against a selected companion', () => {
    const capability = capabilityForTool('read', {})
    assert.equal(capability.executionLocation, 'host')
    const decision = evaluatePolicy(
      parsed,
      { ...context, selectedDeviceId: 'remote-test' },
      capability,
      'alice',
    )
    assert.equal(decision.outcome, 'deny')
    assert.equal(decision.reasonCode, 'EXECUTION_TARGET_MISMATCH')
  })

  test('cloud mode disables native host execution even for the host authority', () => {
    const decision = evaluatePolicy(
      parsed,
      { ...context, runtimeMode: 'cloud' },
      capabilityForTool('read', {}),
      'alice',
    )
    assert.equal(decision.outcome, 'deny')
    assert.equal(decision.reasonCode, 'HOST_EXECUTION_DISABLED_IN_CLOUD')
  })
})

describe('canonical filesystem scope', () => {
  test('equivalent private paths are all classified as sensitive', t => {
    const root = temporaryRoot()
    const privateDir = path.join(root, '.runtime')
    const privateFile = path.join(privateDir, 'synthetic-secret.txt')
    const safeDir = path.join(root, 'safe')
    fs.mkdirSync(privateDir)
    fs.mkdirSync(safeDir)
    fs.writeFileSync(privateFile, 'synthetic only\n')

    const candidates = [
      { cwd: root, target: path.join('.runtime', 'synthetic-secret.txt') },
      { cwd: root, target: path.join('safe', '..', '.runtime', 'synthetic-secret.txt') },
      { cwd: root, target: privateFile },
      { cwd: privateDir, target: 'synthetic-secret.txt' },
    ]
    if (process.platform === 'win32') {
      candidates.push({ cwd: root, target: '.runtime/synthetic-secret.txt' })
    } else {
      t.diagnostic('alternate Windows separator case is platform-specific')
    }

    for (const candidate of candidates) {
      const assessment = assessFilesystemTool('read', { file_path: candidate.target }, candidate.cwd)
      assert.equal(assessment.risk, 'sensitive', candidate.target)
    }
  })

  test('ordinary canonical host file remains read-only', () => {
    const root = temporaryRoot()
    const file = path.join(root, 'ordinary.txt')
    fs.writeFileSync(file, 'ordinary fixture\n')
    assert.deepEqual(assessFilesystemTool('read', { file_path: file }, root), {})
  })

  test('Windows named streams inherit their owning file protection', { skip: process.platform !== 'win32' }, () => {
    const root = temporaryRoot()
    const file = path.join(root, '.env')
    fs.writeFileSync(file, 'synthetic only\n')
    const stream = `${file}:fixture`
    fs.writeFileSync(stream, 'synthetic stream only\n')
    assert.equal(fs.readFileSync(stream, 'utf8'), 'synthetic stream only\n')
    for (const name of ['read', 'read_image']) {
      for (const target of [stream, '.env:fixture', `${stream}:$DATA`, `${file}::$DATA`]) {
        assert.equal(assessFilesystemTool(name, { file_path: target }, root).risk, 'sensitive', target)
      }
    }
  })

  test('link or junction traversal is denied or classified by its canonical private target', t => {
    const root = temporaryRoot()
    const privateDir = path.join(root, '.runtime')
    const linkDir = path.join(root, 'linked-private')
    fs.mkdirSync(privateDir)
    fs.writeFileSync(path.join(privateDir, 'synthetic-secret.txt'), 'synthetic only\n')
    try {
      fs.symlinkSync(privateDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`link creation unavailable: ${error.code || error.message}`)
      return
    }
    const assessment = assessFilesystemTool(
      'read',
      { file_path: path.join(linkDir, 'synthetic-secret.txt') },
      root,
    )
    assert.ok(
      assessment.risk === 'sensitive' || assessment.denialReasonCode === 'FILESYSTEM_LINK_SCOPE_DISABLED',
    )
  })

  test('glob and grep fail closed because protected descendants cannot be excluded', () => {
    assert.equal(
      assessFilesystemTool('glob', { pattern: '**/*', path: '.' }, process.cwd()).denialReasonCode,
      'SEARCH_SCOPE_UNENFORCEABLE',
    )
    assert.equal(
      assessFilesystemTool('grep', { pattern: 'synthetic', path: '.' }, process.cwd()).denialReasonCode,
      'SEARCH_SCOPE_UNENFORCEABLE',
    )
  })
})
