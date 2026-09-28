import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { ApprovalInbox, type PendingApproval } from '../packages/policy/approvals.ts'
import { loadAccessConfig, type AccessConfigState } from '../packages/policy/config.ts'
import {
  AccessDeniedError,
  type DeviceKind,
  type ExecutionContext,
  type OriginChannel,
  type PolicyDecision,
  type Principal,
  type SessionBinding,
} from '../packages/policy/contracts.ts'
import {
  assessFilesystemTool,
  capabilityById,
  capabilityForTool,
  evaluatePolicy,
} from '../packages/policy/evaluate.ts'
import { AccessStore } from '../packages/policy/store.ts'
import { auditId, type AuditRecord } from '../packages/policy/audit.ts'

export const name = 'elara-access'
export const inject = ['tools', 'agents', 'approval']

export interface DirectExecutionRequest {
  principalId: string
  sessionId: string
  originChannel: OriginChannel
  targetDeviceId: string
  source: string
  capabilityId: string
  signal?: AbortSignal
}

export interface AutoModeContext {
  principalId: string
  originChannel: OriginChannel
  senderAlias: string
}

export interface AccessService {
  readonly state: AccessConfigState
  principalForAlias(channel: OriginChannel, alias: string): Principal | undefined
  managedWhatsAppMember(alias: string): Principal | undefined
  addWhatsAppMember(owner: AutoModeContext, ownerSessionId: string, alias: string): Principal
  revokeWhatsAppMember(owner: AutoModeContext, ownerSessionId: string, alias: string): void
  dashboardPrincipal(): Principal | undefined
  bindRootSession(sessionId: string, principalId: string, originChannel: OriginChannel): SessionBinding
  bindingForSession(sessionId: string): SessionBinding | undefined
  assertSessionOwner(sessionId: string, principalId: string): SessionBinding
  defaultTarget(channel: OriginChannel): string
  deviceKind(deviceId: string): DeviceKind | undefined
  contextForAgent(agent: Agent | undefined, source: string, signal?: AbortSignal): ExecutionContext | undefined
  decideDirect(request: DirectExecutionRequest): PolicyDecision
  executeDirect<T>(request: DirectExecutionRequest, operation: () => Promise<T>): Promise<T>
  pendingApprovals(principalId: string, channel: OriginChannel): PendingApproval[]
  setAutoMode(context: AutoModeContext, sessionId: string, enabled: boolean): { enabled: boolean; pendingCancelled: boolean }
  getAutoMode(context: AutoModeContext, sessionId: string): boolean
  answerApproval(id: string, principalId: string, channel: OriginChannel, allow: boolean): boolean
  onApproval(listener: (view: PendingApproval) => void | Promise<void>): () => void
  cancelSessionApprovals(sessionIds: readonly string[]): void
  revokeSessionGrants(sessionIds: readonly string[], stopRequestId?: string): void
  recordAudit(record: AuditRecord): number
  listAudit(principalId: string, channel: OriginChannel, sessionId: string, cursor?: number, limit?: number): AuditRecord[]
  stopStatus(id: string): { status: import('../packages/policy/contracts.ts').StopStatus; principalId: string; originChannel: OriginChannel } | undefined
  latestStopStatus(sessionId: string): import('../packages/policy/contracts.ts').StopStatus | undefined
  auditHealthy(): boolean
  setStopGuard(guard: (agent: Agent | undefined) => void): void
  setScopeResolver(resolve: (agent: Agent | undefined) => string | undefined): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    access: AccessService
  }
}

function denialText(decision: PolicyDecision): string {
  return `ELARA access denied (${decision.reasonCode})`
}

