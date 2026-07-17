import type { CanonicalInvoice, CanonicalPayment } from "../models/invoice.js";

/**
 * Port for an external accounting system. The sync engine depends only on
 * this contract; QuickBooks is one implementation behind the factory.
 */

export interface ExternalInvoiceState {
  externalId: string;
  /** Provider optimistic-lock token (QBO SyncToken). */
  syncToken: string;
  /** Null when the invoice was hard-deleted on the provider. */
  invoice: CanonicalInvoice | null;
}

export interface ExternalPaymentState {
  externalId: string;
  syncToken: string;
  payment: CanonicalPayment | null;
}

export interface ProviderWebhookEvent {
  entityType: "invoice" | "payment";
  entityId: string;
  operation: "create" | "update" | "delete" | "void" | "emptied";
  occurredAt: string;
  /** Stable key for inbox dedupe of redelivered webhooks. */
  dedupeKey: string;
}

export interface AccountingProvider {
  readonly name: string;

  // --- invoices ---
  getInvoice(externalId: string): Promise<ExternalInvoiceState | null>;
  /**
   * Lookup by the shared business key. Used for initial reconciliation of
   * pre-existing unlinked records AND for recovery after an ambiguous write
   * (timeout after create): query before retrying, never blind-create.
   */
  findInvoiceByDocNumber(docNumber: string): Promise<ExternalInvoiceState | null>;
  createInvoice(invoice: CanonicalInvoice): Promise<ExternalInvoiceState>;
  updateInvoice(
    externalId: string,
    syncToken: string,
    invoice: CanonicalInvoice,
  ): Promise<ExternalInvoiceState>;
  /** Void keeps the record with zeroed amounts (preserves audit trail). */
  voidInvoice(externalId: string, syncToken: string): Promise<ExternalInvoiceState>;

  // --- payments ---
  getPayment(externalId: string): Promise<ExternalPaymentState | null>;
  /** Lookup by referenceCode; recovery path after an ambiguous payment write. */
  findPaymentByReference(referenceCode: string): Promise<ExternalPaymentState | null>;
  createPayment(
    payment: CanonicalPayment,
    invoiceExternalId: string,
  ): Promise<ExternalPaymentState>;

  // --- webhooks ---
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean;
  parseWebhook(rawBody: string): ProviderWebhookEvent[];
}
