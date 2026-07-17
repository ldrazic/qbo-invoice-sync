import { randomUUID } from "node:crypto";
import type {
  AccountingProvider,
  ExternalInvoiceState,
  ExternalPaymentState,
  ProviderWebhookEvent,
} from "../accountingProvider.js";
import type { CanonicalInvoice, CanonicalPayment } from "../../models/invoice.js";
import {
  AmbiguousWriteError,
  PermanentProviderError,
  StaleVersionError,
  TransientProviderError,
} from "../errors.js";

interface StoredInvoice {
  externalId: string;
  syncToken: number;
  invoice: CanonicalInvoice;
}

interface StoredPayment {
  externalId: string;
  syncToken: number;
  payment: CanonicalPayment;
}

export type FailureMode =
  | { kind: "transient" }
  | { kind: "permanent" }
  /** The write IS applied remotely, then the call throws AmbiguousWriteError
   *  — simulates a timeout after the provider committed the write. */
  | { kind: "timeout_after_write" };

/**
 * In-memory AccountingProvider used by tests and by ACCOUNTING_PROVIDER=fake.
 * Mirrors the QBO behaviors the pipeline depends on: incrementing SyncToken,
 * stale-token rejection, void semantics, and injectable failures.
 */
export class FakeProvider implements AccountingProvider {
  readonly name = "fake";

  private invoices = new Map<string, StoredInvoice>();
  private payments = new Map<string, StoredPayment>();
  private failures: FailureMode[] = [];
  readonly calls: string[] = [];

  /** Queue a failure for the next write call (FIFO). */
  failNext(mode: FailureMode): void {
    this.failures.push(mode);
  }

  private maybeFail(op: string, applyWrite?: () => void): void {
    const mode = this.failures.shift();
    if (!mode) {
      applyWrite?.();
      return;
    }
    switch (mode.kind) {
      case "transient":
        throw new TransientProviderError(`${op}: injected transient failure`);
      case "permanent":
        throw new PermanentProviderError(`${op}: injected permanent failure`);
      case "timeout_after_write":
        applyWrite?.();
        throw new AmbiguousWriteError(`${op}: injected timeout after write`);
    }
  }

  // --- test helpers ---

  /** Direct mutation, as if a user edited in the external UI. */
  directlySetInvoice(externalId: string, invoice: CanonicalInvoice): void {
    const existing = this.invoices.get(externalId);
    this.invoices.set(externalId, {
      externalId,
      syncToken: (existing?.syncToken ?? 0) + 1,
      invoice,
    });
  }

  directlyGetInvoice(externalId: string): StoredInvoice | undefined {
    return this.invoices.get(externalId);
  }

  /** Hard delete, as QBO's ?operation=delete does. */
  directlyDeleteInvoice(externalId: string): void {
    this.invoices.delete(externalId);
  }

  invoiceCount(): number {
    return this.invoices.size;
  }

  // --- AccountingProvider ---

  async getInvoice(externalId: string): Promise<ExternalInvoiceState | null> {
    this.calls.push(`getInvoice:${externalId}`);
    const stored = this.invoices.get(externalId);
    if (!stored) return null;
    return {
      externalId,
      syncToken: String(stored.syncToken),
      invoice: structuredClone(stored.invoice),
    };
  }

  async findInvoiceByDocNumber(docNumber: string): Promise<ExternalInvoiceState | null> {
    this.calls.push(`findInvoiceByDocNumber:${docNumber}`);
    for (const stored of this.invoices.values()) {
      if (stored.invoice.docNumber === docNumber && stored.invoice.status !== "deleted") {
        return {
          externalId: stored.externalId,
          syncToken: String(stored.syncToken),
          invoice: structuredClone(stored.invoice),
        };
      }
    }
    return null;
  }

