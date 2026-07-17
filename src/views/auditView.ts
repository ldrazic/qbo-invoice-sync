import type { AuditEntry } from "../models/repositories/types.js";

export function auditView(entry: AuditEntry & { id: number; createdAt: Date }) {
  return {
    id: entry.id,
    inboundEventId: entry.inboundEventId ?? null,
    entityType: entry.entityType,
    internalId: entry.internalId ?? null,
    externalId: entry.externalId ?? null,
    action: entry.action,
    detail: entry.detail ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}
