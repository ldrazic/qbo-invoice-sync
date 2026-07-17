import { loadConfig } from "./config.js";
import { migrate } from "./models/db/migrate.js";
import { createDb } from "./models/db/pool.js";
import { PgEntityLinkRepository } from "./models/repositories/entityLinkRepository.js";
import { PgEventQueue } from "./queue/pgEventQueue.js";
import { PgAuditRepository } from "./models/repositories/auditRepository.js";
import { PgProviderTokenRepository } from "./models/repositories/providerTokenRepository.js";
import { PgItemMappingRepository } from "./models/repositories/itemMappingRepository.js";
import { PgInternalInvoiceRepository } from "./models/repositories/internalInvoiceRepository.js";
import { createAccountingProvider } from "./providers/providerFactory.js";
import { QboProvider } from "./providers/quickbooks/qboProvider.js";
import { SyncService } from "./services/syncService.js";
import { WebhookEmitter } from "./services/webhookEmitter.js";
import { SyncWorker } from "./workers/syncWorker.js";
import { InvoiceController } from "./controllers/invoiceController.js";
import { WebhookController } from "./controllers/webhookController.js";
import { AdminController } from "./controllers/adminController.js";
import { QboAuthController } from "./controllers/qboAuthController.js";
import { UiController } from "./controllers/uiController.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await migrate(config.databaseUrl);
  const db = createDb(config.databaseUrl);

  const links = new PgEntityLinkRepository(db);
  const queue = new PgEventQueue(db);
  const audit = new PgAuditRepository(db);
  const tokenRepository = new PgProviderTokenRepository(db);
  const itemMappingRepository = new PgItemMappingRepository(db);
  const internalInvoices = new PgInternalInvoiceRepository(db);

  const provider = createAccountingProvider(config, { tokenRepository, itemMappingRepository });
  const syncService = new SyncService({ provider, links, audit, internalInvoices });
  const worker = new SyncWorker(queue, syncService, audit, {
    pollIntervalMs: config.syncPollIntervalMs,
    maxAttempts: config.syncMaxAttempts,
  });

  const emitter = new WebhookEmitter(
    process.env.INTERNAL_WEBHOOK_URL ?? `http://localhost:${config.port}/webhooks/internal`,
  );

  const app = buildServer({
    invoices: new InvoiceController(internalInvoices, emitter, db),
    webhooks: new WebhookController(queue, provider),
    admin: new AdminController(audit, queue, links, tokenRepository, provider.name),
    qboAuth: provider instanceof QboProvider ? new QboAuthController(provider.auth) : null,
    ui: new UiController(),
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  worker.start();
  app.log.info(`provider=${provider.name} — sync worker started`);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await worker.stop();
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
