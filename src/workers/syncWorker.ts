import type { EventQueue, InboundEvent } from "../queue/eventQueue.js";
import type { AuditRepository } from "../models/repositories/types.js";
import type { SyncService } from "../services/syncService.js";
import { PermanentProviderError, StaleVersionError } from "../providers/errors.js";

export interface SyncWorkerOptions {
  pollIntervalMs: number;
  maxAttempts: number;
  /** How long a claimed event stays locked before another worker may reclaim it. */
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/**
 * Consumes the event queue and runs each event through the sync pipeline.
 *
 * Outcome handling:
 * - ok/skip                  -> ack (processed / skipped)
 * - StaleVersionError        -> retry; next attempt refetches fresh state,
 *                               so optimistic-lock races self-heal
 * - transient/unknown errors -> retry with exponential backoff + jitter
 * - PermanentProviderError   -> dead-letter immediately
 * - attempts exhausted       -> dead-letter
 */
export class SyncWorker {
  private running = false;
  private currentProcessing: Promise<void> | null = null;

  constructor(
    private readonly queue: EventQueue,
    private readonly syncService: SyncService,
    private readonly audit: AuditRepository,
    private readonly options: SyncWorkerOptions,
  ) {}

  start(): void {
    this.running = true;
    void this.loop();
  }

  /** Graceful shutdown: stop claiming, let the in-flight event finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.currentProcessing) await this.currentProcessing;
  }

  /** Drain everything currently due. */
  async drain(): Promise<number> {
    let processed = 0;
    // Cap iterations so a retry loop cannot spin forever in tests.
    for (let i = 0; i < 1000; i++) {
      const worked = await this.tick();
      if (!worked) break;
      processed += 1;
    }
    return processed;
  }

  /** Claim and process one event. Returns false when the queue is empty. */
  async tick(): Promise<boolean> {
    const event = await this.queue.claim(this.options.leaseMs ?? 60_000);
    if (!event) return false;
    this.currentProcessing = this.processClaimed(event);
    await this.currentProcessing;
    this.currentProcessing = null;
    return true;
  }

  private async processClaimed(event: InboundEvent): Promise<void> {
    try {
      const outcome = await this.syncService.processEvent(event);
      await this.queue.ack(event.id, outcome.kind === "ok" ? "processed" : "skipped");
    } catch (err) {
      await this.handleError(event, err);
    }
  }

  private async handleError(event: InboundEvent, err: unknown): Promise<void> {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

    const permanent = err instanceof PermanentProviderError;
    const exhausted = event.attempts >= this.options.maxAttempts;
    if (permanent || exhausted) {
      await this.queue.deadLetter(event.id, message);
      await this.audit.record({
        inboundEventId: event.id,
        entityType: event.entityType,
        action: "failed",
        detail: {
          reason: permanent ? "permanent_error" : "attempts_exhausted",
          message,
          attempts: event.attempts,
        },
      });
      return;
    }

    // Stale optimistic-lock races retry quickly; other transient failures
    // back off exponentially with jitter.
    const delayMs =
      err instanceof StaleVersionError ? 100 : this.backoffDelay(event.attempts);
    await this.queue.retryLater(event.id, new Date(Date.now() + delayMs), message);
  }

  private backoffDelay(attempts: number): number {
    const base = this.options.backoffBaseMs ?? 1_000;
    const max = this.options.backoffMaxMs ?? 60_000;
    const exp = Math.min(base * 2 ** (attempts - 1), max);
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let worked = false;
      try {
        worked = await this.tick();
      } catch (err) {
        console.error("sync worker tick failed:", err);
      }
      if (!worked && this.running) {
        await sleep(this.options.pollIntervalMs);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
