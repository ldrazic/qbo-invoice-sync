# providers/ — the only place that knows external wire formats

The sync core depends exclusively on `AccountingProvider`
(`accountingProvider.ts`). Concrete adapters live in subfolders; only
`providerFactory.ts` knows which ones exist.

## Adding a new provider (e.g. Xero)

1. New folder `src/providers/<name>/` implementing `AccountingProvider`.
   Keep ALL wire-format knowledge (JSON shapes, auth, error codes) inside it
   — if another layer learns the provider's shapes, the factory is broken.
2. Map failures onto the typed errors in `errors.ts` at the client boundary:
   - `TransientProviderError` → network, 429, 5xx (worker retries w/ backoff)
   - `StaleVersionError` → optimistic-lock rejection (worker retries fast;
     the pipeline refetches and re-resolves)
   - `AmbiguousWriteError` → write MAY have applied (timeout after send);
     the pipeline recovers via lookup-before-create, never blind-retries
   - `PermanentProviderError` → validation/4xx → dead-letter
3. Money converts cents ↔ decimal strings ONLY inside the mapper
   (`centsToDecimalString` / `decimalStringToCents`).
4. Register in `providerFactory.ts` + add the config variant in
   `src/config.ts`.
5. `fake/fakeProvider.ts` is the reference implementation and the test
   double: it mirrors the behaviors the pipeline relies on (incrementing
   sync token, stale-token rejection, void semantics, injectable failures
   via `failNext`, `directly*` helpers to simulate edits made in the
   provider's UI). Extend it alongside any interface change.

## Contract subtleties (things the pipeline RELIES on)

- `findInvoiceByDocNumber` / `findPaymentByReference`: the ambiguous-write
  recovery path. Must search the shared business key.
- `getInvoice` returns `null` for hard-deleted records (QBO fault 610) —
  the pipeline models that as lifecycle `deleted`.
- Payments are returned with per-invoice `allocations` (QBO payment Line
  Amount + LinkedTxn). NEVER apply `TotalAmt` to a single invoice — QBO
  payments can span invoices, and QBO may reallocate amounts on its own
  (auto-applied customer credits are a real thing we hit in the sandbox).

## QBO adapter specifics

- OAuth: access token ~1h, refresh token ROTATES on every refresh —
  refreshes are serialized (`refreshInFlight`) and persisted via
  `ProviderTokenRepository`. 401 → single forceRefresh retry in the client.
- `SyncToken` must accompany every update/void; stale → fault code `5010`
  → `StaleVersionError`. Not-found → `610` → null.
- Invoice void detection is a heuristic (QBO has no voided flag on reads):
  zeroed totals + "Voided" in `PrivateNote`.
- Idempotency anchors: internal `docNumber` → QBO `DocNumber`;
  short payment reference → `PaymentRefNum` (~21 char limit).
- Webhook: HMAC-SHA256(base64) of the RAW body against
  `QBO_WEBHOOK_VERIFIER_TOKEN`, header `intuit-signature`,
  `timingSafeEqual`. Payloads carry no entity data — always refetch.
- Rate limit ~500 req/min/realm; client keeps a sliding window at 450.
