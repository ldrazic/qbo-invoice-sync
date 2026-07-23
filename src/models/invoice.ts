import { createHash } from "node:crypto";

export type InvoiceStatus = "open" | "partial" | "paid" | "voided" | "deleted";

export interface CanonicalLine {
  lineNo: number;
  itemCode: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface CanonicalInvoice {
  /** Business key shared by both systems; basis for linking and recovery. */
  docNumber: string;
  customerName: string;
  status: InvoiceStatus;
  currency: string;
  notes: string | null;
  lines: CanonicalLine[];
  totalCents: number;
  /** total - payments, as reported by the source system. */
  balanceCents: number;
  /** When the source system last modified this invoice (ISO-8601). */
  sourceUpdatedAt: string;
}

/** How much of a payment applies to one specific invoice. */
export interface PaymentAllocation {
  invoiceDocNumber: string;
  amountCents: number;
}

export interface CanonicalPayment {
  /** Total amount of the payment across all allocations. */
  amountCents: number;
  method: string | null;
  receivedAt: string;
  /**
   * Per-invoice split. QBO payments can cover several invoices; applying
   * TotalAmt to a single invoice would misstate every balance involved.
   */
  allocations: PaymentAllocation[];
  /**
   * Short reference written into the provider's payment record (QBO
   * PaymentRefNum). Enables lookup-before-retry after an ambiguous write,
   * since payment creates have no natural idempotency key.
   */
  referenceCode: string | null;
}

/** Provider-safe short reference derived from an internal payment id. */
export function paymentReferenceCode(internalPaymentId: string): string {
  return internalPaymentId.replace(/-/g, "").slice(0, 20);
}

/**
 * The subset of invoice state that is actually synchronized between systems,
 * used for hashing, echo detection, and change detection against the last
 * synced snapshot.
 *
 * Excluded on purpose:
 * - balanceCents and the open/partial/paid distinction: they derive from
 *   payments, which sync as their own entities. Only "voided"/"deleted" is a
 *   lifecycle fact of the invoice itself.
 * - sourceUpdatedAt: bookkeeping, not content.
 */
export interface ComparableInvoice {
  docNumber: string;
  customerName: string;
  lifecycle: "active" | "voided" | "deleted";
  currency: string;
  notes: string | null;
  totalCents: number;
  lines: CanonicalLine[];
}

export function toComparable(invoice: CanonicalInvoice): ComparableInvoice {
  return {
    docNumber: invoice.docNumber,
    customerName: invoice.customerName,
    lifecycle:
      invoice.status === "voided" ? "voided" : invoice.status === "deleted" ? "deleted" : "active",
    currency: invoice.currency,
    notes: invoice.notes,
    totalCents: invoice.totalCents,
    lines: [...invoice.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        itemCode: l.itemCode,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents,
      })),
  };
}

/**
 * Deterministic JSON: object keys sorted recursively. Also the only safe way
 * to COMPARE snapshots: jsonb round-trips through Postgres reorder object
 * keys, so plain JSON.stringify equality gives false negatives.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotHash(comparable: ComparableInvoice): string {
  return createHash("sha256").update(stableStringify(comparable)).digest("hex");
}
