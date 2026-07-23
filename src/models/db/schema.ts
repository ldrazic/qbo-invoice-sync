import type { ColumnType, Generated } from "kysely";

/** Kysely table definitions mirroring migrations/001_initial.sql. */

// jsonb: selects as parsed JSON, written as a JSON string (or null).
type Json = ColumnType<unknown, string | null, string | null>;

export interface CustomersTable {
  id: Generated<string>;
  name: string;
  email: string | null;
  created_at: Generated<Date>;
}

export interface InvoicesTable {
  id: Generated<string>;
  doc_number: string;
  customer_id: string;
  status: Generated<string>;
  currency: Generated<string>;
  notes: string | null;
  total_cents: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InvoiceLinesTable {
  id: Generated<string>;
  invoice_id: string;
  line_no: number;
  item_code: string;
  description: string | null;
  quantity: Generated<number>;
  unit_price_cents: number;
  amount_cents: number;
}

export interface PaymentsTable {
  id: Generated<string>;
  invoice_id: string;
  amount_cents: number;
  method: Generated<string>;
  received_at: Generated<Date>;
  created_at: Generated<Date>;
  /** Unique per provider payment (allocation); NULL for internal payments. */
  external_ref: string | null;
}

export interface EntityLinksTable {
  id: Generated<number>;
  provider: string;
  entity_type: string;
  internal_id: string;
  external_id: string;
  external_sync_token: string | null;
  internal_version: number | null;
  last_synced_hash: string | null;
  last_synced_snapshot: Json | null;
  last_synced_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InboundEventsTable {
  id: Generated<number>;
  source: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  occurred_at: Date;
  dedupe_key: string;
  payload: Json | null;
  status: Generated<string>;
  attempts: Generated<number>;
  next_attempt_at: Generated<Date>;
  locked_until: Date | null;
  last_error: string | null;
  received_at: Generated<Date>;
  processed_at: Date | null;
}

export interface AuditLogTable {
  id: Generated<number>;
  inbound_event_id: number | null;
  entity_type: string;
  internal_id: string | null;
  external_id: string | null;
  action: string;
  detail: Json | null;
  created_at: Generated<Date>;
}

export interface ProviderTokensTable {
  provider: string;
  realm_id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
  updated_at: Generated<Date>;
}

export interface ItemMappingsTable {
  provider: string;
  item_code: string;
  external_item_id: string;
  external_name: string | null;
}

export interface Database {
  customers: CustomersTable;
  invoices: InvoicesTable;
  invoice_lines: InvoiceLinesTable;
  payments: PaymentsTable;
  entity_links: EntityLinksTable;
  inbound_events: InboundEventsTable;
  audit_log: AuditLogTable;
  provider_tokens: ProviderTokensTable;
  item_mappings: ItemMappingsTable;
}
