-- Idempotent application of externally-sourced payments: each internal
-- payment row that mirrors a provider payment carries a unique external
-- reference, so a crash between "insert payment" and "create entity link"
-- converges on retry (INSERT ... ON CONFLICT DO NOTHING) instead of
-- inserting the payment twice. Internally-originated payments keep NULL.
-- Postgres treats NULLs as distinct in unique indexes, so internal payments
-- (external_ref NULL) are unaffected; and a full (non-partial) index is
-- required for the plain ON CONFLICT (external_ref) inference to work.
ALTER TABLE payments ADD COLUMN external_ref text;
CREATE UNIQUE INDEX payments_external_ref_key ON payments (external_ref);
