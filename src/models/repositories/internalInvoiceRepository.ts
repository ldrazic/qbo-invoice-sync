import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import type { CanonicalInvoice, CanonicalPayment } from "../invoice.js";
import type {
  InternalInvoice,
  InternalInvoiceInput,
  InternalInvoiceRepository,
  InvoiceChanges,
} from "./types.js";

type Db = Kysely<Database> | Transaction<Database>;

export class PgInternalInvoiceRepository implements InternalInvoiceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: InternalInvoiceInput): Promise<InternalInvoice> {
    return this.db.transaction().execute(async (trx) => {
      const docNumber = input.docNumber ?? (await nextDocNumber(trx));
      const lines = normalizeLines(input.lines);
      const totalCents = lines.reduce((sum, l) => sum + l.amount_cents, 0);
      const invoice = await trx
        .insertInto("invoices")
        .values({
          doc_number: docNumber,
          customer_id: input.customerId,
          currency: input.currency ?? "USD",
          notes: input.notes ?? null,
          total_cents: totalCents,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await insertLines(trx, invoice.id, lines);
      return this.mustGet(trx, invoice.id);
    });
  }

  async update(id: string, changes: InvoiceChanges): Promise<InternalInvoice> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("invoices")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new Error(`invoice ${id} not found`);
      if (current.status === "voided" || current.status === "deleted") {
        throw new Error(`invoice ${id} is ${current.status} and cannot be edited`);
      }

      let totalCents = current.total_cents;
      if (changes.lines) {
        const lines = normalizeLines(changes.lines);
        totalCents = lines.reduce((sum, l) => sum + l.amount_cents, 0);
        await trx.deleteFrom("invoice_lines").where("invoice_id", "=", id).execute();
        await insertLines(trx, id, lines);
      }

      await trx
        .updateTable("invoices")
        .set({
          customer_id: changes.customerId ?? current.customer_id,
          currency: changes.currency ?? current.currency,
          notes: changes.notes === undefined ? current.notes : changes.notes,
          total_cents: totalCents,
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      await recomputePaymentStatus(trx, id);
      return this.mustGet(trx, id);
    });
  }

  async get(id: string): Promise<InternalInvoice | null> {
    return fetchFull(this.db, { id });
  }

  async getByDocNumber(docNumber: string): Promise<InternalInvoice | null> {
    return fetchFull(this.db, { docNumber });
  }

  async list(limit = 100): Promise<InternalInvoice[]> {
    const rows = await this.db
      .selectFrom("invoices")
      .select("id")
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    const invoices = await Promise.all(rows.map((r) => fetchFull(this.db, { id: r.id })));
    return invoices.filter((i): i is InternalInvoice => i !== null);
  }