  async createInvoice(invoice: CanonicalInvoice): Promise<ExternalInvoiceState> {
    this.calls.push(`createInvoice:${invoice.docNumber}`);
    const externalId = randomUUID();
    this.maybeFail("createInvoice", () => {
      this.invoices.set(externalId, {
        externalId,
        syncToken: 0,
        invoice: structuredClone(invoice),
      });
    });
    return { externalId, syncToken: "0", invoice: structuredClone(invoice) };
  }

  async updateInvoice(
    externalId: string,
    syncToken: string,
    invoice: CanonicalInvoice,
  ): Promise<ExternalInvoiceState> {
    this.calls.push(`updateInvoice:${externalId}`);
    const stored = this.invoices.get(externalId);
    if (!stored) throw new PermanentProviderError(`updateInvoice: ${externalId} not found`);
    if (String(stored.syncToken) !== syncToken) {
      throw new StaleVersionError(
        `updateInvoice: stale sync token ${syncToken}, current ${stored.syncToken}`,
      );
    }
    this.maybeFail("updateInvoice", () => {
      stored.syncToken += 1;
      stored.invoice = structuredClone(invoice);
    });
    return {
      externalId,
      syncToken: String(stored.syncToken),
      invoice: structuredClone(stored.invoice),
    };
  }

  async voidInvoice(externalId: string, syncToken: string): Promise<ExternalInvoiceState> {
    this.calls.push(`voidInvoice:${externalId}`);
    const stored = this.invoices.get(externalId);
    if (!stored) throw new PermanentProviderError(`voidInvoice: ${externalId} not found`);
    if (String(stored.syncToken) !== syncToken) {
      throw new StaleVersionError(
        `voidInvoice: stale sync token ${syncToken}, current ${stored.syncToken}`,
      );
    }
    this.maybeFail("voidInvoice", () => {
      stored.syncToken += 1;
      stored.invoice = {
        ...stored.invoice,
        status: "voided",
        totalCents: 0,
        balanceCents: 0,
        lines: stored.invoice.lines.map((l) => ({ ...l, unitPriceCents: 0, amountCents: 0 })),
      };
    });
    return {
      externalId,
      syncToken: String(stored.syncToken),
      invoice: structuredClone(stored.invoice),
    };
  }

  async findPaymentByReference(referenceCode: string): Promise<ExternalPaymentState | null> {
    this.calls.push(`findPaymentByReference:${referenceCode}`);
    for (const stored of this.payments.values()) {
      if (stored.payment.referenceCode === referenceCode) {
        return {
          externalId: stored.externalId,
          syncToken: String(stored.syncToken),
          payment: structuredClone(stored.payment),
        };
      }
    }
    return null;
  }

  async getPayment(externalId: string): Promise<ExternalPaymentState | null> {
    this.calls.push(`getPayment:${externalId}`);
    const stored = this.payments.get(externalId);
    if (!stored) return null;
    return {
      externalId,
      syncToken: String(stored.syncToken),
      payment: structuredClone(stored.payment),
    };
  }

  async createPayment(
    payment: CanonicalPayment,
    invoiceExternalId: string,
  ): Promise<ExternalPaymentState> {
    this.calls.push(`createPayment:${invoiceExternalId}`);
    const externalId = randomUUID();
    this.maybeFail("createPayment", () => {
      this.payments.set(externalId, { externalId, syncToken: 0, payment: structuredClone(payment) });
      const invoice = this.invoices.get(invoiceExternalId);
      if (invoice) {
        const balance = invoice.invoice.balanceCents - payment.amountCents;
        invoice.invoice = {
          ...invoice.invoice,
          balanceCents: balance,
          status: balance <= 0 ? "paid" : "partial",
        };
        invoice.syncToken += 1;
      }
    });
    return { externalId, syncToken: "0", payment: structuredClone(payment) };
  }

  verifyWebhookSignature(): boolean {
    return true;
  }

  parseWebhook(rawBody: string): ProviderWebhookEvent[] {
    const parsed = JSON.parse(rawBody) as ProviderWebhookEvent[];
    return parsed;
  }
}
