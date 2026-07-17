import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Serves the single-page console + schematic UI. */
export class UiController {
  private cached: string | null = null;

  private cachedJs: string | null = null;

  index = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (this.cached === null || process.env.NODE_ENV !== "production") {
      this.cached = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
    }
    return reply.type("text/html; charset=utf-8").send(this.cached);
  };

  appJs = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (this.cachedJs === null || process.env.NODE_ENV !== "production") {
      this.cachedJs = await readFile(join(PUBLIC_DIR, "app.js"), "utf8");
    }
    return reply.type("application/javascript; charset=utf-8").send(this.cachedJs);
  };
}