  async setLifecycle(id: string, status: "voided" | "deleted"): Promise<InternalInvoice> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("invoices")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new Error(`invoice ${id} not found`);
      await trx
        .updateTable("invoices")
        .set({ status, version: current.version + 1, updated_at: new Date() })
        .where("id", "=", id)
        .execute();
      return this.mustGet(trx, id);
    });
  }

  async addPayment(
    invoiceId: string,
    payment: { amountCents: number; method?: string | undefined; receivedAt?: Date | undefined },
  ): Promise<{ invoice: InternalInvoice; paymentId: string }> {
    return this.db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("payments")
        .values({
          invoice_id: invoiceId,
          amount_cents: payment.amountCents,
          method: payment.method ?? "other",
          received_at: payment.receivedAt ?? new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await bumpVersion(trx, invoiceId);
      await recomputePaymentStatus(trx, invoiceId);
      return { invoice: await this.mustGet(trx, invoiceId), paymentId: created.id };
    });
  }

  async getPayment(
    paymentId: string,
  ): Promise<{ invoiceId: string; amountCents: number; method: string; receivedAt: Date } | null> {
    const row = await this.db
      .selectFrom("payments")
      .selectAll()
      .where("id", "=", paymentId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      invoiceId: row.invoice_id,
      amountCents: row.amount_cents,
      method: row.method,
      receivedAt: row.received_at,
    };
  }

  toCanonical(invoice: InternalInvoice): CanonicalInvoice {
    return {
      docNumber: invoice.docNumber,
      customerName: invoice.customerName,
      status: invoice.status,
      currency: invoice.currency,
      notes: invoice.notes,
      totalCents: invoice.totalCents,
      balanceCents: invoice.balanceCents,
      sourceUpdatedAt: invoice.updatedAt.toISOString(),
      lines: invoice.lines.map((l) => ({ ...l })),
    };
  }

  async applyCanonical(invoice: CanonicalInvoice, existingId?: string): Promise<InternalInvoice> {
    return this.db.transaction().execute(async (trx) => {
      const customerId = await ensureCustomer(trx, invoice.customerName);
      const lines = invoice.lines.map((l) => ({
        line_no: l.lineNo,
        item_code: l.itemCode,
        description: l.description,
        quantity: l.quantity,
        unit_price_cents: l.unitPriceCents,
        amount_cents: l.amountCents,
      }));

      let id = existingId;
      if (id) {
        const current = await trx
          .selectFrom("invoices")
          .selectAll()
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await trx.deleteFrom("invoice_lines").where("invoice_id", "=", id).execute();
        await insertLines(trx, id, lines);
        await trx
          .updateTable("invoices")
          .set({
            customer_id: customerId,
            currency: invoice.currency,
            notes: invoice.notes,
            total_cents: invoice.totalCents,
            // An active canonical state can resurrect a voided/deleted record
            // (LWW policy); payment-derived status is recomputed below.
            status:
              invoice.status === "voided" || invoice.status === "deleted"
                ? invoice.status
                : "open",
            version: current.version + 1,
            updated_at: new Date(),
          })
          .where("id", "=", id)
          .execute();
      } else {
        const created = await trx
          .insertInto("invoices")
          .values({
            doc_number: invoice.docNumber,
            customer_id: customerId,
            currency: invoice.currency,
            notes: invoice.notes,
            total_cents: invoice.totalCents,
            status:
              invoice.status === "voided" || invoice.status === "deleted"
                ? invoice.status
                : "open",
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        id = created.id;
        await insertLines(trx, id, lines);
      }
      await recomputePaymentStatus(trx, id);
      return this.mustGet(trx, id);
    });
  }

  async applyExternalPayment(
    invoiceId: string,
    payment: { amountCents: number; method?: string | undefined; receivedAt?: Date | undefined },
    externalRef: string,
  ): Promise<{ invoice: InternalInvoice; paymentId: string; created: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("payments")
        .values({
          invoice_id: invoiceId,
          amount_cents: payment.amountCents,
          method: payment.method ?? "other",
          received_at: payment.receivedAt ?? new Date(),
          external_ref: externalRef,
        })
        .onConflict((oc) => oc.column("external_ref").doNothing())
        .returning("id")
        .executeTakeFirst();

      if (inserted) {
        await bumpVersion(trx, invoiceId);
        await recomputePaymentStatus(trx, invoiceId);
        return { invoice: await this.mustGet(trx, invoiceId), paymentId: inserted.id, created: true };
      }

      // Already applied by a previous (crashed) attempt: converge.
      const existing = await trx
        .selectFrom("payments")
        .select(["id", "invoice_id"])
        .where("external_ref", "=", externalRef)
        .executeTakeFirstOrThrow();
      await recomputePaymentStatus(trx, existing.invoice_id);
      return { invoice: await this.mustGet(trx, existing.invoice_id), paymentId: existing.id, created: false };
    });
  }

  private async mustGet(db: Db, id: string): Promise<InternalInvoice> {
    const invoice = await fetchFull(db, { id });
    if (!invoice) throw new Error(`invoice ${id} not found`);
    return invoice;
  }
}

// --- helpers ---

