import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AccountingProvider } from "../providers/accountingProvider.js";
import type { InboxRepository } from "../models/repositories/types.js";

const internalEventSchema = z.object({
  entityType: z.enum(["invoice", "payment"]),
  entityId: z.string().min(1),
  operation: z.enum(["create", "update", "void", "delete"]),
  version: z.number().int(),
  occurredAt: z.string(),
});

/**
 * Ingestion endpoints. Their only job: authenticate, parse, persist to the
 * inbox (dedupe happens there via the unique dedupe_key), ack fast. All
 * actual sync work happens asynchronously in the worker — a webhook endpoint
 * that does slow work inline gets timed out and re-delivered.
 */
export class WebhookController {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly provider: AccountingProvider,
  ) {}

  handleInternal = async (req: FastifyRequest, reply: FastifyReply) => {
    const event = internalEventSchema.parse(req.body);
    const inserted = await this.inbox.ingest({
      source: "internal",
      entityType: event.entityType,
      entityId: event.entityId,
      operation: event.operation,
      occurredAt: new Date(event.occurredAt),
      // version makes retries of the same delivery idempotent while letting
      // every new edit through
      dedupeKey: `internal:${event.entityType}:${event.entityId}:${event.operation}:${event.version}`,
      payload: event,
    });
    return reply.send({ accepted: true, duplicate: inserted === null });
  };

  handleProvider = async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const signature = req.headers["intuit-signature"];
    if (!this.provider.verifyWebhookSignature(rawBody, asString(signature))) {
      return reply.code(401).send({ error: "invalid signature" });
    }
    const events = this.provider.parseWebhook(rawBody);
    let duplicates = 0;
    for (const event of events) {
      const inserted = await this.inbox.ingest({
        source: this.provider.name,
        entityType: event.entityType,
        entityId: event.entityId,
        operation: event.operation,
        occurredAt: new Date(event.occurredAt),
        dedupeKey: event.dedupeKey,
        payload: event,
      });
      if (inserted === null) duplicates += 1;
    }
    return reply.send({ accepted: events.length - duplicates, duplicates });
  };
}

function asString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
