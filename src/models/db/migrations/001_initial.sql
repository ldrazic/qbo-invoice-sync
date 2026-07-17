-- =========================================================================
-- Internal invoicing system (the challenge assumes it exists; we simulate a
-- deliberately small but real one: CRUD + webhook emission).
-- Money is stored as integer cents everywhere in the internal system.
-- =========================================================================

-- Human-readable invoice numbers: INV-1001, INV-1002, ...
CREATE SEQUENCE doc_number_seq START 1001;

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_number   text NOT NULL UNIQUE,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'partial', 'paid', 'voided', 'deleted')),
  currency     text NOT NULL DEFAULT 'USD',
  notes        text,
  total_cents  bigint NOT NULL DEFAULT 0,
  -- monotonically increasing per-record version, bumped on every edit;
  -- the internal-system analog of QBO's SyncToken
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoice_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no          integer NOT NULL,
  item_code        text NOT NULL,
  description      text,
  quantity         integer NOT NULL DEFAULT 1,
  unit_price_cents bigint NOT NULL,
  amount_cents     bigint NOT NULL,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES invoices(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method       text NOT NULL DEFAULT 'other',
  received_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- Sync engine
-- =========================================================================

-- Bidirectional linkage between internal entities and provider entities.
-- last_synced_snapshot is the canonical state as of the last successful sync:
-- the common ancestor used to detect which side(s) changed since last sync.
CREATE TABLE entity_links (
  id                   bigserial PRIMARY KEY,
  provider             text NOT NULL,
  entity_type          text NOT NULL CHECK (entity_type IN ('invoice', 'payment', 'customer', 'item')),
  internal_id          uuid NOT NULL,
  external_id          text NOT NULL,
  -- provider-side optimistic-lock token (QBO SyncToken) after our last write/read
  external_sync_token  text,
  -- internal-side version after our last write/read (same role as sync token)
  internal_version     integer,
  last_synced_hash     text,
  last_synced_snapshot jsonb,
  last_synced_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, entity_type, internal_id),
  UNIQUE (provider, entity_type, external_id)
);

-- Inbox + durable work queue. Every change notification from either side is
-- persisted here before processing; the unique dedupe_key makes duplicate
-- webhook delivery a no-op (ON CONFLICT DO NOTHING).
CREATE TABLE inbound_events (
  id              bigserial PRIMARY KEY,
  source          text NOT NULL,   -- 'internal' | 'quickbooks' | 'reconciliation'
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,   -- id in the source system
  operation       text NOT NULL,   -- 'create' | 'update' | 'delete' | 'void' | 'emptied'
  occurred_at     timestamptz NOT NULL,
  dedupe_key      text NOT NULL UNIQUE,
  payload         jsonb,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_flight', 'processed', 'skipped',
                                    'failed', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);

CREATE INDEX idx_inbound_events_queue
  ON inbound_events (next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- Append-only record of every decision the sync engine made.
CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  inbound_event_id bigint REFERENCES inbound_events(id),
  entity_type      text NOT NULL,
  internal_id      uuid,
  external_id      text,
  action           text NOT NULL,
  -- 'applied' | 'skipped_echo' | 'skipped_stale' | 'skipped_duplicate'
  -- | 'skipped_noop' | 'conflict_lww' | 'recovered_orphan_write'
  -- | 'linked_existing' | 'failed'
  detail           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, internal_id);

-- OAuth tokens for external providers (QBO access token lives 1h, refresh
-- token rotates; both must be persisted).
CREATE TABLE provider_tokens (
  provider                 text PRIMARY KEY,
  realm_id                 text NOT NULL,
  access_token             text NOT NULL,
  refresh_token            text NOT NULL,
  access_token_expires_at  timestamptz NOT NULL,
  refresh_token_expires_at timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Static mapping: internal item_code -> provider item reference.
-- A full chart-of-accounts sync is out of scope (documented decision); this
-- satisfies the GL/account mapping requirement with a seeded lookup table.
CREATE TABLE item_mappings (
  provider         text NOT NULL,
  item_code        text NOT NULL,
  external_item_id text NOT NULL,
  external_name    text,
  PRIMARY KEY (provider, item_code)
);
