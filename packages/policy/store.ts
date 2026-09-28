import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ACCESS_SCHEMA_VERSION, type DecisionRecord, type OriginChannel, type SessionBinding, type StopStatus } from './contracts.ts'
import { AUDIT_SCHEMA_VERSION, projectAudit, type AuditRecord } from './audit.ts'

export class AccessStore {
  readonly db: DatabaseSync

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_bindings (
        session_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principal_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        target_device_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_policy_decisions_session_time
        ON policy_decisions(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        execution_id TEXT,
        approval_id TEXT,
        stop_request_id TEXT,
        principal_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        target_device_id TEXT,
        capability_id TEXT,
        tool_name TEXT,
        policy_version TEXT,
        event_type TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_audit_scope ON audit_events(principal_id, origin_channel, session_id, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_terminal ON audit_events(execution_id)
        WHERE event_type = 'execution_settled' AND execution_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS whatsapp_members (
        member_id TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        revoked_at INTEGER,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_member_active_alias
        ON whatsapp_members(alias) WHERE revoked_at IS NULL;
      UPDATE audit_events SET outcome = 'unknown', reason_code = 'PROCESS_RESTARTED'
        WHERE outcome IN ('requested', 'stopping') AND (
          (event_type = 'dispatch_started' AND NOT EXISTS (
            SELECT 1 FROM audit_events terminal WHERE terminal.execution_id = audit_events.execution_id
              AND terminal.event_type = 'execution_settled'))
          OR (event_type = 'stop_requested' AND NOT EXISTS (
            SELECT 1 FROM audit_events terminal WHERE terminal.stop_request_id = audit_events.stop_request_id
              AND terminal.event_type = 'stop_settled'))
          OR (event_type = 'approval_requested' AND NOT EXISTS (
            SELECT 1 FROM audit_events terminal WHERE terminal.approval_id = audit_events.approval_id
              AND terminal.event_type = 'approval_resolved'))
        );
    `)
  }

  listWhatsAppMembers(): Array<{ id: string; alias: string }> {
    const rows = this.db.prepare(`SELECT member_id, alias FROM whatsapp_members
      WHERE revoked_at IS NULL ORDER BY added_at, member_id`).all() as Array<{ member_id: string; alias: string }>
    return rows.map(row => ({ id: row.member_id, alias: row.alias }))
  }

  addWhatsAppMember(id: string, alias: string, audit: AuditRecord): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO whatsapp_members (member_id, alias, added_at, schema_version) VALUES (?, ?, ?, 1)`)
        .run(id, alias, Date.now())
      this.recordAudit(audit)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  revokeWhatsAppMember(id: string, audit: AuditRecord): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.db.prepare(`UPDATE whatsapp_members SET revoked_at = ?
        WHERE member_id = ? AND revoked_at IS NULL`).run(Date.now(), id)
      if (changed.changes !== 1) throw new Error('MEMBER_NOT_FOUND')
      this.recordAudit(audit)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  revokeWhatsAppMemberWithoutAudit(id: string): void {
    const changed = this.db.prepare(`UPDATE whatsapp_members SET revoked_at = ?
      WHERE member_id = ? AND revoked_at IS NULL`).run(Date.now(), id)
    if (changed.changes !== 1) throw new Error('MEMBER_NOT_FOUND')
  }

  bindingFor(sessionId: string): SessionBinding | undefined {
    const row = this.db.prepare(`
      SELECT session_id, principal_id, origin_channel, created_at, schema_version
      FROM session_bindings WHERE session_id = ?
    `).get(sessionId) as any
    if (!row) return undefined
    return {
      sessionId: row.session_id,
      principalId: row.principal_id,
      originChannel: row.origin_channel as OriginChannel,
      createdAt: row.created_at,
      schemaVersion: row.schema_version,
    }
  }

  bindSession(sessionId: string, principalId: string, originChannel: OriginChannel): SessionBinding {
    const existing = this.bindingFor(sessionId)
    if (existing) {
      if (existing.principalId !== principalId || existing.originChannel !== originChannel) {
        throw new Error('SESSION_OWNER_CONFLICT')
      }
      return existing
    }
    const binding: SessionBinding = {
      sessionId,
      principalId,
      originChannel,
      createdAt: Date.now(),
      schemaVersion: ACCESS_SCHEMA_VERSION,
    }
    try {
      this.db.prepare(`
        INSERT INTO session_bindings (session_id, principal_id, origin_channel, created_at, schema_version)
        VALUES (?, ?, ?, ?, ?)
      `).run(binding.sessionId, binding.principalId, binding.originChannel, binding.createdAt, binding.schemaVersion)
    } catch {
      const raced = this.bindingFor(sessionId)
      if (!raced || raced.principalId !== principalId || raced.originChannel !== originChannel) {
        throw new Error('SESSION_OWNER_CONFLICT')
      }
      return raced
    }
    return binding
  }

  record(record: DecisionRecord): void {
    this.db.prepare(`
      INSERT INTO policy_decisions (
        principal_id, session_id, capability_id, target_device_id,
        decision, reason_code, policy_version, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.principalId, record.sessionId, record.capabilityId, record.targetDeviceId,
      record.decision, record.reasonCode, record.policyVersion, record.source, record.createdAt,
    )
  }

  recordAudit(input: AuditRecord): number {
    const record = projectAudit(input)
    const result = this.db.prepare(`INSERT INTO audit_events (
      schema_version, operation_id, execution_id, approval_id, stop_request_id,
      principal_id, session_id, origin_channel, target_device_id, capability_id,
      tool_name, policy_version, event_type, reason_code, outcome, created_at, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      AUDIT_SCHEMA_VERSION, record.operationId, record.executionId ?? null,
      record.approvalId ?? null, record.stopRequestId ?? null, record.principalId,
      record.sessionId, record.originChannel, record.targetDeviceId ?? null,
      record.capabilityId ?? null, record.toolName ?? null, record.policyVersion ?? null,
      record.eventType, record.reasonCode, record.outcome, record.createdAt,
      record.durationMs ?? null,
    )
    return Number(result.lastInsertRowid)
  }

  listAudit(principalId: string, originChannel: OriginChannel, sessionId: string, cursor?: number, limit = 50): AuditRecord[] {
    const take = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50
    const bound = cursor === undefined ? Number.MAX_SAFE_INTEGER : cursor
    if (!Number.isSafeInteger(bound) || bound < 1) throw new Error('AUDIT_CURSOR_INVALID')
    const rows = this.db.prepare(`SELECT * FROM audit_events WHERE principal_id = ?
      AND origin_channel = ? AND session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(principalId, originChannel, sessionId, bound, take) as any[]
    return rows.map(row => ({
      id: row.id, schemaVersion: AUDIT_SCHEMA_VERSION, operationId: row.operation_id,
      executionId: row.execution_id ?? undefined, approvalId: row.approval_id ?? undefined,
      stopRequestId: row.stop_request_id ?? undefined, principalId: row.principal_id,
      sessionId: row.session_id, originChannel: row.origin_channel,
      targetDeviceId: row.target_device_id ?? undefined, capabilityId: row.capability_id ?? undefined,
      toolName: row.tool_name ?? undefined, policyVersion: row.policy_version ?? undefined,
      eventType: row.event_type, reasonCode: row.reason_code, outcome: row.outcome,
      createdAt: row.created_at, durationMs: row.duration_ms ?? undefined,
    }))
  }

  stopStatus(id: string): { status: StopStatus; principalId: string; originChannel: OriginChannel } | undefined {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
    const requested = this.db.prepare(`SELECT session_id, principal_id, origin_channel, created_at
      FROM audit_events WHERE stop_request_id = ? AND event_type = 'stop_requested'
      ORDER BY id DESC LIMIT 1`).get(id) as any
    if (!requested) return undefined
    const settled = this.db.prepare(`SELECT outcome, created_at FROM audit_events
      WHERE stop_request_id = ? AND event_type = 'stop_settled' ORDER BY id DESC LIMIT 1`).get(id) as any
    const outcome = settled?.outcome
    return {
      principalId: requested.principal_id, originChannel: requested.origin_channel,
      status: { id, sessionId: requested.session_id, requestedAt: requested.created_at,
        outcome: outcome === 'stopped' || outcome === 'idle' || outcome === 'unconfirmed' ? outcome : 'unconfirmed',
        settledAt: settled?.created_at },
    }
  }

  latestStopStatus(sessionId: string): StopStatus | undefined {
    const row = this.db.prepare(`SELECT stop_request_id FROM audit_events WHERE session_id = ?
      AND event_type = 'stop_requested' ORDER BY id DESC LIMIT 1`).get(sessionId) as any
    return row ? this.stopStatus(row.stop_request_id)?.status : undefined
  }

  close(): void {
    this.db.close()
  }
}
