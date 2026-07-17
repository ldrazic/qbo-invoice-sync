import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../src/models/db/schema.js";
import { setupTestDb, truncateAll } from "./helpers/testDb.js";
import { FakeProvider } from "../src/providers/fake/fakeProvider.js";
import { PgEntityLinkRepository } from "../src/models/repositories/entityLinkRepository.js";
import { PgInboxRepository } from "../src/models/repositories/inboxRepository.js";
import { PgAuditRepository } from "../src/models/repositories/auditRepository.js";
import { PgInternalInvoiceRepository } from "../src/models/repositories/internalInvoiceRepository.js";
import { SyncService } from "../src/services/syncService.js";
import { SyncWorker } from "../src/workers/syncWorker.js";
import type { InternalInvoice } from "../src/models/repositories/types.js";

let db: Kysely<Database>;

interface Stack {
  provider: FakeProvider;
  links: PgEntityLinkRepository;
  inbox: PgInboxRepository;
  audit: PgAuditRepository;
  invoices: PgInternalInvoiceRepository;
  worker: SyncWorker;
}

function buildStack(): Stack {
  const provider = new FakeProvider();
  const links = new PgEntityLinkRepository(db);
  const inbox = new PgInboxRepository(db);
  const audit = new PgAuditRepository(db);
  const invoices = new PgInternalInvoiceRepository(db);
  const syncService = new SyncService({ provider, links, audit, internalInvoices: invoices });
  const worker = new SyncWorker(inbox, syncService, audit, {
    pollIntervalMs: 5,
    maxAttempts: 5,
    backoffBaseMs: 1,
    backoffMaxMs: 5,
    leaseMs: 60_000,
  });
  return { provider, links, inbox, audit, invoices, worker };
}

