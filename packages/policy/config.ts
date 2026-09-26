import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ACCESS_SCHEMA_VERSION,
  type AccessConfig,
  type DeviceDefinition,
  type OriginChannel,
  type Principal,
} from './contracts.ts'

export interface AccessConfigState {
  enabled: boolean
  config?: AccessConfig
  diagnostic: string
  path: string
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CHANNELS: OriginChannel[] = ['whatsapp', 'dashboard']

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} contains unknown fields`)
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} must be a lowercase stable identifier`)
  return value
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 255) {
    throw new Error(`${label} must be a non-empty exact string without surrounding whitespace`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map((entry, index) => exactString(entry, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} contains a duplicate value`)
  return result
}

export function validateAccessConfig(value: unknown): AccessConfig {
  const root = object(value, 'access configuration')
  exactKeys(root, ['schemaVersion', 'policyVersion', 'principals', 'devices', 'authorities'], 'access configuration')
  if (root.schemaVersion !== ACCESS_SCHEMA_VERSION) throw new Error(`schemaVersion must be ${ACCESS_SCHEMA_VERSION}`)
  const policyVersion = exactString(root.policyVersion, 'policyVersion')
  if (!Array.isArray(root.devices) || root.devices.length === 0) throw new Error('devices must be a non-empty array')
  const devices: DeviceDefinition[] = root.devices.map((entry, index) => {
    const item = object(entry, `devices[${index}]`)
    exactKeys(item, ['id', 'kind', 'enabled'], `devices[${index}]`)
    const id = identifier(item.id, `devices[${index}].id`)
    if (item.kind !== 'local' && item.kind !== 'companion') throw new Error(`devices[${index}].kind is invalid`)
    if (typeof item.enabled !== 'boolean') throw new Error(`devices[${index}].enabled must be boolean`)
    return { id, kind: item.kind, enabled: item.enabled }
  })
  const deviceIds = new Set(devices.map(device => device.id))
  if (deviceIds.size !== devices.length) throw new Error('device ids must be unique')

  if (!Array.isArray(root.principals) || root.principals.length === 0) throw new Error('principals must be a non-empty array')
  const aliases = new Map<string, string>()
  const principals: Principal[] = root.principals.map((entry, index) => {
    const item = object(entry, `principals[${index}]`)
    exactKeys(item, ['id', 'role', 'enabled', 'channelAliases', 'allowedDeviceIds', 'trustedWhatsAppOwner'], `principals[${index}]`)
    const id = identifier(item.id, `principals[${index}].id`)
    if (item.role !== 'operator' && item.role !== 'user') throw new Error(`principals[${index}].role is invalid`)
    if (typeof item.enabled !== 'boolean') throw new Error(`principals[${index}].enabled must be boolean`)
    const rawAliases = object(item.channelAliases, `principals[${index}].channelAliases`)
    for (const key of Object.keys(rawAliases)) {
      if (!CHANNELS.includes(key as OriginChannel)) throw new Error(`principals[${index}].channelAliases contains an unknown channel`)
    }
    const channelAliases: Principal['channelAliases'] = {}
    for (const channel of CHANNELS) {
      if (rawAliases[channel] === undefined) continue
      const values = stringArray(rawAliases[channel], `principals[${index}].channelAliases.${channel}`)
      channelAliases[channel] = values
      for (const alias of values) {
        const key = `${channel}\u0000${alias}`
        const prior = aliases.get(key)
        if (prior && prior !== id) throw new Error(`channel alias conflict on ${channel}`)
        aliases.set(key, id)
      }
    }
    const allowedDeviceIds = stringArray(item.allowedDeviceIds, `principals[${index}].allowedDeviceIds`)
    if (allowedDeviceIds.some(deviceId => !deviceIds.has(deviceId))) {
      throw new Error(`principals[${index}].allowedDeviceIds contains an unknown device`)
    }
    let trustedWhatsAppOwner: Principal['trustedWhatsAppOwner']
    if (item.trustedWhatsAppOwner !== undefined) {
      const owner = object(item.trustedWhatsAppOwner, `principals[${index}].trustedWhatsAppOwner`)
      exactKeys(owner, ['name', 'aliases'], `principals[${index}].trustedWhatsAppOwner`)
      const name = exactString(owner.name, `principals[${index}].trustedWhatsAppOwner.name`)
      const ownerAliases = stringArray(owner.aliases, `principals[${index}].trustedWhatsAppOwner.aliases`)
      if (!ownerAliases.length || ownerAliases.some(alias => !channelAliases.whatsapp?.includes(alias))) {
        throw new Error(`principals[${index}].trustedWhatsAppOwner must use configured WhatsApp aliases`)
      }
      trustedWhatsAppOwner = { name, aliases: ownerAliases }
    }
    return { id, role: item.role, enabled: item.enabled, channelAliases, allowedDeviceIds, trustedWhatsAppOwner }
  })
  const principalIds = new Set(principals.map(principal => principal.id))
  if (principalIds.size !== principals.length) throw new Error('principal ids must be unique')

  const authorities = object(root.authorities, 'authorities')
  exactKeys(authorities, ['dashboardPrincipalId', 'hostDeviceId', 'channelDefaultDeviceIds'], 'authorities')
  const dashboardPrincipalId = identifier(authorities.dashboardPrincipalId, 'authorities.dashboardPrincipalId')
  if (!principalIds.has(dashboardPrincipalId)) throw new Error('dashboard authority references an unknown principal')
  const hostDeviceId = identifier(authorities.hostDeviceId, 'authorities.hostDeviceId')
  const hostDevice = devices.find(device => device.id === hostDeviceId)
  if (!hostDevice || hostDevice.kind !== 'local' || !hostDevice.enabled) {
    throw new Error('hostDeviceId must reference an enabled local device')
  }
  const defaults = object(authorities.channelDefaultDeviceIds, 'authorities.channelDefaultDeviceIds')
  exactKeys(defaults, CHANNELS, 'authorities.channelDefaultDeviceIds')
  const channelDefaultDeviceIds = {} as Record<OriginChannel, string>
  for (const channel of CHANNELS) {
    const deviceId = identifier(defaults[channel], `authorities.channelDefaultDeviceIds.${channel}`)
    if (!deviceIds.has(deviceId)) throw new Error(`default device for ${channel} is unknown`)
    channelDefaultDeviceIds[channel] = deviceId
  }
  const dashboardPrincipal = principals.find(principal => principal.id === dashboardPrincipalId)
  if (dashboardPrincipal?.role !== 'operator' || !dashboardPrincipal.channelAliases.dashboard?.length) {
    throw new Error('dashboard authority must reference an enabled operator with an explicit dashboard alias')
  }
  for (const principal of principals) {
    for (const channel of CHANNELS) {
      if (principal.channelAliases[channel]?.length
        && !principal.allowedDeviceIds.includes(channelDefaultDeviceIds[channel])) {
        throw new Error(`principal ${principal.id} does not authorize the configured ${channel} target`)
      }
    }
  }
  return {
    schemaVersion: ACCESS_SCHEMA_VERSION,
    policyVersion,
    principals,
    devices,
    authorities: { dashboardPrincipalId, hostDeviceId, channelDefaultDeviceIds },
  }
}

export function loadAccessConfig(rootDir: string, configuredPath?: string): AccessConfigState {
  const accessPath = path.resolve(configuredPath?.trim() || path.join(rootDir, 'profiles', 'local', 'access.json'))
  try {
    const parsed = JSON.parse(fs.readFileSync(accessPath, 'utf8'))
    return { enabled: true, config: validateAccessConfig(parsed), diagnostic: 'access configuration loaded', path: accessPath }
  } catch (error: any) {
    const kind = error?.code === 'ENOENT' ? 'missing' : 'invalid'
    return {
      enabled: false,
      diagnostic: `Managed execution disabled: ${kind} local access configuration. Copy profiles/access.example.json to profiles/local/access.json and configure trusted aliases and devices.`,
      path: accessPath,
    }
  }
}
