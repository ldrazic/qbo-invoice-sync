import type { CanonicalInvoice, CanonicalPayment, ComparableInvoice } from "../invoice.js";

/**
 * Repository contracts. The sync pipeline depends on these interfaces;
 * Postgres implementations live next to them, in-memory ones in tests.
 */

// --- entity links ---

export interface EntityLink {
  id: number;
  provider: string;
  entityType: string;
  internalId: string;
  externalId: string;
  externalSyncToken: string | null;
  internalVersion: number | null;
  lastSyncedHash: string | null;
  lastSyncedSnapshot: ComparableInvoice | null;
  lastSyncedAt: Date | null;
}

export interface MarkSyncedInput {
  externalSyncToken: string | null;
  internalVersion: number | null;
  hash: string;
  snapshot: ComparableInvoice;
}

export interface EntityLinkRepository {
  findByInternalId(provider: string, entityType: string, internalId: string): Promise<EntityLink | null>;
  findByExternalId(provider: string, entityType: string, externalId: string): Promise<EntityLink | null>;
  create(link: Omit<EntityLink, "id" | "lastSyncedAt"> & { lastSyncedAt?: Date }): Promise<EntityLink>;
  markSynced(id: number, input: MarkSyncedInput): Promise<void>;
  /** Re-point a link after recreating a hard-deleted external record. */
  updateExternalId(id: number, externalId: string): Promise<void>;
  /** All links, newest first — for observability / the console UI. */
  listAll(limit?: number): Promise<EntityLink[]>;
}

// --- audit ---

export type AuditAction =
  | "applied"
  | "skipped_echo"
  | "skipped_stale"
  | "skipped_duplicate"
  | "skipped_noop"
  | "conflict_lww"
  | "recovered_orphan_write"
  | "linked_existing"
  | "failed";

export interface AuditEntry {
  inboundEventId?: number | undefined;
  entityType: string;
  internalId?: string | undefined;
  externalId?: string | undefined;
  action: AuditAction;
  detail?: unknown;
}

export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
  list(limit?: number): Promise<Array<AuditEntry & { id: number; createdAt: Date }>>;
}

// --- provider tokens ---

export interface ProviderTokens {
  provider: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export interface ProviderTokenRepository {
  get(provider: string): Promise<ProviderTokens | null>;
  save(tokens: ProviderTokens): Promise<void>;
}

// --- item mappings ---

export interface ItemMappingRepository {
  getExternalItemId(provider: string, itemCode: string): Promise<string | null>;
  getItemCode(provider: string, externalItemId: string): Promise<string | null>;
  upsert(provider: string, itemCode: string, externalItemId: string, externalName?: string): Promise<void>;
}

// --- internal invoicing system ---

export interface InternalInvoice {
  id: string;
  docNumber: string;
  customerId: string;
  customerName: string;
  status: "open" | "partial" | "paid" | "voided" | "deleted";
  currency: string;
  notes: string | null;
  totalCents: number;
  balanceCents: number;
  version: number;
  updatedAt: Date;
  lines: Array<{
    lineNo: number;
    itemCode: string;
    description: string | null;
    quantity: number;
    unitPriceCents: number;
    amountCents: number;
  }>;
  payments: Array<{ id: string; amountCents: number; method: string; receivedAt: Date }>;
}

export interface InternalInvoiceInput {
  docNumber?: string | undefined;
  customerId: string;
  currency?: string | undefined;
  notes?: string | null | undefined;
  lines: Array<{
    itemCode: string;
    description?: string | null | undefined;
    quantity: number;
    unitPriceCents: number;
  }>;
}

export interface InvoiceChanges {
  customerId?: string | undefined;
  currency?: string | undefined;
  notes?: string | null | undefined;
  lines?: InternalInvoiceInput["lines"] | undefined;
}

export interface InternalInvoiceRepository {
  create(input: InternalInvoiceInput): Promise<InternalInvoice>;
  /** Full-replace update of mutable fields; bumps version. */
  update(id: string, changes: InvoiceChanges): Promise<InternalInvoice>;
  get(id: string): Promise<InternalInvoice | null>;
  getByDocNumber(docNumber: string): Promise<InternalInvoice | null>;
  list(limit?: number): Promise<InternalInvoice[]>;
  setLifecycle(id: string, status: "voided" | "deleted"): Promise<InternalInvoice>;
  addPayment(
    invoiceId: string,
    payment: { amountCents: number; method?: string | undefined; receivedAt?: Date | undefined },
  ): Promise<{ invoice: InternalInvoice; paymentId: string }>;
  getPayment(paymentId: string): Promise<{ invoiceId: string; amountCents: number; method: string; receivedAt: Date } | null>;
  toCanonical(invoice: InternalInvoice): CanonicalInvoice;
  /** Apply externally-sourced state (create or update), bumping version. */
  applyCanonical(invoice: CanonicalInvoice, existingId?: string): Promise<InternalInvoice>;
  /**
   * Apply one allocation of an external payment. Idempotent on externalRef
   * (unique index + ON CONFLICT DO NOTHING): a retry after a crash between
   * inserting the payment and recording the entity link converges instead of
   * double-applying. `created` is false when the row already existed.
   */
  applyExternalPayment(
    invoiceId: string,
    payment: { amountCents: number; method?: string | undefined; receivedAt?: Date | undefined },
    externalRef: string,
  ): Promise<{ invoice: InternalInvoice; paymentId: string; created: boolean }>;
}