/** Drain the queue across retry rounds until nothing is due. */
async function processQueue(stack: Stack, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await stack.worker.drain();
    const remaining = await db
      .selectFrom("inbound_events")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("status", "in", ["pending", "failed"])
      .executeTakeFirstOrThrow();
    if (Number(remaining.n) === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function createCustomer(name = "Acme Corp"): Promise<string> {
  const row = await db
    .insertInto("customers")
    .values({ name })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

async function createInvoice(stack: Stack, customerId: string): Promise<InternalInvoice> {
  return stack.invoices.create({
    customerId,
    notes: "initial note",
    lines: [{ itemCode: "Services", description: "Consulting", quantity: 2, unitPriceCents: 5_000 }],
  });
}

function internalEvent(
  invoice: { id: string; version: number },
  operation: string,
  entityType = "invoice",
  entityId?: string,
) {
  return {
    source: "internal",
    entityType,
    entityId: entityId ?? invoice.id,
    operation,
    occurredAt: new Date(),
    dedupeKey: `internal:${entityType}:${entityId ?? invoice.id}:${operation}:${invoice.version}`,
  };
}

function providerEvent(entityId: string, operation: string, entityType = "invoice", salt = "") {
  return {
    source: "fake",
    entityType,
    entityId,
    operation,
    occurredAt: new Date(),
    dedupeKey: `fake:${entityType}:${entityId}:${operation}:${salt || Date.now()}`,
  };
}

/** Create + fully sync an invoice; returns internal invoice and external id. */
async function syncedInvoice(stack: Stack): Promise<{ invoice: InternalInvoice; externalId: string }> {
  const customerId = await createCustomer();
  const invoice = await createInvoice(stack, customerId);
  await stack.inbox.ingest(internalEvent(invoice, "create"));
  await processQueue(stack);
  const link = await stack.links.findByInternalId("fake", "invoice", invoice.id);
  expect(link).not.toBeNull();
  return { invoice, externalId: link!.externalId };
}

beforeEach(async () => {
  db = await setupTestDb();
  await truncateAll(db);
});

afterAll(async () => {
  await db.destroy();
});

describe("invoice creation sync", () => {
  it("creates the invoice in the provider and links both records", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    expect(stack.provider.invoiceCount()).toBe(1);
    const stored = stack.provider.directlyGetInvoice(externalId)!;
    expect(stored.invoice.docNumber).toBe(invoice.docNumber);
    expect(stored.invoice.totalCents).toBe(10_000);

    const audit = await stack.audit.list();
    expect(audit.some((a) => a.action === "applied")).toBe(true);
  });
});

describe("duplicate webhook delivery", () => {
  it("dedupes identical deliveries at the inbox and never writes twice", async () => {
    const stack = buildStack();
    const customerId = await createCustomer();
    const invoice = await createInvoice(stack, customerId);

    const first = await stack.inbox.ingest(internalEvent(invoice, "create"));
    const second = await stack.inbox.ingest(internalEvent(invoice, "create"));
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // ON CONFLICT DO NOTHING

    await processQueue(stack);
    expect(stack.provider.invoiceCount()).toBe(1);
    expect(stack.provider.calls.filter((c) => c.startsWith("createInvoice")).length).toBe(1);
  });

  it("skips a redelivery that got a fresh dedupe key (already-synced state)", async () => {
    const stack = buildStack();
    const { invoice } = await syncedInvoice(stack);

    // Same logical change redelivered later with a different dedupe key.
    await stack.inbox.ingest({
      ...internalEvent(invoice, "create"),
      dedupeKey: `internal:invoice:${invoice.id}:create:redelivery`,
    });
    await processQueue(stack);

    expect(stack.provider.invoiceCount()).toBe(1);
    const audit = await stack.audit.list();
    expect(audit[0]!.action).toMatch(/skipped_(echo|noop)/);
  });
});

describe("echo suppression", () => {
  it("ignores the provider webhook caused by our own write", async () => {
    const stack = buildStack();
    const { externalId } = await syncedInvoice(stack);
    const callsBefore = stack.provider.calls.length;

    await stack.inbox.ingest(providerEvent(externalId, "create", "invoice", "echo"));
    await processQueue(stack);

    const audit = await stack.audit.list();
    expect(audit[0]!.action).toBe("skipped_echo");
    // Only the refetch happened; no writes back to the provider.
    const newCalls = stack.provider.calls.slice(callsBefore);
    expect(newCalls.every((c) => c.startsWith("getInvoice"))).toBe(true);
  });
});

describe("out-of-order events", () => {
  it("degrades stale events into no-ops because state is always refetched", async () => {
    const stack = buildStack();
    const { invoice } = await syncedInvoice(stack);

    const v2 = await stack.invoices.update(invoice.id, { notes: "second edit" });
    const v3 = await stack.invoices.update(invoice.id, { notes: "third edit" });

    // The NEWER event arrives first and is processed.
    await stack.inbox.ingest(internalEvent(v3, "update"));
    await processQueue(stack);
    // The OLDER event arrives late.
    await stack.inbox.ingest(internalEvent(v2, "update"));
    await processQueue(stack);

    const link = await stack.links.findByInternalId("fake", "invoice", invoice.id);
    const stored = stack.provider.directlyGetInvoice(link!.externalId)!;
    expect(stored.invoice.notes).toBe("third edit");

    const audit = await stack.audit.list();
    expect(audit[0]!.action).toMatch(/skipped_(echo|noop)/);
  });
});

describe("timeout after write (ambiguous write)", () => {
  it("recovers via docNumber lookup instead of creating a duplicate", async () => {
    const stack = buildStack();
    const customerId = await createCustomer();
    const invoice = await createInvoice(stack, customerId);

    // The provider applies the create, then the call "times out".
    stack.provider.failNext({ kind: "timeout_after_write" });
    await stack.inbox.ingest(internalEvent(invoice, "create"));
    await processQueue(stack);

    expect(stack.provider.invoiceCount()).toBe(1);
    expect(stack.provider.calls.filter((c) => c.startsWith("createInvoice")).length).toBe(1);

    const link = await stack.links.findByInternalId("fake", "invoice", invoice.id);
    expect(link).not.toBeNull();
    const audit = await stack.audit.list();
    expect(audit.some((a) => a.action === "linked_existing")).toBe(true);

    const events = await stack.inbox.listByStatus("processed");
    expect(events).toHaveLength(1);
  });
});

describe("conflicting edits (last write wins)", () => {
  const HOUR = 60 * 60 * 1000;

  it("overwrites the older side wholesale when the external write is newer", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    // Internal edits notes; external (newer) edits amounts.
    const edited = await stack.invoices.update(invoice.id, { notes: "older internal edit" });
    const stored = stack.provider.directlyGetInvoice(externalId)!;
    stack.provider.directlySetInvoice(externalId, {
      ...stored.invoice,
      sourceUpdatedAt: new Date(Date.now() + HOUR).toISOString(),
      totalCents: 25_000,
      balanceCents: 25_000,
      lines: [
        {
          lineNo: 1,
          itemCode: "Services",
          description: "Consulting",
          quantity: 5,
          unitPriceCents: 5_000,
          amountCents: 25_000,
        },
      ],
    });

    await stack.inbox.ingest(internalEvent(edited, "update"));
    await processQueue(stack);

    const internalAfter = await stack.invoices.get(invoice.id);
    expect(internalAfter!.totalCents).toBe(25_000);
    // LWW is wholesale: the internal note edit is overwritten too.
    expect(internalAfter!.notes).toBe("initial note");

    const audit = await stack.audit.list();
    const lww = audit.find((a) => a.action === "conflict_lww");
    expect(lww).toBeDefined();
    expect((lww!.detail as { decision: string }).decision).toBe("lww_external");
    // The overwritten internal state is preserved for auditability.
    expect((lww!.detail as { overwritten: { notes: string } }).overwritten.notes).toBe(
      "older internal edit",
    );
  });

  it("pushes the internal state wholesale when the internal write is newer", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    const stored = stack.provider.directlyGetInvoice(externalId)!;
    stack.provider.directlySetInvoice(externalId, {
      ...stored.invoice,
      sourceUpdatedAt: new Date(Date.now() - HOUR).toISOString(),
      totalCents: 40_000,
      balanceCents: 40_000,
    });
    const edited = await stack.invoices.update(invoice.id, { notes: "newer internal edit" });

    await stack.inbox.ingest(internalEvent(edited, "update"));
    await processQueue(stack);

    const externalAfter = stack.provider.directlyGetInvoice(externalId)!;
    expect(externalAfter.invoice.notes).toBe("newer internal edit");
    // External's own (older) amount edit was overwritten back.
    expect(externalAfter.invoice.totalCents).toBe(10_000);
    expect((await stack.invoices.get(invoice.id))!.totalCents).toBe(10_000);
  });

  it("resolves void-vs-edit by recency instead of flagging", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    // External edits (older)...
    const stored = stack.provider.directlyGetInvoice(externalId)!;
    stack.provider.directlySetInvoice(externalId, {
      ...stored.invoice,
      sourceUpdatedAt: new Date(Date.now() - HOUR).toISOString(),
      notes: "external kept working on this",
    });
    // ...then the internal user voids (newer): the void wins.
    const voided = await stack.invoices.setLifecycle(invoice.id, "voided");

    await stack.inbox.ingest(internalEvent(voided, "void"));
    await processQueue(stack);

    expect(stack.provider.directlyGetInvoice(externalId)!.invoice.status).toBe("voided");
    // Nothing left stuck: LWW never parks events waiting for a human.
    expect(await stack.inbox.listByStatus("dead")).toHaveLength(0);
    expect(await stack.inbox.listByStatus("pending")).toHaveLength(0);
    const audit = await stack.audit.list();
    expect(audit.some((a) => a.action === "conflict_lww")).toBe(true);
  });

  it("recreates an externally hard-deleted invoice when the internal write is newer", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    stack.provider.directlyDeleteInvoice(externalId);
    const edited = await stack.invoices.update(invoice.id, { notes: "edited after delete" });

    await stack.inbox.ingest(internalEvent(edited, "update"));
    await processQueue(stack);

    expect(stack.provider.invoiceCount()).toBe(1);
    const link = await stack.links.findByInternalId("fake", "invoice", invoice.id);
    expect(link!.externalId).not.toBe(externalId);
    const recreated = stack.provider.directlyGetInvoice(link!.externalId)!;
    expect(recreated.invoice.notes).toBe("edited after delete");
    expect(recreated.invoice.docNumber).toBe(invoice.docNumber);
  });
});

