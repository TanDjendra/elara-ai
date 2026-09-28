export const ACCESS_SCHEMA_VERSION = 1
export const POLICY_VERSION = 'elara-p2b-v1'

export type OriginChannel = 'whatsapp' | 'dashboard'
export type PrincipalRole = 'operator' | 'user'
export type DeviceKind = 'local' | 'companion'
export type Risk = 'read_only' | 'sensitive' | 'destructive' | 'unknown'
export type PolicyOutcome = 'allow' | 'deny' | 'approval_required'
export interface TrustedSessionContext { principalId: string; originChannel: OriginChannel }
export type StopOutcome = 'stopping' | 'stopped' | 'idle' | 'unconfirmed'
export interface StopStatus {
  id: string
  sessionId: string
  outcome: StopOutcome
  requestedAt: number
  settledAt?: number
}
export interface SessionAdmission { sessionId: string; generation: number; operationId: string }
export type ExecutionLocation = 'host' | 'routed_device' | 'control_plane'

export interface Principal {
  id: string
  role: PrincipalRole
  enabled: boolean
  channelAliases: Partial<Record<OriginChannel, string[]>>
  allowedDeviceIds: string[]
  /** Runtime-managed WhatsApp members can converse but cannot dispatch tools. */
  chatOnly?: boolean
  trustedWhatsAppOwner?: { name: string; aliases: string[] }
}

export interface DeviceDefinition {
  id: string
  kind: DeviceKind
  enabled: boolean
}

export interface AccessConfig {
  schemaVersion: typeof ACCESS_SCHEMA_VERSION
  policyVersion: string
  principals: Principal[]
  devices: DeviceDefinition[]
  authorities: {
    dashboardPrincipalId: string
    hostDeviceId: string
    channelDefaultDeviceIds: Record<OriginChannel, string>
  }
}

export interface SessionBinding {
  sessionId: string
  principalId: string
  originChannel: OriginChannel
  createdAt: number
  schemaVersion: typeof ACCESS_SCHEMA_VERSION
}

export interface ExecutionContext {
  principalId: string
  sessionId: string
  targetDeviceId: string
  selectedDeviceId?: string
  runtimeMode?: string
  denialReasonCode?: string
  source: string
  signal?: AbortSignal
}

export interface Capability {
  id: string
  toolName?: string
  risk: Risk
  requiresDevice: boolean
  executionLocation: ExecutionLocation
}

export interface PolicyDecision {
  outcome: PolicyOutcome
  reasonCode: string
  policyVersion: string
  capability: Capability
}

export interface DecisionRecord {
  principalId: string
  sessionId: string
  capabilityId: string
  targetDeviceId: string
  decision: PolicyOutcome
  reasonCode: string
  policyVersion: string
  source: string
  createdAt: number
}

export class AccessDeniedError extends Error {
  readonly code: string
  readonly outcome: PolicyOutcome

  constructor(decision: PolicyDecision) {
    super(`${decision.reasonCode}: managed execution is not permitted`)
    this.name = 'AccessDeniedError'
    this.code = decision.reasonCode
    this.outcome = decision.outcome
  }
}
