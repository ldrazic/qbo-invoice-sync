import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { registerRoutes, type Controllers } from "./routes/index.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Raw request body, needed to verify webhook HMAC signatures. */
    rawBody?: string;
  }
}

export function buildServer(controllers: Controllers): FastifyInstance {
  const app = Fastify({ logger: { level: "info" } });

  // Keep the raw body: the QBO intuit-signature HMAC is computed over the
  // exact bytes received — verifying a re-serialized JSON body always fails.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = (body as Buffer).toString("utf8");
    if (req.rawBody.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(req.rawBody));
    } catch (err) {
      done(err as Error);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation failed", issues: err.issues });
    }
    app.log.error(err);
    const message = err instanceof Error ? err.message : "internal error";
    return reply.code(500).send({ error: message });
  });

  registerRoutes(app, controllers);
  return app;
}
