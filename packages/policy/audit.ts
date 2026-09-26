import { randomUUID } from 'node:crypto'
import type { OriginChannel } from './contracts.ts'
import { CAPABILITY_MATRIX } from './evaluate.ts'

export const AUDIT_SCHEMA_VERSION = 1
export type AuditEvent = 'policy_decision' | 'approval_requested' | 'approval_resolved' |
  'dispatch_started' | 'execution_settled' | 'stop_requested' | 'stop_settled' | 'auto_mode_changed'
export type AuditOutcome = 'allowed' | 'denied' | 'requested' | 'rejected' |
  'expired' | 'cancelled' | 'failed' | 'completed' | 'unknown' | 'stopping' | 'stopped' | 'idle' | 'unconfirmed'

export interface AuditRecord {
  id?: number
  schemaVersion: typeof AUDIT_SCHEMA_VERSION
  operationId: string
  executionId?: string
  approvalId?: string
  stopRequestId?: string
  principalId: string
  sessionId: string
  originChannel: OriginChannel
  targetDeviceId?: string
  capabilityId?: string
  toolName?: string
  policyVersion?: string
  eventType: AuditEvent
  reasonCode: string
  outcome: AuditOutcome
  createdAt: number
  durationMs?: number
}

export function auditId(): string { return randomUUID() }

const knownEvents = new Set<AuditEvent>([
  'policy_decision', 'approval_requested', 'approval_resolved', 'dispatch_started',
  'execution_settled', 'stop_requested', 'stop_settled', 'auto_mode_changed',
])
const knownOutcomes = new Set<AuditOutcome>([
  'allowed', 'denied', 'requested', 'rejected', 'expired', 'cancelled', 'failed',
  'completed', 'unknown', 'stopping', 'stopped', 'idle', 'unconfirmed',
])
const safeIdentifier = /^[a-zA-Z0-9_.:@-]{1,160}$/
const safeReason = /^[A-Z0-9_]{1,80}$/
const knownTools = new Set(Object.keys(CAPABILITY_MATRIX))
const knownCapabilities = new Set(Object.values(CAPABILITY_MATRIX).map(capability => capability.id))

/** Enforce the persisted projection at the storage boundary. */
export function projectAudit(input: AuditRecord): AuditRecord {
  const identifier = (value: string | undefined, required = false): string | undefined => {
    if (value === undefined && !required) return undefined
    if (!value || !safeIdentifier.test(value)) throw new Error('AUDIT_FIELD_INVALID')
    return value
  }
  if (!knownEvents.has(input.eventType) || !knownOutcomes.has(input.outcome)
    || !safeReason.test(input.reasonCode)
    || !Number.isSafeInteger(input.createdAt)
    || (input.durationMs !== undefined && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0))
    || !['dashboard', 'whatsapp'].includes(input.originChannel)) throw new Error('AUDIT_FIELD_INVALID')
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    operationId: identifier(input.operationId, true)!,
    executionId: identifier(input.executionId),
    approvalId: identifier(input.approvalId),
    stopRequestId: identifier(input.stopRequestId),
    principalId: identifier(input.principalId, true)!,
    sessionId: identifier(input.sessionId, true)!,
    originChannel: input.originChannel,
    targetDeviceId: identifier(input.targetDeviceId),
    capabilityId: input.capabilityId && knownCapabilities.has(input.capabilityId)
      ? identifier(input.capabilityId) : undefined,
    toolName: input.toolName && knownTools.has(input.toolName)
      ? identifier(input.toolName) : undefined,
    policyVersion: identifier(input.policyVersion),
    eventType: input.eventType,
    reasonCode: input.reasonCode,
    outcome: input.outcome,
    createdAt: input.createdAt,
    durationMs: input.durationMs,
  }
}
