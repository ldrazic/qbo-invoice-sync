# tests/ — how to test this repo

Vitest against REAL Postgres (`docker compose up -d` first). The queue
semantics (unique dedupe, `FOR UPDATE SKIP LOCKED`, leases, ON CONFLICT)
are exactly what's under test, so no DB mocks. Suite runs in ~4s; files run
serially (`fileParallelism: false`) because they share one database.

- `tests/helpers/testDb.ts`: creates + migrates the test DB automatically;
  every test starts from `truncateAll`. The DB name comes from
  `TEST_DATABASE_URL`, so parallel worktrees isolate with e.g.
  `TEST_DATABASE_URL=postgres://sync:sync@localhost:5433/invoice_sync_wt1 npm test`.
- `tests/syncPipeline.test.ts`: integration tests of the full pipeline with
  the real Postgres repos + `FakeProvider` injected through the factory
  seam. Reuse its helpers instead of reinventing:
  - `buildStack()` — full stack wiring
  - `syncedInvoice(stack)` — creates + fully syncs an invoice (returns
    internal invoice + externalId)
  - `internalEvent(...)` / `providerEvent(...)` — queue event builders
  - `processQueue(stack)` — drains including retry rounds
- `FakeProvider` simulates provider-side reality: `failNext({kind})` for
  transient/permanent/timeout-after-write, `directlySetInvoice` /
  `directlyDeleteInvoice` / `directlyAddPayment` to simulate "a user edited
  in the provider UI" (bumps sync tokens like QBO does).
- `tests/conflictResolver.test.ts`: pure unit tests — new resolution
  behavior belongs here, no DB needed.

## Pattern for a new feature test

1. `syncedInvoice(stack)` to get a linked baseline.
2. Mutate one/both sides (`stack.invoices.*` internally, `directly*` on the
   provider — set `sourceUpdatedAt` explicitly when LWW recency matters).
3. Publish the event(s) → `processQueue(stack)`.
4. Assert on: final state of BOTH sides, `stack.audit.list()` actions, and
   idempotency (republish with a fresh dedupe key → no double effects).

That fourth assertion is the house style: every behavior test also proves
its replay-safety.
