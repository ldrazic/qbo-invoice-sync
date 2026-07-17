import type { FastifyReply, FastifyRequest } from "fastify";
import type { QboAuth } from "../providers/quickbooks/qboAuth.js";

/**
 * OAuth connect flow for QuickBooks. Provider-specific by nature (each
 * provider brings its own auth dance), so it is wired up only when the
 * QuickBooks provider is active.
 */
export class QboAuthController {
  constructor(private readonly auth: QboAuth) {}

  connect = async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.redirect(this.auth.buildAuthorizeUrl());
  };

  callback = async (
    req: FastifyRequest<{ Querystring: { code?: string; realmId?: string; state?: string } }>,
    reply: FastifyReply,
  ) => {
    const { code, realmId, state } = req.query;
    if (!code || !realmId || !state) {
      return reply.code(400).send({ error: "missing code/realmId/state" });
    }
    await this.auth.handleCallback(code, realmId, state);
    return reply.send({ connected: true, realmId });
  };
}
