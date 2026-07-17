import type { FastifyInstance } from "fastify";
import type { InvoiceController } from "../controllers/invoiceController.js";
import type { WebhookController } from "../controllers/webhookController.js";
import type { AdminController } from "../controllers/adminController.js";
import type { QboAuthController } from "../controllers/qboAuthController.js";
import type { UiController } from "../controllers/uiController.js";

export interface Controllers {
  invoices: InvoiceController;
  webhooks: WebhookController;
  admin: AdminController;
  qboAuth: QboAuthController | null;
  ui: UiController;
}

export function registerRoutes(app: FastifyInstance, c: Controllers): void {
  app.get("/health", async () => ({ ok: true }));

  // --- console + schematic UI ---
  app.get("/", c.ui.index);
  app.get("/app.js", c.ui.appJs);

  // --- internal invoicing system (simulated but real: CRUD + webhooks) ---
  app.post("/internal/customers", c.invoices.createCustomer);
  app.get("/internal/customers", c.invoices.listCustomers);
  app.post("/internal/invoices", c.invoices.create);
  app.get("/internal/invoices", c.invoices.list);
  app.get("/internal/invoices/:id", c.invoices.get);
  app.put("/internal/invoices/:id", c.invoices.update);
  app.post("/internal/invoices/:id/void", c.invoices.void);
  app.delete("/internal/invoices/:id", c.invoices.delete);
  app.post("/internal/invoices/:id/payments", c.invoices.addPayment);

  // --- change ingestion ---
  app.post("/webhooks/internal", c.webhooks.handleInternal);
  app.post("/webhooks/qbo", c.webhooks.handleProvider);

  // --- observability / operations ---
  app.get("/admin/audit", c.admin.listAudit);
  app.get("/admin/events", c.admin.listEvents);
  app.post("/admin/events/:id/requeue", c.admin.requeueEvent);
  app.get("/admin/links", c.admin.listLinks);
  app.get("/admin/qbo-status", c.admin.qboStatus);

  // --- provider OAuth (QuickBooks only) ---
  if (c.qboAuth) {
    app.get("/qbo/connect", c.qboAuth.connect);
    app.get("/qbo/callback", c.qboAuth.callback);
  }
}