describe("void and delete propagation", () => {
  it("propagates an internal delete as a provider VOID (audit-trail policy)", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    const deleted = await stack.invoices.setLifecycle(invoice.id, "deleted");
    await stack.inbox.ingest(internalEvent(deleted, "delete"));
    await processQueue(stack);

    const stored = stack.provider.directlyGetInvoice(externalId)!;
    expect(stored.invoice.status).toBe("voided");
    expect(stored.invoice.totalCents).toBe(0);
  });

  it("propagates a provider hard-delete as an internal delete", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    stack.provider.directlyDeleteInvoice(externalId);
    await stack.inbox.ingest(providerEvent(externalId, "delete"));
    await processQueue(stack);

    const internalAfter = await stack.invoices.get(invoice.id);
    expect(internalAfter!.status).toBe("deleted");
  });
});

describe("payments", () => {
  it("replicates an internal payment to the provider exactly once", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    const { invoice: updated, paymentId } = await stack.invoices.addPayment(invoice.id, {
      amountCents: 4_000,
    });
    expect(updated.status).toBe("partial");

    await stack.inbox.ingest(internalEvent(updated, "create", "payment", paymentId));
    await processQueue(stack);
    expect(stack.provider.calls.filter((c) => c.startsWith("createPayment")).length).toBe(1);
    expect(stack.provider.directlyGetInvoice(externalId)!.invoice.status).toBe("partial");

    // Redelivered payment event (fresh dedupe key): link already exists -> skip.
    await stack.inbox.ingest({
      ...internalEvent(updated, "create", "payment", paymentId),
      dedupeKey: `internal:payment:${paymentId}:create:redelivery`,
    });
    await processQueue(stack);
    expect(stack.provider.calls.filter((c) => c.startsWith("createPayment")).length).toBe(1);
  });

  it("applies a provider payment internally and derives paid status", async () => {
    const stack = buildStack();
    const { invoice, externalId } = await syncedInvoice(stack);

    const external = await stack.provider.createPayment(
      {
        invoiceDocNumber: invoice.docNumber,
        amountCents: 10_000,
        method: "card",
        receivedAt: new Date().toISOString(),
        referenceCode: null,
      },
      externalId,
    );

    await stack.inbox.ingest(providerEvent(external.externalId, "create", "payment"));
    await processQueue(stack);

    const internalAfter = await stack.invoices.get(invoice.id);
    expect(internalAfter!.status).toBe("paid");
    expect(internalAfter!.balanceCents).toBe(0);

    // Echo/duplicate of the same provider payment: skipped via link.
    await stack.inbox.ingest(providerEvent(external.externalId, "create", "payment", "again"));
    await processQueue(stack);
    expect((await stack.invoices.get(invoice.id))!.payments).toHaveLength(1);
  });
});

