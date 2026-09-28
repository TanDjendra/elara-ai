import * as fs from 'node:fs'
import * as path from 'node:path'
import { POLICY_VERSION, type AccessConfig, type Capability, type ExecutionContext, type PolicyDecision } from './contracts.ts'

const host = (id: string, toolName: string, risk: Capability['risk']): Capability => ({
  id, toolName, risk, requiresDevice: true, executionLocation: 'host',
})
const routed = (id: string, toolName: string, risk: Capability['risk']): Capability => ({
  id, toolName, risk, requiresDevice: true, executionLocation: 'routed_device',
})
const control = (id: string, toolName: string, risk: Capability['risk']): Capability => ({
  id, toolName, risk, requiresDevice: false, executionLocation: 'control_plane',
})

const TOOL_CAPABILITIES: Readonly<Record<string, Capability>> = Object.freeze({
  elara_windows_status: routed('system.status', 'elara_windows_status', 'read_only'),
  read: host('workspace.read', 'read', 'read_only'),
  read_image: host('workspace.read_image', 'read_image', 'read_only'),
  glob: host('workspace.glob', 'glob', 'read_only'),
  grep: host('workspace.grep', 'grep', 'read_only'),
  list_agents: control('agents.list', 'list_agents', 'read_only'),
  list_subagent_models: control('agents.models', 'list_subagent_models', 'read_only'),
  elara_about: control('elara.about', 'elara_about', 'read_only'),
  elara_test_echo: control('test.echo', 'elara_test_echo', 'read_only'),
  get_goal: control('goal.read', 'get_goal', 'read_only'),
  job_list: control('jobs.list', 'job_list', 'read_only'),
  write: host('workspace.write', 'write', 'sensitive'),
  edit: host('workspace.edit', 'edit', 'sensitive'),
  pwsh: host('shell.pwsh', 'pwsh', 'sensitive'),
  bash: host('shell.bash', 'bash', 'sensitive'),
  run_code: host('code.run', 'run_code', 'sensitive'),
  elara_project_test: routed('project.test', 'elara_project_test', 'sensitive'),
  elara_project_build: routed('project.build', 'elara_project_build', 'sensitive'),
  elara_project_typecheck: routed('project.typecheck', 'elara_project_typecheck', 'sensitive'),
  elara_fs_list: routed('legacy.fs_list', 'elara_fs_list', 'sensitive'),
  elara_fs_read: routed('legacy.fs_read', 'elara_fs_read', 'sensitive'),
  elara_fs_write: routed('legacy.fs_write', 'elara_fs_write', 'sensitive'),
  elara_process_exec: routed('legacy.process_exec', 'elara_process_exec', 'sensitive'),
  elara_store_memory: control('memory.store', 'elara_store_memory', 'sensitive'),
  create_goal: control('goal.create', 'create_goal', 'sensitive'),
  update_goal: control('goal.update', 'update_goal', 'sensitive'),
  exit_plan_mode: control('planning.exit', 'exit_plan_mode', 'sensitive'),
  interrupt_agent: control('agents.interrupt', 'interrupt_agent', 'sensitive'),
  send_message: control('agents.message', 'send_message', 'sensitive'),
  subagent: control('agents.create', 'subagent', 'sensitive'),
  subagent_fork: control('agents.fork', 'subagent_fork', 'sensitive'),
  todo_write: control('todo.write', 'todo_write', 'sensitive'),
  workflow: host('workflow.run', 'workflow', 'sensitive'),
  skill: host('skill.load', 'skill', 'sensitive'),
  web_fetch: control('web.fetch', 'web_fetch', 'sensitive'),
  web_search: control('web.search', 'web_search', 'sensitive'),
  job_output: control('jobs.output', 'job_output', 'sensitive'),
  job_kill: control('jobs.kill', 'job_kill', 'destructive'),
})

const P2A_REMOTE_TOOL_NAMES = new Set(['elara_windows_status'])
const FILE_READ_TOOLS = new Set(['read', 'read_image'])
const SEARCH_TOOLS = new Set(['glob', 'grep'])

export interface FilesystemAssessment {
  risk?: 'sensitive'
  denialReasonCode?: string
}

export function isP2ARemoteCapability(toolName: string): boolean {
  return P2A_REMOTE_TOOL_NAMES.has(toolName)
}

export function executionRoute(mode: string | undefined, deviceKind: 'local' | 'companion' | undefined): 'local' | 'companion' {
  if (!deviceKind) throw new Error('TARGET_DEVICE_DISABLED_OR_UNKNOWN')
  if (mode === 'cloud' && deviceKind !== 'companion') throw new Error('CLOUD_TARGET_MUST_BE_COMPANION')
  return deviceKind
}

function privateSegments(target: string): boolean {
  const segments = target.split(/[\\/]+/u).filter(Boolean).map(segment => {
    // Win32 named streams retain their suffix in realpath; classify the owning
    // file or directory so `.env:stream` cannot bypass private-path protection.
    const owner = process.platform === 'win32' ? segment.split(':', 1)[0]! : segment
    return owner.toLocaleLowerCase('en-US')
  })
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (segment === '.ssh' || segment === '.aws' || segment === '.azure' || segment === '.gnupg'
      || segment === '.kube' || segment === '.runtime' || segment === '.baileys_auth_info'
      || segment === 'credential' || segment === 'credentials' || segment === 'secret'
      || segment === 'secrets' || segment === 'token' || segment === 'tokens'
      || segment === '.env' || segment.startsWith('.env.')) return true
    if (segment === 'profiles' && segments[index + 1] === 'local') return true
  }
  return false
}

