import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Kysely } from "kysely";
import type { Database } from "../models/db/schema.js";
import type { InternalInvoiceRepository } from "../models/repositories/types.js";
import type { WebhookEmitter } from "../services/webhookEmitter.js";
import { invoiceView } from "../views/invoiceView.js";

const lineSchema = z.object({
  itemCode: z.string().min(1),
  description: z.string().nullish(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
});

const createInvoiceSchema = z.object({
  customerId: z.string().uuid(),
  currency: z.string().length(3).optional(),
  notes: z.string().nullish(),
  lines: z.array(lineSchema).min(1),
});

const updateInvoiceSchema = z.object({
  customerId: z.string().uuid().optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().nullish(),
  lines: z.array(lineSchema).min(1).optional(),
});

const paymentSchema = z.object({
  amountCents: z.number().int().positive(),
  method: z.string().optional(),
});

const customerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
});

/**
 * CRUD for the simulated internal invoicing system. Every mutation emits a
 * webhook to the sync service, exactly like a real external system would.
 */
export class InvoiceController {
  constructor(
    private readonly invoices: InternalInvoiceRepository,
    private readonly emitter: WebhookEmitter,
    private readonly db: Kysely<Database>,
  ) {}

  createCustomer = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = customerSchema.parse(req.body);
    const customer = await this.db
      .insertInto("customers")
      .values({ name: body.name, email: body.email ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
    return reply.code(201).send(customer);
  };

  listCustomers = async (_req: FastifyRequest, reply: FastifyReply) => {
    const customers = await this.db.selectFrom("customers").selectAll().execute();
    return reply.send(customers);
  };

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = createInvoiceSchema.parse(req.body);
    const invoice = await this.invoices.create(body);
    this.emitter.emit({
      entityType: "invoice",
      entityId: invoice.id,
      operation: "create",
      version: invoice.version,
      occurredAt: new Date().toISOString(),
    });
    return reply.code(201).send(invoiceView(invoice));
  };

  list = async (_req: FastifyRequest, reply: FastifyReply) => {
    const invoices = await this.invoices.list();
    return reply.send(invoices.map(invoiceView));
  };

  get = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const invoice = await this.invoices.get(req.params.id);
    if (!invoice) return reply.code(404).send({ error: "invoice not found" });
    return reply.send(invoiceView(invoice));
  };

  update = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const body = updateInvoiceSchema.parse(req.body);
    const invoice = await this.invoices.update(req.params.id, body);
    this.emitter.emit({
      entityType: "invoice",
      entityId: invoice.id,
      operation: "update",
      version: invoice.version,
      occurredAt: new Date().toISOString(),
    });
    return reply.send(invoiceView(invoice));
  };

  void = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const invoice = await this.invoices.setLifecycle(req.params.id, "voided");
    this.emitter.emit({
      entityType: "invoice",
      entityId: invoice.id,
      operation: "void",
      version: invoice.version,
      occurredAt: new Date().toISOString(),
    });
    return reply.send(invoiceView(invoice));
  };

  delete = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const invoice = await this.invoices.setLifecycle(req.params.id, "deleted");
    this.emitter.emit({
      entityType: "invoice",
      entityId: invoice.id,
      operation: "delete",
      version: invoice.version,
      occurredAt: new Date().toISOString(),
    });
    return reply.send(invoiceView(invoice));
  };

  addPayment = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const body = paymentSchema.parse(req.body);
    const { invoice, paymentId } = await this.invoices.addPayment(req.params.id, body);
    this.emitter.emit({
      entityType: "payment",
      entityId: paymentId,
      operation: "create",
      version: invoice.version,
      occurredAt: new Date().toISOString(),
    });
    return reply.code(201).send(invoiceView(invoice));
  };
}