describe("retries and partial failure", () => {
  it("retries transient failures with backoff until success", async () => {
    const stack = buildStack();
    const customerId = await createCustomer();
    const invoice = await createInvoice(stack, customerId);

    stack.provider.failNext({ kind: "transient" });
    stack.provider.failNext({ kind: "transient" });
    await stack.inbox.ingest(internalEvent(invoice, "create"));
    await processQueue(stack);

    expect(stack.provider.invoiceCount()).toBe(1);
    const processed = await stack.inbox.listByStatus("processed");
    expect(processed).toHaveLength(1);
    expect(processed[0]!.attempts).toBeGreaterThanOrEqual(2);
  });

  it("dead-letters permanent failures immediately", async () => {
    const stack = buildStack();
    const customerId = await createCustomer();
    const invoice = await createInvoice(stack, customerId);

    stack.provider.failNext({ kind: "permanent" });
    await stack.inbox.ingest(internalEvent(invoice, "create"));
    await processQueue(stack);

    const dead = await stack.inbox.listByStatus("dead");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.attempts).toBe(1);
  });

  it("reclaims events whose worker died mid-processing (expired lease)", async () => {
    const stack = buildStack();
    const customerId = await createCustomer();
    const invoice = await createInvoice(stack, customerId);
    await stack.inbox.ingest(internalEvent(invoice, "create"));

    // Worker A claims with a tiny lease and "crashes" (never finishes).
    const claimed = await stack.inbox.claimNext(10);
    expect(claimed).not.toBeNull();
    // Immediately after, the event is locked.
    expect(await stack.inbox.claimNext(10)).toBeNull();

    // After the lease expires, another worker can reclaim it.
    await new Promise((r) => setTimeout(r, 30));
    const reclaimed = await stack.inbox.claimNext(60_000);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(claimed!.id);
    expect(reclaimed!.attempts).toBe(2);
  });
});