async function nextDocNumber(db: Db): Promise<string> {
  const result = await sql<{ n: string }>`SELECT nextval('doc_number_seq') AS n`.execute(db);
  return `INV-${result.rows[0]!.n}`;
}

function normalizeLines(
  lines: InternalInvoiceInput["lines"],
): Array<{
  line_no: number;
  item_code: string;
  description: string | null;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
}> {
  return lines.map((l, i) => ({
    line_no: i + 1,
    item_code: l.itemCode,
    description: l.description ?? null,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    amount_cents: l.quantity * l.unitPriceCents,
  }));
}

async function insertLines(
  db: Db,
  invoiceId: string,
  lines: ReturnType<typeof normalizeLines>,
): Promise<void> {
  if (lines.length === 0) return;
  await db
    .insertInto("invoice_lines")
    .values(lines.map((l) => ({ ...l, invoice_id: invoiceId })))
    .execute();
}

async function ensureCustomer(db: Db, name: string): Promise<string> {
  const existing = await db
    .selectFrom("customers")
    .select("id")
    .where("name", "=", name)
    .executeTakeFirst();
  if (existing) return existing.id;
  const created = await db
    .insertInto("customers")
    .values({ name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return created.id;
}

async function bumpVersion(db: Db, invoiceId: string): Promise<void> {
  await db
    .updateTable("invoices")
    .set((eb) => ({ version: eb("version", "+", 1), updated_at: new Date() }))
    .where("id", "=", invoiceId)
    .execute();
}

/** Derive open/partial/paid from recorded payments; voided/deleted are sticky. */
async function recomputePaymentStatus(db: Db, invoiceId: string): Promise<void> {
  const invoice = await db
    .selectFrom("invoices")
    .select(["status", "total_cents"])
    .where("id", "=", invoiceId)
    .executeTakeFirstOrThrow();
  if (invoice.status === "voided" || invoice.status === "deleted") return;
  const paid = await db
    .selectFrom("payments")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount_cents"), sql<number>`0`).as("total"))
    .where("invoice_id", "=", invoiceId)
    .executeTakeFirstOrThrow();
  const paidCents = Number(paid.total);
  const status =
    paidCents <= 0 ? "open" : paidCents >= invoice.total_cents ? "paid" : "partial";
  await db.updateTable("invoices").set({ status }).where("id", "=", invoiceId).execute();
}

export async function fetchFull(
  db: Db,
  by: { id?: string; docNumber?: string },
): Promise<InternalInvoice | null> {
  let query = db
    .selectFrom("invoices")
    .innerJoin("customers", "customers.id", "invoices.customer_id")
    .selectAll("invoices")
    .select("customers.name as customer_name");
  if (by.id) query = query.where("invoices.id", "=", by.id);
  else if (by.docNumber) query = query.where("invoices.doc_number", "=", by.docNumber);
  else throw new Error("id or docNumber required");

  const row = await query.executeTakeFirst();
  if (!row) return null;

  const lines = await db
    .selectFrom("invoice_lines")
    .selectAll()
    .where("invoice_id", "=", row.id)
    .orderBy("line_no", "asc")
    .execute();
  const payments = await db
    .selectFrom("payments")
    .selectAll()
    .where("invoice_id", "=", row.id)
    .orderBy("received_at", "asc")
    .execute();

  const paidCents = payments.reduce((sum, p) => sum + p.amount_cents, 0);
  const isDead = row.status === "voided" || row.status === "deleted";
  return {
    id: row.id,
    docNumber: row.doc_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status as InternalInvoice["status"],
    currency: row.currency,
    notes: row.notes,
    totalCents: row.total_cents,
    balanceCents: isDead ? 0 : row.total_cents - paidCents,
    version: row.version,
    updatedAt: row.updated_at,
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      itemCode: l.item_code,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unit_price_cents,
      amountCents: l.amount_cents,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      amountCents: p.amount_cents,
      method: p.method,
      receivedAt: p.received_at,
    })),
  };
}
