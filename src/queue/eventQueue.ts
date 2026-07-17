/**
 * Transport-neutral port for the durable event queue. The sync engine (worker,
 * ingestion endpoints, admin) depends only on this contract; Postgres is one
 * adapter (pgEventQueue.ts).
 *
 * Swapping in a broker (Kafka, SQS, ...) means writing another adapter that
 * maps these semantics onto it: publish-side dedupe -> idempotent producer or
 * consumer-side dedupe store; claim + lease -> consumer group / visibility
 * timeout; retryLater -> delayed redelivery or retry topics; deadLetter ->
 * DLQ topic; requeue -> replay from the DLQ.
 */

export type InboundEventStatus =
  | "pending"
  | "in_flight"
  | "processed"
  | "skipped"
  | "failed"
  | "dead";

export interface InboundEvent {
  id: number;
  source: string;
  entityType: string;
  entityId: string;
  operation: string;
  occurredAt: Date;
  dedupeKey: string;
  payload: unknown;
  status: InboundEventStatus;
  attempts: number;
  lastError: string | null;
}

export interface IngestEventInput {
  source: string;
  entityType: string;
  entityId: string;
  operation: string;
  occurredAt: Date;
  dedupeKey: string;
  payload?: unknown;
}

export interface EventQueue {
  /**
   * Write side: durably enqueue a change notification, at-least-once.
   * Duplicate dedupeKey is a no-op; returns null so callers can report it.
   */
  publish(event: IngestEventInput): Promise<InboundEvent | null>;

  /**
   * Read side: exclusively claim the next due event for leaseMs. Events whose
   * lease expired (crashed consumer) become claimable again. Null when empty.
   */
  claim(leaseMs: number): Promise<InboundEvent | null>;

  /** Terminal success: the event was processed (or intentionally skipped). */
  ack(id: number, disposition: "processed" | "skipped"): Promise<void>;

  /** Release the event to be redelivered at nextAttemptAt. */
  retryLater(id: number, nextAttemptAt: Date, error: string): Promise<void>;

  /** Terminal failure: park the event for human inspection. */
  deadLetter(id: number, error: string): Promise<void>;

  // --- operational (admin UI / tests) ---
  listByStatus(status: InboundEventStatus, limit?: number): Promise<InboundEvent[]>;
  /** Re-enqueue a dead-lettered event after human intervention. */
  requeue(id: number): Promise<void>;
}