export function apply(ctx: Context) {
  const rootDir = path.resolve(process.env.ELARA_ROOT || process.cwd())
  const state = loadAccessConfig(rootDir, process.env.ELARA_ACCESS_CONFIG)
  const dbPath = path.resolve(process.env.ELARA_CONTROL_DB?.trim() || path.join(rootDir, '.runtime', 'elara-control.db'))
  const store = new AccessStore(dbPath)
  const inbox = new ApprovalInbox()
  inbox.subscribe(view => {
    try { store.recordAudit({ schemaVersion: 1, operationId: view.operationId ?? view.id, approvalId: view.id,
      principalId: view.principalId, sessionId: view.scopeSessionId ?? view.sessionId, originChannel: view.originChannel,
      targetDeviceId: view.targetDeviceId, toolName: view.toolName,
      eventType: 'approval_requested', reasonCode: 'APPROVAL_REQUIRED', outcome: 'requested', createdAt: Date.now() }) }
    catch { auditDegraded = true; throw new Error('AUDIT_UNAVAILABLE') }
  })
  inbox.onSettled((view, answer) => {
    try { store.recordAudit({ schemaVersion: 1, operationId: view.operationId ?? view.id, approvalId: view.id,
      principalId: view.principalId, sessionId: view.scopeSessionId ?? view.sessionId, originChannel: view.originChannel,
      targetDeviceId: view.targetDeviceId, toolName: view.toolName,
      eventType: 'approval_resolved', reasonCode: answer === 'allowed-once' ? 'APPROVAL_ALLOWED' :
        answer === 'rejected' ? 'APPROVAL_REJECTED' : answer === 'expired' ? 'APPROVAL_EXPIRED'
          : answer === 'cancelled' ? 'APPROVAL_CANCELLED' : 'APPROVAL_UNAVAILABLE',
      outcome: answer === 'allowed-once' ? 'allowed' : answer === 'rejected' ? 'rejected' :
        answer === 'cancelled' ? 'cancelled' : answer === 'expired' ? 'expired' : 'unknown', createdAt: Date.now() }) }
    catch { auditDegraded = true; console.error('[ELARA-AUDIT] durable write failed') }
  })
  const grants = new Map<ToolExecution['token'], string>()
  const approvedScopes = new Map<ToolExecution['token'], string>()
  const autoGrants = new Map<ToolExecution['token'], string>()
  const autoSessions = new Map<string, { id: string; principalId: string; senderAlias: string }>()
  const ownRequests = new WeakMap<ApprovalRequest, { exec: Readonly<ToolExecution>, accepted: boolean }>()
  const liveExecutions = new Map<ToolExecution['token'], Readonly<ToolExecution>>()
  const trackedExecutions = new Map<ToolExecution['token'], Readonly<ToolExecution>>()
  const staleExecutions = new Set<ToolExecution['token']>()
  const stopForExecution = new Map<ToolExecution['token'], string>()
  const executionAudit = new Map<ToolExecution['token'], { executionId: string; operationId: string; startedAt: number; binding: SessionBinding; toolName: string; capabilityId: string }>()
  const correlation = new Map<ToolExecution['token'], { operationId: string; executionId: string }>()
  let auditDegraded = false
  let stopGuard: (agent: Agent | undefined) => void = () => undefined
  let scopeForAgent: (agent: Agent | undefined) => string | undefined = agent => agent ? String(agent.id) : undefined
  const aliasIndex = new Map<string, Principal>()
  for (const principal of state.config?.principals ?? []) {
    for (const [channel, aliases] of Object.entries(principal.channelAliases)) {
      for (const alias of aliases ?? []) aliasIndex.set(`${channel}\u0000${alias}`, principal)
    }
  }

  function principalForAgent(agent: Agent | undefined, visited = new Set<string>()): Principal | undefined {
    if (!agent) return undefined
    const sessionId = String(agent.id)
    if (visited.has(sessionId)) return undefined
    visited.add(sessionId)
    const direct = store.bindingFor(sessionId)
    if (direct) return state.config?.principals.find(principal => principal.id === direct.principalId && principal.enabled)
    for (const possibleParent of ctx.agents.list()) {
      if (possibleParent === agent) continue
      if (ctx.agents.isOwnedBy(agent.id, possibleParent)) return principalForAgent(possibleParent, visited)
    }
    return undefined
  }

  function bindingForAgent(agent: Agent | undefined): SessionBinding | undefined {
    if (!agent) return undefined
    const direct = store.bindingFor(String(agent.id))
    if (direct) return direct
    for (const possibleParent of ctx.agents.list()) {
      if (possibleParent === agent) continue
      if (ctx.agents.isOwnedBy(agent.id, possibleParent)) return bindingForAgent(possibleParent)
    }
    return undefined
  }

  function targetFor(binding: SessionBinding | undefined): string {
    if (!binding) return 'unbound'
    return state.config?.authorities.channelDefaultDeviceIds[binding.originChannel] || 'unconfigured'
  }
  const managedMembers = new Map<string, Principal>()
  if (state.config) for (const member of store.listWhatsAppMembers()) {
    if (!/^[1-9][0-9]{7,14}@s\.whatsapp\.net$/.test(member.alias)
      || !/^wa-[0-9a-f-]{36}$/.test(member.id)
      || aliasIndex.has(`whatsapp\u0000${member.alias}`)) continue
    const principal: Principal = { id: member.id, role: 'user', enabled: true, chatOnly: true,
      channelAliases: { whatsapp: [member.alias] }, allowedDeviceIds: [] }
    state.config.principals.push(principal)
    managedMembers.set(member.alias, principal)
    aliasIndex.set(`whatsapp\u0000${member.alias}`, principal)
  }

  function assertWhatsAppOwner(owner: AutoModeContext, sessionId: string): void {
    const principal = aliasIndex.get(`whatsapp\u0000${owner.senderAlias}`)
    const binding = store.bindingFor(sessionId)
    if (owner.originChannel !== 'whatsapp' || !principal?.enabled
      || principal.id !== owner.principalId
      || !principal.trustedWhatsAppOwner?.aliases.includes(owner.senderAlias)
      || binding?.principalId !== owner.principalId || binding.originChannel !== 'whatsapp') {
      throw new Error('OWNER_UNAUTHORIZED')
    }
  }

  function authorizeAutoMode(context: AutoModeContext, sessionId: string): Principal {
    const binding = store.bindingFor(sessionId)
    const principal = state.config?.principals.find(item => item.id === context.principalId && item.enabled)
    if (context.originChannel !== 'whatsapp' || !binding || binding.principalId !== context.principalId
      || binding.originChannel !== 'whatsapp' || !principal?.trustedWhatsAppOwner?.aliases.includes(context.senderAlias)
      || targetFor(binding) !== state.config?.authorities.hostDeviceId
      || process.env.ELARA_MODE === 'cloud') throw new Error('AUTO_MODE_NOT_ALLOWED')
    return principal
  }

  function autoModeForAgent(agent: Agent | undefined, binding: SessionBinding | undefined,
    principal: Principal | undefined): boolean {
    const rootId = scopeForAgent(agent)
    const active = rootId ? autoSessions.get(rootId) : undefined
    return !!active && !!binding && !!principal && binding.originChannel === 'whatsapp'
      && active.principalId === principal.id
      && !!principal.trustedWhatsAppOwner?.aliases.includes(active.senderAlias)
  }

  function autoGrantCurrent(exec: Readonly<ToolExecution>): boolean {
    const id = autoGrants.get(exec.token)
    const rootId = scopeForAgent(exec.agent)
    return !!id && !!rootId && autoSessions.get(rootId)?.id === id
      && autoModeForAgent(exec.agent, bindingForAgent(exec.agent), principalForAgent(exec.agent))
  }

  function record(context: ExecutionContext, decision: PolicyDecision, operationId = auditId(), auditSessionId = context.sessionId): void {
    try { store.record({
      principalId: context.principalId || 'unbound',
      sessionId: context.sessionId || 'unbound',
      capabilityId: decision.capability.id,
      targetDeviceId: context.targetDeviceId || 'unbound',
      decision: decision.outcome,
      reasonCode: decision.reasonCode,
      policyVersion: decision.policyVersion,
      source: context.source.slice(0, 96),
      createdAt: Date.now(),
    }) } catch {
      auditDegraded = true
      console.error('[ELARA-AUDIT] durable write failed')
      throw new Error('AUDIT_UNAVAILABLE')
    }
    try {
      store.recordAudit({ schemaVersion: 1, operationId, principalId: context.principalId || 'unbound',
        sessionId: auditSessionId || 'unbound', originChannel: store.bindingFor(context.sessionId)?.originChannel
          || bindingForAgent(ctx.agents.get(context.sessionId as any))?.originChannel || 'dashboard',
        targetDeviceId: context.targetDeviceId || undefined, capabilityId: decision.capability.id,
        policyVersion: decision.policyVersion, eventType: 'policy_decision', reasonCode: decision.reasonCode,
        outcome: decision.outcome === 'allow' ? 'allowed' : 'denied', createdAt: Date.now() })
    } catch { auditDegraded = true; console.error('[ELARA-AUDIT] durable write failed') }
  }

  function decisionForTool(exec: Readonly<ToolExecution>, shouldRecord: boolean): PolicyDecision {
    const binding = bindingForAgent(exec.agent)
    const principal = principalForAgent(exec.agent)
    const baseCapability = capabilityForTool(exec.name, exec.arguments)
    const selectedDeviceId = baseCapability.requiresDevice ? targetFor(binding) : 'control-plane'
    const targetDeviceId = baseCapability.executionLocation === 'host'
      ? state.config?.authorities.hostDeviceId || 'unconfigured'
      : selectedDeviceId
    const runtimeMode = process.env.ELARA_MODE || 'local'
    const mayResolveHostPath = baseCapability.executionLocation === 'host'
      && selectedDeviceId === targetDeviceId
      && runtimeMode !== 'cloud'
      && binding?.principalId === principal?.id
      && principal.allowedDeviceIds.includes(targetDeviceId)
    const assessment = mayResolveHostPath
      ? assessFilesystemTool(exec.name, exec.arguments, exec.agent?.session.header.cwd)
      : {}
    const capability = capabilityForTool(exec.name, exec.arguments, assessment)
    const context: ExecutionContext = {
      principalId: principal?.id || 'unbound',
      sessionId: exec.agent ? String(exec.agent.id) : 'unbound',
      targetDeviceId,
      selectedDeviceId,
      runtimeMode,
      denialReasonCode: assessment.denialReasonCode,
      source: exec.parent ? 'dsh:nested-tool' : 'dsh:tool',
      signal: exec.signal,
    }
    const baseDecision = evaluatePolicy(state.config, context, capability, binding?.principalId)
    const decision = baseDecision.outcome === 'approval_required' && approvableTools.has(exec.name)
      && targetFor(binding) === state.config?.authorities.hostDeviceId
      && runtimeMode !== 'cloud' && autoModeForAgent(exec.agent, binding, principal)
      ? { ...baseDecision, outcome: 'allow' as const, reasonCode: 'AUTO_MODE_ALLOWED' }
      : baseDecision
    if (shouldRecord) record(context, decision, correlation.get(exec.token)?.operationId, scopeForAgent(exec.agent))
    return decision
  }

  // Only reviewed host actions can use P2B. P2A search, protected reads,
  // companion mutation, and control-plane restrictions remain in force.
  const approvableTools = new Set([
    'write', 'edit', 'pwsh', 'bash', 'run_code',
    'elara_project_test', 'elara_project_build', 'elara_project_typecheck',
  ])
  function approvalScope(exec: Readonly<ToolExecution>): string | undefined {
    const decision = decisionForTool(exec, false)
    const binding = bindingForAgent(exec.agent)
    const principal = principalForAgent(exec.agent)
    if (exec.signal.aborted || staleExecutions.has(exec.token) || !binding || !principal || !approvableTools.has(exec.name)
      || (decision.outcome !== 'approval_required' && decision.reasonCode !== 'AUTO_MODE_ALLOWED')
      || targetFor(binding) !== state.config?.authorities.hostDeviceId
      || process.env.ELARA_MODE === 'cloud') return undefined
    return JSON.stringify({ principal: principal.id, session: exec.agent?.id,
      binding, target: targetFor(binding), policy: state.config, mode: process.env.ELARA_MODE || 'local',
      tool: exec.name, call: exec.callId, cwd: exec.agent?.session.header.cwd, args: exec.arguments })
  }

  ctx.on('approval/request', async (request, next) => {
    const owned = ownRequests.get(request as ApprovalRequest)
    const candidates = [...liveExecutions.values()].filter(exec => exec.agent === request.agent
      && exec.callId === request.callId && exec.name === request.toolName)
    const exec = owned?.exec ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!exec) return bindingForAgent(request.agent as Agent) ? 'unavailable' : next()

    const scope = approvalScope(exec)
    const binding = bindingForAgent(exec.agent)
    if (!scope || !binding) return 'unavailable'
    if (!owned && liveExecutions.get(exec.token) === exec && approvedScopes.get(exec.token) === scope
      && (!autoGrants.has(exec.token) || autoGrantCurrent(exec))) {
      // DSH's sandbox is asking about the same execution after ELARA's one-time
      // approval. Reuse that exact frozen scope; do not create a second grant.
      return 'allowed-once'
    }
    const details = JSON.stringify({ cwd: exec.agent?.session.header.cwd, arguments: exec.arguments,
      reason: request.reason }, null, 2)
    // Never ask for an action whose full preview cannot be delivered.
    if (details.length > 6000) return 'unavailable'
    const result = await inbox.ask({ principalId: binding.principalId,
      operationId: correlation.get(exec.token)?.operationId, scopeSessionId: scopeForAgent(exec.agent),
      originChannel: binding.originChannel, sessionId: String(exec.agent!.id),
      targetDeviceId: targetFor(binding), toolName: exec.name, details }, request.signal ?? exec.signal)
    if (result === 'allowed-once' && approvalScope(exec) !== scope) return 'cancelled'
    if (owned) owned.accepted = result === 'allowed-once'
    return result
  }, { prepend: true })

  const service: AccessService = {
    state,
    principalForAlias(channel, alias) {
      const principal = aliasIndex.get(`${channel}\u0000${alias}`)
      return principal?.enabled ? principal : undefined
    },
    managedWhatsAppMember(alias) { return managedMembers.get(alias) },
    addWhatsAppMember(owner, ownerSessionId, alias) {
      assertWhatsAppOwner(owner, ownerSessionId)
      if (!/^[1-9][0-9]{7,14}@s\.whatsapp\.net$/.test(alias)) throw new Error('MEMBER_ALIAS_INVALID')
      if (aliasIndex.has(`whatsapp\u0000${alias}`)) throw new Error('MEMBER_ALREADY_CONFIGURED')
      if (!state.config || auditDegraded) throw new Error('AUDIT_UNAVAILABLE')
      const principal: Principal = { id: `wa-${randomUUID()}`, role: 'user', enabled: true,
        chatOnly: true, channelAliases: { whatsapp: [alias] }, allowedDeviceIds: [] }
      try {
        store.addWhatsAppMember(principal.id, alias, { schemaVersion: 1, operationId: auditId(),
          executionId: principal.id, principalId: owner.principalId, sessionId: ownerSessionId,
          originChannel: 'whatsapp', policyVersion: state.config.policyVersion,
          eventType: 'membership_changed', reasonCode: 'MEMBER_ADDED', outcome: 'completed', createdAt: Date.now() })
      } catch { auditDegraded = true; throw new Error('AUDIT_UNAVAILABLE') }
      state.config.principals.push(principal)
      managedMembers.set(alias, principal)
      aliasIndex.set(`whatsapp\u0000${alias}`, principal)
      return principal
    },
    revokeWhatsAppMember(owner, ownerSessionId, alias) {
      assertWhatsAppOwner(owner, ownerSessionId)
      const principal = managedMembers.get(alias)
      if (!principal) throw new Error('MEMBER_NOT_MANAGED')
      let durable = false
      try {
        if (auditDegraded) throw new Error('AUDIT_UNAVAILABLE')
        store.revokeWhatsAppMember(principal.id, { schemaVersion: 1, operationId: auditId(),
          executionId: principal.id, principalId: owner.principalId, sessionId: ownerSessionId,
          originChannel: 'whatsapp', policyVersion: state.config?.policyVersion,
          eventType: 'membership_changed', reasonCode: 'MEMBER_REVOKED', outcome: 'completed', createdAt: Date.now() })
        durable = true
      } catch {
        auditDegraded = true
        console.error('[ELARA-AUDIT] membership revocation audit unavailable')
        try { store.revokeWhatsAppMemberWithoutAudit(principal.id); durable = true } catch { /* Fence ingress anyway. */ }
      }
      principal.enabled = false
      aliasIndex.delete(`whatsapp\u0000${alias}`)
      if (durable) managedMembers.delete(alias)
      if (!durable) throw new Error('MEMBER_REVOKE_UNCONFIRMED')
    },
    dashboardPrincipal() {
      const id = state.config?.authorities.dashboardPrincipalId
      return state.config?.principals.find(principal => principal.id === id && principal.enabled)
    },
    bindRootSession(sessionId, principalId, originChannel) {
      if (!state.config) throw new Error('ACCESS_CONFIG_UNAVAILABLE')
      const principal = state.config.principals.find(candidate => candidate.id === principalId && candidate.enabled)
      if (!principal) throw new Error('PRINCIPAL_DISABLED_OR_UNKNOWN')
      return store.bindSession(sessionId, principalId, originChannel)
    },
    bindingForSession(sessionId) {
      return store.bindingFor(sessionId)
    },
    assertSessionOwner(sessionId, principalId) {
      const binding = store.bindingFor(sessionId)
      if (!binding || binding.principalId !== principalId) throw new Error('SESSION_OWNER_UNTRUSTED')
      return binding
    },
    defaultTarget(channel) {
      const target = state.config?.authorities.channelDefaultDeviceIds[channel]
      if (!target) throw new Error('ACCESS_CONFIG_UNAVAILABLE')
      return target
    },
    deviceKind(deviceId) {
      return state.config?.devices.find(device => device.id === deviceId && device.enabled)?.kind
    },
    contextForAgent(agent, source, signal) {
      const binding = bindingForAgent(agent)
      const principal = principalForAgent(agent)
      if (!binding || !principal) return undefined
      return {
        principalId: principal.id,
        sessionId: agent ? String(agent.id) : binding.sessionId,
        targetDeviceId: targetFor(binding),
        source,
        signal,
      }
    },
    decideDirect(request) {
      const binding = store.bindingFor(request.sessionId)
      const context: ExecutionContext = request
      const decision = evaluatePolicy(state.config, context, capabilityById(request.capabilityId), binding?.principalId)
      record(context, decision)
      return decision
    },
    async executeDirect(request, operation) {
      const operationId = auditId()
      const binding = store.bindingFor(request.sessionId)
      const initial = evaluatePolicy(state.config, request, capabilityById(request.capabilityId), binding?.principalId)
      record(request, initial, operationId)
      if (initial.outcome !== 'allow') throw new AccessDeniedError(initial)
      if (request.signal?.aborted) throw new Error('ABORTED_BEFORE_DISPATCH')
      const final = evaluatePolicy(
        state.config,
        request,
        capabilityById(request.capabilityId),
        store.bindingFor(request.sessionId)?.principalId,
      )
      if (final.outcome !== 'allow') {
        record(request, final, operationId)
        throw new AccessDeniedError(final)
      }
      if (initial.capability.risk === 'sensitive' && auditDegraded) throw new Error('AUDIT_UNAVAILABLE')
      const executionId = auditId()
      const startedAt = Date.now()
      if (binding) service.recordAudit({ schemaVersion: 1, operationId, executionId,
        principalId: binding.principalId, sessionId: binding.sessionId, originChannel: binding.originChannel,
        targetDeviceId: request.targetDeviceId, capabilityId: request.capabilityId,
        policyVersion: final.policyVersion, eventType: 'dispatch_started', reasonCode: 'DISPATCH_ALLOWED',
        outcome: 'requested', createdAt: startedAt })
      try {
        const value = await operation()
        if (request.signal?.aborted) throw new Error('EXECUTION_CANCELLED')
        if (binding) service.recordAudit({ schemaVersion: 1, operationId, executionId,
          principalId: binding.principalId, sessionId: binding.sessionId, originChannel: binding.originChannel,
          targetDeviceId: request.targetDeviceId, capabilityId: request.capabilityId,
          policyVersion: final.policyVersion, eventType: 'execution_settled', reasonCode: 'EXECUTION_COMPLETED',
          outcome: 'completed', createdAt: Date.now(), durationMs: Date.now() - startedAt })
        return value
      } catch (error) {
        if (binding) try { service.recordAudit({ schemaVersion: 1, operationId, executionId,
          principalId: binding.principalId, sessionId: binding.sessionId, originChannel: binding.originChannel,
          targetDeviceId: request.targetDeviceId, capabilityId: request.capabilityId,
          policyVersion: final.policyVersion, eventType: 'execution_settled',
          reasonCode: request.signal?.aborted && final.capability.executionLocation === 'routed_device'
            && service.deviceKind(request.targetDeviceId) === 'companion' ? 'REMOTE_EXECUTION_UNCONFIRMED'
            : request.signal?.aborted ? 'EXECUTION_CANCELLED' : 'EXECUTION_FAILED',
          outcome: request.signal?.aborted && final.capability.executionLocation === 'routed_device'
            && service.deviceKind(request.targetDeviceId) === 'companion' ? 'unknown'
            : request.signal?.aborted ? 'cancelled' : 'failed',
          createdAt: Date.now(), durationMs: Date.now() - startedAt }) } catch { /* degraded */ }
        throw error
      }
    },
    pendingApprovals(principalId, channel) {
      const principal = state.config?.principals.find(item => item.id === principalId && item.enabled)
      return principal ? inbox.list(principalId, channel) : []
    },
    setAutoMode(context, sessionId, enabled) {
      authorizeAutoMode(context, sessionId)
      if (enabled) {
        const current = autoSessions.get(sessionId)
        if (current?.principalId !== context.principalId || current.senderAlias !== context.senderAlias) {
          if (auditDegraded) throw new Error('AUDIT_UNAVAILABLE')
          service.recordAudit({ schemaVersion: 1, operationId: auditId(), principalId: context.principalId,
            sessionId, originChannel: 'whatsapp', targetDeviceId: targetFor(store.bindingFor(sessionId)),
            policyVersion: state.config?.policyVersion, eventType: 'auto_mode_changed',
            reasonCode: 'AUTO_MODE_ENABLED', outcome: 'allowed', createdAt: Date.now() })
          autoSessions.set(sessionId, { id: auditId(), principalId: context.principalId,
            senderAlias: context.senderAlias })
        }
        const root = ctx.agents.list().find(agent => String(agent.id) === sessionId)
        const affected = root
          ? ctx.agents.list().filter(agent => agent === root || ctx.agents.isOwnedBy(agent.id, root))
            .map(agent => String(agent.id)) : [sessionId]
        const ids = new Set(affected)
        const pendingCancelled = inbox.list(context.principalId, 'whatsapp')
          .some(view => ids.has(view.sessionId) || !!view.scopeSessionId && ids.has(view.scopeSessionId))
        for (const id of ids) inbox.cancelSession(id)
        return { enabled: true, pendingCancelled }
      }
      autoSessions.delete(sessionId)
      try { service.recordAudit({ schemaVersion: 1, operationId: auditId(), principalId: context.principalId,
        sessionId, originChannel: 'whatsapp', targetDeviceId: targetFor(store.bindingFor(sessionId)),
        policyVersion: state.config?.policyVersion, eventType: 'auto_mode_changed',
        reasonCode: 'AUTO_MODE_DISABLED', outcome: 'completed', createdAt: Date.now() }) }
      catch { /* Disabling permission must still succeed if audit storage fails. */ }
      return { enabled: false, pendingCancelled: false }
    },
    getAutoMode(context, sessionId) {
      authorizeAutoMode(context, sessionId)
      const active = autoSessions.get(sessionId)
      return active?.principalId === context.principalId && active.senderAlias === context.senderAlias
    },
    answerApproval(id, principalId, channel, allow) {
      const principal = state.config?.principals.find(item => item.id === principalId && item.enabled)
      return !!principal && inbox.answer(id, principalId, channel, allow)
    },
    onApproval(listener) { return inbox.subscribe(listener) },
    cancelSessionApprovals(sessionIds) { for (const id of sessionIds) inbox.cancelSession(id) },
    revokeSessionGrants(sessionIds, stopRequestId) {
      const scope = new Set(sessionIds)
      for (const id of scope) autoSessions.delete(id)
      for (const [token, exec] of trackedExecutions) {
        if (exec.agent && scope.has(String(exec.agent.id))) {
          staleExecutions.add(token)
          if (stopRequestId) stopForExecution.set(token, stopRequestId)
        }
      }
      for (const [token, exec] of liveExecutions) {
        if (exec.agent && scope.has(String(exec.agent.id))) {
          grants.delete(token)
          approvedScopes.delete(token)
          autoGrants.delete(token)
          liveExecutions.delete(token)
        }
      }
    },
    recordAudit(record) {
      try { return store.recordAudit(record) }
      catch { auditDegraded = true; console.error('[ELARA-AUDIT] durable write failed'); throw new Error('AUDIT_UNAVAILABLE') }
    },
    listAudit(principalId, channel, sessionId, cursor, limit) { return store.listAudit(principalId, channel, sessionId, cursor, limit) },
    stopStatus(id) { return store.stopStatus(id) },
    latestStopStatus(sessionId) { return store.latestStopStatus(sessionId) },
    auditHealthy() { return !auditDegraded },
    setStopGuard(guard) { stopGuard = guard },
    setScopeResolver(resolve) { scopeForAgent = resolve },
  }

  ctx.provide('access', service)
  ctx.on('agent/created', async (payload: any) => {
    const child = payload?.agent as Agent | undefined
    if (!child || store.bindingFor(String(child.id))) return undefined
    for (const possibleParent of ctx.agents.list()) {
      if (possibleParent === child || !ctx.agents.isOwnedBy(child.id, possibleParent)) continue
      const parentBinding = bindingForAgent(possibleParent)
      if (parentBinding) {
        store.bindSession(String(child.id), parentBinding.principalId, parentBinding.originChannel)
      }
      return undefined
    }
    return undefined
  })
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<any>) => {
    correlation.set(exec.token, { operationId: auditId(), executionId: auditId() })
    trackedExecutions.set(exec.token, exec)
    try { stopGuard(exec.agent) }
    catch { return { kind: 'deny' as const, reason: 'ELARA access denied (SESSION_STOPPING)' } }
    const decision = decisionForTool(exec, true)
    if (decision.capability.risk === 'sensitive' && auditDegraded) {
      return { kind: 'deny' as const, reason: 'ELARA access denied (AUDIT_UNAVAILABLE)' }
    }
    if (decision.reasonCode === 'AUTO_MODE_ALLOWED') {
      const scope = approvalScope(exec)
      const rootId = scopeForAgent(exec.agent)
      const active = rootId ? autoSessions.get(rootId) : undefined
      if (!scope || !active) return { kind: 'deny' as const, reason: 'ELARA access denied (AUTO_MODE_REVOKED)' }
      grants.set(exec.token, scope)
      approvedScopes.set(exec.token, scope)
      autoGrants.set(exec.token, active.id)
      liveExecutions.set(exec.token, exec)
      return next()
    }
    if (decision.outcome === 'allow') return next()
    const scope = approvalScope(exec)
    if (scope && exec.agent) {
      const request: ApprovalRequest = { agent: exec.agent, toolName: exec.name,
        callId: exec.callId, reason: 'ELARA sensitive operation requires one-time approval', signal: exec.signal }
      const owned = { exec, accepted: false }
      ownRequests.set(request, owned)
      let refusalReason = denialText(decision)
      try {
        // DSH's danger-full-access preset persists approval/policy=never in the
        // session. ELARA still requires a one-time question for this tool, so
        // restore ask on the owned session before using DSH's approval seam.
        ctx.approval.setPolicy(exec.agent, 'ask')
        const outcome = await ctx.approval.request(request)
        if (outcome === 'allowed-once' && owned.accepted && approvalScope(exec) === scope) {
          grants.set(exec.token, scope)
          approvedScopes.set(exec.token, scope)
          liveExecutions.set(exec.token, exec)
          return await next()
        }
        refusalReason = `ELARA access denied (APPROVAL_${outcome === 'rejected' ? 'REJECTED'
          : outcome === 'cancelled' ? 'CANCELLED' : 'UNAVAILABLE'})`
      } catch {
        // Missing active turn or failed audit cannot issue a grant.
        refusalReason = 'ELARA access denied (APPROVAL_UNAVAILABLE)'
      } finally {
        ownRequests.delete(request)
      }
      return { kind: 'deny' as const, reason: refusalReason }
    }
    return { kind: 'deny' as const, reason: denialText(decision) }
  })
  function auditGuardDenial(exec: Readonly<ToolExecution>, reasonCode: string): void {
    const binding = bindingForAgent(exec.agent)
    if (!binding) return
    try { service.recordAudit({ schemaVersion: 1,
      operationId: correlation.get(exec.token)?.operationId ?? auditId(),
      principalId: binding.principalId, sessionId: scopeForAgent(exec.agent) ?? binding.sessionId,
      originChannel: binding.originChannel, capabilityId: capabilityForTool(exec.name, exec.arguments).id,
      eventType: 'policy_decision', reasonCode, outcome: 'denied', createdAt: Date.now() }) }
    catch { /* denial still stands */ }
  }
  ctx.tools.guard(exec => {
    if (staleExecutions.has(exec.token)) {
      auditGuardDenial(exec, 'SESSION_STOPPED')
      return 'ELARA access denied (SESSION_STOPPED)'
    }
    try { stopGuard(exec.agent) }
    catch { auditGuardDenial(exec, 'SESSION_STOPPING'); return 'ELARA access denied (SESSION_STOPPING)' }
    const decision = decisionForTool(exec, false)
    const grant = grants.get(exec.token)
    grants.delete(exec.token)
    const grantValid = !!grant && approvalScope(exec) === grant
      && (!autoGrants.has(exec.token) || autoGrantCurrent(exec))
    const allowed = grantValid || (decision.outcome === 'allow' && decision.reasonCode !== 'AUTO_MODE_ALLOWED')
    const denialReason = autoGrants.has(exec.token) || decision.reasonCode === 'AUTO_MODE_ALLOWED'
      ? 'AUTO_MODE_REVOKED' : decision.reasonCode
    const binding = bindingForAgent(exec.agent)
    if (binding) {
      try {
        if (allowed) {
          if (decision.capability.risk === 'sensitive' && auditDegraded) return 'ELARA access denied (AUDIT_UNAVAILABLE)'
          const ids = correlation.get(exec.token) ?? { operationId: auditId(), executionId: auditId() }
          const entry = { ...ids, startedAt: Date.now(), binding,
            toolName: exec.name, capabilityId: decision.capability.id }
          service.recordAudit({ schemaVersion: 1, operationId: entry.operationId, executionId: entry.executionId,
            principalId: binding.principalId, sessionId: scopeForAgent(exec.agent) ?? binding.sessionId, originChannel: binding.originChannel,
            toolName: /^[a-zA-Z0-9_.:@-]+$/.test(exec.name) ? exec.name : undefined,
            capabilityId: entry.capabilityId, policyVersion: decision.policyVersion,
            eventType: 'dispatch_started', reasonCode: 'DISPATCH_ALLOWED', outcome: 'requested', createdAt: entry.startedAt })
          executionAudit.set(exec.token, entry)
        } else {
          service.recordAudit({ schemaVersion: 1, operationId: correlation.get(exec.token)?.operationId ?? auditId(), principalId: binding.principalId,
            sessionId: scopeForAgent(exec.agent) ?? binding.sessionId, originChannel: binding.originChannel,
            capabilityId: decision.capability.id, policyVersion: decision.policyVersion,
            eventType: 'policy_decision', reasonCode: denialReason, outcome: 'denied', createdAt: Date.now() })
        }
      } catch { if (decision.capability.risk === 'sensitive') return 'ELARA access denied (AUDIT_UNAVAILABLE)' }
    }
    return allowed ? undefined : `ELARA access denied (${denialReason})`
  })
  ctx.on('tools/result', (exec, result) => {
    const entry = executionAudit.get(exec.token)
    approvedScopes.delete(exec.token)
    autoGrants.delete(exec.token)
    executionAudit.delete(exec.token)
    correlation.delete(exec.token)
    trackedExecutions.delete(exec.token)
    staleExecutions.delete(exec.token)
    const stopRequestId = stopForExecution.get(exec.token)
    stopForExecution.delete(exec.token)
    if (entry) {
      const remoteUnknown = exec.signal.aborted && capabilityForTool(exec.name, exec.arguments).executionLocation === 'routed_device'
        && service.deviceKind(targetFor(entry.binding)) === 'companion'
      try { service.recordAudit({ schemaVersion: 1, operationId: entry.operationId,
        executionId: entry.executionId, stopRequestId, principalId: entry.binding.principalId,
        sessionId: scopeForAgent(exec.agent) ?? entry.binding.sessionId, originChannel: entry.binding.originChannel,
        capabilityId: entry.capabilityId, toolName: entry.toolName,
        eventType: 'execution_settled', reasonCode: remoteUnknown ? 'REMOTE_EXECUTION_UNCONFIRMED'
          : exec.signal.aborted ? 'EXECUTION_CANCELLED' : result.isError ? 'EXECUTION_FAILED' : 'EXECUTION_COMPLETED',
        outcome: remoteUnknown ? 'unknown' : exec.signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'completed',
        createdAt: Date.now(), durationMs: Date.now() - entry.startedAt }) } catch { /* degraded */ }
    }
    grants.delete(exec.token)
    liveExecutions.delete(exec.token)
    return undefined
  })
  ctx.effect(() => () => { inbox.close(); grants.clear(); autoGrants.clear(); autoSessions.clear(); liveExecutions.clear(); trackedExecutions.clear(); staleExecutions.clear(); stopForExecution.clear() })
  ctx.effect(() => () => store.close())

  if (!state.enabled) console.error(`[ELARA-ACCESS] ${state.diagnostic}`)
  else console.log('[ELARA-ACCESS] Trusted identity and execution policy loaded')
}
