import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { AuditAction, AuditEntry, AuditRepository } from "./types.js";

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db
      .insertInto("audit_log")
      .values({
        inbound_event_id: entry.inboundEventId ?? null,
        entity_type: entry.entityType,
        internal_id: entry.internalId ?? null,
        external_id: entry.externalId ?? null,
        action: entry.action,
        detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
      })
      .execute();
  }

  async list(limit = 200): Promise<Array<AuditEntry & { id: number; createdAt: Date }>> {
    const rows = await this.db
      .selectFrom("audit_log")
      .selectAll()
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      inboundEventId: r.inbound_event_id ?? undefined,
      entityType: r.entity_type,
      internalId: r.internal_id ?? undefined,
      externalId: r.external_id ?? undefined,
      action: r.action as AuditAction,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }
}
