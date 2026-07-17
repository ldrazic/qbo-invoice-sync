import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AuditRepository,
  EntityLinkRepository,
  ProviderTokenRepository,
} from "../models/repositories/types.js";
import type { EventQueue, InboundEventStatus } from "../queue/eventQueue.js";
import { auditView } from "../views/auditView.js";

/** Observability endpoints: audit trail, dead-letter queue, links, status. */
export class AdminController {
  constructor(
    private readonly audit: AuditRepository,
    private readonly queue: EventQueue,
    private readonly links: EntityLinkRepository,
    private readonly tokens: ProviderTokenRepository,
    private readonly providerName: string,
  ) {}

  listAudit = async (_req: FastifyRequest, reply: FastifyReply) => {
    const entries = await this.audit.list();
    return reply.send(entries.map(auditView));
  };

  listEvents = async (
    req: FastifyRequest<{ Querystring: { status?: string } }>,
    reply: FastifyReply,
  ) => {
    const status = (req.query.status ?? "dead") as InboundEventStatus;
    const events = await this.queue.listByStatus(status);
    return reply.send(events);
  };

  requeueEvent = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    await this.queue.requeue(Number(req.params.id));
    return reply.send({ requeued: true });
  };

  listLinks = async (_req: FastifyRequest, reply: FastifyReply) => {
    const links = await this.links.listAll();
    return reply.send(
      links.map((l) => ({
        id: l.id,
        provider: l.provider,
        entityType: l.entityType,
        internalId: l.internalId,
        externalId: l.externalId,
        externalSyncToken: l.externalSyncToken,
        internalVersion: l.internalVersion,
        lastSyncedAt: l.lastSyncedAt ? l.lastSyncedAt.toISOString() : null,
      })),
    );
  };

  qboStatus = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (this.providerName !== "quickbooks") {
      return reply.send({ provider: this.providerName, connected: true, realmId: null });
    }
    const tokens = await this.tokens.get("quickbooks");
    return reply.send({
      provider: "quickbooks",
      connected: tokens !== null,
      realmId: tokens?.realmId ?? null,
      accessTokenExpiresAt: tokens?.accessTokenExpiresAt.toISOString() ?? null,
    });
  };
}