function containsLinkOrJunction(absolutePath: string): boolean {
  const parsed = path.parse(absolutePath)
  let current = parsed.root
  const rest = absolutePath.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean)
  for (const segment of rest) {
    current = path.join(current, segment)
    if (fs.lstatSync(current).isSymbolicLink()) return true
  }
  return false
}

/** Resolve the same native host target used by DSH filesystem tools before classifying it. */
export function assessFilesystemTool(name: string, args: unknown, sessionCwd: string | undefined): FilesystemAssessment {
  if (SEARCH_TOOLS.has(name)) {
    // Ripgrep can expose protected descendants and link targets before the
    // policy can filter results; an approval does not enforce search scope.
    return { denialReasonCode: 'SEARCH_SCOPE_UNENFORCEABLE' }
  }
  if (!FILE_READ_TOOLS.has(name)) return {}
  if (!sessionCwd || !path.isAbsolute(sessionCwd)) return { denialReasonCode: 'FILESYSTEM_CWD_UNTRUSTED' }
  const raw = args && typeof args === 'object' && 'file_path' in args
    ? (args as { file_path?: unknown }).file_path
    : undefined
  if (typeof raw !== 'string' || !raw.trim()) return { denialReasonCode: 'FILESYSTEM_TARGET_UNRESOLVED' }
  try {
    // On Windows this applies Win32 drive, UNC, alternate-separator, and
    // dot-segment semantics, matching DSH's native localDisplayPath behavior.
    const lexical = path.resolve(sessionCwd, raw)
    const canonical = fs.realpathSync.native(lexical)
    if (privateSegments(lexical) || privateSegments(canonical)) return { risk: 'sensitive' }
    // P2A does not authorize link/junction traversal: without binding DSH's
    // later resolve to this exact inode, a retarget between policy and dispatch
    // would reopen a TOCTOU path.
    if (containsLinkOrJunction(lexical)) return { denialReasonCode: 'FILESYSTEM_LINK_SCOPE_DISABLED' }
    return {}
  } catch {
    return { denialReasonCode: 'FILESYSTEM_TARGET_UNRESOLVED' }
  }
}

export function capabilityForTool(name: string, _args: unknown, assessment: FilesystemAssessment = {}): Capability {
  const known = TOOL_CAPABILITIES[name]
  if (!known) {
    return {
      id: `unknown:${name.slice(0, 96)}`, toolName: name, risk: 'unknown',
      requiresDevice: true, executionLocation: 'host',
    }
  }
  return assessment.risk === 'sensitive' && known.risk === 'read_only'
    ? { ...known, risk: 'sensitive' }
    : known
}

export function capabilityById(id: string): Capability {
  return Object.values(TOOL_CAPABILITIES).find(capability => capability.id === id)
    ?? { id, risk: 'unknown', requiresDevice: true, executionLocation: 'host' }
}

export function evaluatePolicy(
  config: AccessConfig | undefined,
  context: ExecutionContext,
  capability: Capability,
  bindingPrincipalId: string | undefined,
): PolicyDecision {
  const policyVersion = config ? POLICY_VERSION : 'unavailable'
  const decision = (outcome: PolicyDecision['outcome'], reasonCode: string): PolicyDecision => ({
    outcome, reasonCode, policyVersion, capability,
  })
  if (!config) return decision('deny', 'ACCESS_CONFIG_UNAVAILABLE')
  const principal = config.principals.find(candidate => candidate.id === context.principalId)
  if (!principal?.enabled) return decision('deny', 'PRINCIPAL_DISABLED_OR_UNKNOWN')
  if (bindingPrincipalId !== principal.id) return decision('deny', 'SESSION_OWNER_UNTRUSTED')
  if (principal.chatOnly) return decision('deny', 'CHAT_ONLY_ROLE')
  if (context.denialReasonCode) return decision('deny', context.denialReasonCode)
  if (capability.executionLocation === 'host') {
    if (context.targetDeviceId !== config.authorities.hostDeviceId
      || context.selectedDeviceId !== config.authorities.hostDeviceId) {
      return decision('deny', 'EXECUTION_TARGET_MISMATCH')
    }
    if (context.runtimeMode === 'cloud') return decision('deny', 'HOST_EXECUTION_DISABLED_IN_CLOUD')
  }
  if (capability.requiresDevice) {
    const device = config.devices.find(candidate => candidate.id === context.targetDeviceId)
    if (!device?.enabled) return decision('deny', 'TARGET_DEVICE_DISABLED_OR_UNKNOWN')
    if (!principal.allowedDeviceIds.includes(device.id)) return decision('deny', 'TARGET_DEVICE_UNAUTHORIZED')
  }
  if (capability.risk === 'unknown') return decision('deny', 'CAPABILITY_UNKNOWN')
  if (capability.risk === 'sensitive') return decision('approval_required', 'P2A_APPROVAL_REQUIRED')
  if (capability.risk === 'destructive') return decision('deny', 'DESTRUCTIVE_CAPABILITY_DISABLED')
  return decision('allow', 'READ_ONLY_ALLOWED')
}

export const CAPABILITY_MATRIX = TOOL_CAPABILITIES
