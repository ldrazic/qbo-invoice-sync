import { sql, type Kysely } from "kysely";
import type { Database } from "../models/db/schema.js";
import type {
  EventQueue,
  InboundEvent,
  InboundEventStatus,
  IngestEventInput,
} from "./eventQueue.js";

interface Row {
  id: number;
  source: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  occurred_at: Date;
  dedupe_key: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
}

function toEvent(row: Row): InboundEvent {
  return {
    id: row.id,
    source: row.source,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    occurredAt: row.occurred_at,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    status: row.status as InboundEventStatus,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

/** Postgres adapter: inbox table + FOR UPDATE SKIP LOCKED work queue. */
export class PgEventQueue implements EventQueue {
  constructor(private readonly db: Kysely<Database>) {}

  async publish(event: IngestEventInput): Promise<InboundEvent | null> {
    const row = await this.db
      .insertInto("inbound_events")
      .values({
        source: event.source,
        entity_type: event.entityType,
        entity_id: event.entityId,
        operation: event.operation,
        occurred_at: event.occurredAt,
        dedupe_key: event.dedupeKey,
        payload: event.payload === undefined ? null : JSON.stringify(event.payload),
      })
      .onConflict((oc) => oc.column("dedupe_key").doNothing())
      .returningAll()
      .executeTakeFirst();
    return row ? toEvent(row) : null;
  }

  async claim(leaseMs: number): Promise<InboundEvent | null> {
    return this.db.transaction().execute(async (trx) => {
      // Due-ness and lease expiry are decided on the database clock, the same
      // clock that stamped next_attempt_at on insert; comparing against the
      // app clock would make freshly published events invisible under skew.
      const dbNow = sql<Date>`clock_timestamp()`;
      const row = await trx
        .selectFrom("inbound_events")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([
              eb("status", "in", ["pending", "failed"]),
              eb("next_attempt_at", "<=", dbNow),
            ]),
            // Reclaim events whose worker died mid-processing (expired lease).
            eb.and([eb("status", "=", "in_flight"), eb("locked_until", "<=", dbNow)]),
          ]),
        )
        .orderBy("id", "asc")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return null;

      const updated = await trx
        .updateTable("inbound_events")
        .set({
          status: "in_flight",
          attempts: row.attempts + 1,
          locked_until: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toEvent(updated);
    });
  }

  async ack(id: number, disposition: "processed" | "skipped"): Promise<void> {
    await this.markTerminal(id, disposition);
  }

  async deadLetter(id: number, error: string): Promise<void> {
    await this.markTerminal(id, "dead", error);
  }

  async retryLater(id: number, nextAttemptAt: Date, error: string): Promise<void> {
    await this.db
      .updateTable("inbound_events")
      .set({
        status: "failed",
        next_attempt_at: nextAttemptAt,
        locked_until: null,
        last_error: error,
      })
      .where("id", "=", id)
      .execute();
  }

  async listByStatus(status: InboundEventStatus, limit = 100): Promise<InboundEvent[]> {
    const rows = await this.db
      .selectFrom("inbound_events")
      .selectAll()
      .where("status", "=", status)
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map(toEvent);
  }

  async requeue(id: number): Promise<void> {
    await this.db
      .updateTable("inbound_events")
      .set({ status: "pending", next_attempt_at: new Date(), attempts: 0, locked_until: null })
      .where("id", "=", id)
      .execute();
  }

  private async markTerminal(
    id: number,
    status: "processed" | "skipped" | "dead",
    error?: string,
  ): Promise<void> {
    await this.db
      .updateTable("inbound_events")
      .set({
        status,
        processed_at: new Date(),
        locked_until: null,
        last_error: error ?? null,
      })
      .where("id", "=", id)
      .execute();
  }
}
