import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { ComparableInvoice } from "../invoice.js";
import type { EntityLink, EntityLinkRepository, MarkSyncedInput } from "./types.js";

interface Row {
  id: number;
  provider: string;
  entity_type: string;
  internal_id: string;
  external_id: string;
  external_sync_token: string | null;
  internal_version: number | null;
  last_synced_hash: string | null;
  last_synced_snapshot: unknown;
  last_synced_at: Date | null;
}

function toLink(row: Row): EntityLink {
  return {
    id: row.id,
    provider: row.provider,
    entityType: row.entity_type,
    internalId: row.internal_id,
    externalId: row.external_id,
    externalSyncToken: row.external_sync_token,
    internalVersion: row.internal_version,
    lastSyncedHash: row.last_synced_hash,
    lastSyncedSnapshot: (row.last_synced_snapshot as ComparableInvoice | null) ?? null,
    lastSyncedAt: row.last_synced_at,
  };
}

export class PgEntityLinkRepository implements EntityLinkRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findByInternalId(provider: string, entityType: string, internalId: string): Promise<EntityLink | null> {
    const row = await this.db
      .selectFrom("entity_links")
      .selectAll()
      .where("provider", "=", provider)
      .where("entity_type", "=", entityType)
      .where("internal_id", "=", internalId)
      .executeTakeFirst();
    return row ? toLink(row) : null;
  }

  async findByExternalId(provider: string, entityType: string, externalId: string): Promise<EntityLink | null> {
    const row = await this.db
      .selectFrom("entity_links")
      .selectAll()
      .where("provider", "=", provider)
      .where("entity_type", "=", entityType)
      .where("external_id", "=", externalId)
      .executeTakeFirst();
    return row ? toLink(row) : null;
  }

  async create(link: Omit<EntityLink, "id" | "lastSyncedAt"> & { lastSyncedAt?: Date }): Promise<EntityLink> {
    const row = await this.db
      .insertInto("entity_links")
      .values({
        provider: link.provider,
        entity_type: link.entityType,
        internal_id: link.internalId,
        external_id: link.externalId,
        external_sync_token: link.externalSyncToken,
        internal_version: link.internalVersion,
        last_synced_hash: link.lastSyncedHash,
        last_synced_snapshot: link.lastSyncedSnapshot
          ? JSON.stringify(link.lastSyncedSnapshot)
          : null,
        last_synced_at: link.lastSyncedAt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toLink(row);
  }

  async listAll(limit = 200): Promise<EntityLink[]> {
    const rows = await this.db
      .selectFrom("entity_links")
      .selectAll()
      .orderBy("updated_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(toLink);
  }

  async updateExternalId(id: number, externalId: string): Promise<void> {
    await this.db
      .updateTable("entity_links")
      .set({ external_id: externalId, updated_at: new Date() })
      .where("id", "=", id)
      .execute();
  }

  async markSynced(id: number, input: MarkSyncedInput): Promise<void> {
    await this.db
      .updateTable("entity_links")
      .set({
        external_sync_token: input.externalSyncToken,
        internal_version: input.internalVersion,
        last_synced_hash: input.hash,
        last_synced_snapshot: JSON.stringify(input.snapshot),
        last_synced_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .execute();
  }
}
