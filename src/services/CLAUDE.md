# services/ — the sync pipeline

`syncService.ts` processes one queue event at a time. Read this before
touching it; the invariants are load-bearing.

## Pipeline per event

1. Look up the entity link (by internal or external id, per event source).
2. **Refetch current state from BOTH sides** — event payloads are never
   trusted (QBO's don't even carry data).
3. **Echo suppression**: if the event-side state's `snapshotHash` equals
   `link.lastSyncedHash`, it's the echo of our own write (or a stale event)
   → skip. Without this, every sync write loops forever via webhooks.
4. `conflictResolver.resolve(...)` — pure function, last-write-wins:
   one-sided changes propagate; both-sided changes go to the newer
   `updatedAt` wholesale (ties → external, the accounting system of
   record); the losing state is returned as `overwritten` for the audit.
5. Apply: **external write first, then internal, then `markSynced`**.
   A crash between steps converges on reprocessing because the
   already-written side diffs as unchanged against the merged state.
   External writes use the freshly fetched `syncToken` (optimistic lock);
   stale → `StaleVersionError` → worker retries → refetch resolves.
6. Audit every decision (`applied`, `skipped_*`, `conflict_lww` with the
   overwritten state, `recovered_orphan_write`, `linked_existing`).

## Unlinked entities

- Internal invoice with no link → `findInvoiceByDocNumber` FIRST
  (recovers timed-out creates AND pre-existing records), only then create.
- External invoice with no link → match internal by docNumber → link
  (equal states) or LWW (diverged). Never blind-create a second record.

## Payments

- Immutable once applied (updates/voids of provider payments are a KNOWN
  GAP — if asked to implement: on a linked payment event, refetch, diff
  allocations vs internal rows by `external_ref` prefix
  `<provider>:payment:<externalId>:`, apply the delta, recompute status).
- External payments: resolve ALL allocation invoices before writing
  anything (missing one → throw → whole event retries); then apply each
  allocation via `applyExternalPayment` with external_ref
  `<provider>:payment:<externalId>:<docNumber>` — idempotent per
  allocation (unique index + ON CONFLICT), so a crash mid-loop converges.
- Internal payments: link-existence is the dedupe; lookup by
  `PaymentRefNum` before create (ambiguous-write recovery).

## Rules of thumb

- Any new outcome must write an audit entry — auditability is a feature.
- Any new "applied" path must end in `markSynced` (see root CLAUDE.md #4).
- Throwing = retry with backoff (worker); return `skip` for terminal
  no-ops; `PermanentProviderError` dead-letters.
- `conflictResolver` stays pure (no I/O) — that's why it has 9 unit tests.
