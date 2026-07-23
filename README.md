# Two-Way Invoice Sync — Internal System ⇄ QuickBooks Online

A service that syncs invoices and payments bidirectionally between a (simulated
but real) internal invoicing system and QuickBooks Online, handling duplicate
events, out-of-order delivery, conflicting edits, and partial failures.

Design write-up with tradeoff reasoning: [DESIGN-WRITE-UP.md](DESIGN-WRITE-UP.md).

A live deployment with a small front-end is available for testing — the URL is
shared privately with the submission. Its "Schematic" tab explains
interactively how the connector works.

## Architecture at a glance

```
QBO webhook ──┐
              ├─► /webhooks/* ─► inbox (dedupe) ─► worker ─► refetch both sides
internal ─────┘                  (Postgres)         │        diff vs last synced
webhook                                             │        snapshot
                                                    ▼
                                     propagate one-sided changes /
                                     last-write-wins on conflict
                                     (optimistic locking on both sides)
```

- **Inbox pattern**: every change notification is persisted with a unique
  dedupe key before processing (`ON CONFLICT DO NOTHING` = duplicate webhooks
  are no-ops). The inbox doubles as a durable work queue
  (`FOR UPDATE SKIP LOCKED` + lease, so a crashed worker's events are
  reclaimed).
- **Queue as a port**: the sync engine depends only on the `EventQueue`
  contract (`src/queue/eventQueue.ts` — publish / claim / ack / retryLater /
  deadLetter); Postgres is one adapter (`pgEventQueue.ts`). Moving to Kafka or
  SQS means writing another adapter, not touching the worker or the
  ingestion endpoints.
- **Never trust the payload**: the pipeline always refetches current state
  from both systems (QBO webhooks don't include payloads anyway).
- **Conflict resolution: last write wins (LWW)**. The last successfully
  synced snapshot is the common ancestor used to detect *whether* each side
  changed. If only one side changed, that change propagates (not a conflict).
  If both sides changed — including void-vs-edit and edits with no prior
  linkage — the side with the most recent modification timestamp wins
  **wholesale** and the other side is overwritten; timestamp ties go to QBO
  (the accounting system of record). The overwritten state is preserved in
  the audit log (`conflict_lww` entries), so nothing is lost silently.

  Accepted trade-offs of LWW (explicit design decision): (1) concurrent edits
  to *different* fields are not merged — the older side's edit is overwritten
  along with everything else; (2) correctness depends on both systems'
  clocks (QBO's `MetaData.LastUpdatedTime` vs the internal `updated_at`);
  (3) the sync never blocks waiting for a human — there is no manual review
  queue for conflicts. In exchange, the system is always convergent and the
  policy is trivial to reason about.
- **Idempotent writes**: the internal `docNumber` is written to QBO's
  `DocNumber`, so a create that times out after being applied is recovered by
  lookup-before-retry instead of creating a duplicate. Payments carry a
  `PaymentRefNum` reference for the same purpose.
- **Optimistic locking both ways**: QBO's `SyncToken` and an internal
  `version` counter; a stale write is rejected, refetched and re-resolved.
- **Audit log**: every decision (applied / skipped echo / merged / flagged /
  failed) is recorded with its triggering event and diff detail.
- **Provider factory**: all QBO knowledge lives behind the
  `AccountingProvider` interface (`src/providers/`). Swapping providers means
  writing one adapter; the sync core does not change. `ACCOUNTING_PROVIDER=fake`
  runs the whole stack against an in-memory provider.

## Setup

Requirements: Node 20+, Docker.

```bash
cp .env.example .env        # fill in your QBO app credentials
docker compose up -d        # Postgres on localhost:5433
npm install
npm run dev                 # starts API + sync worker (migrations run on boot)
```

### Connecting QuickBooks (sandbox)

1. Create an app at <https://developer.intuit.com> (Accounting scope), copy the
   Development client id/secret into `.env`.
2. Add the redirect URI from `QBO_REDIRECT_URI` to the app's settings. For
   webhooks you need a public URL (e.g. `ngrok http 3000`); set the webhook
   endpoint to `<public-url>/webhooks/qbo` and copy the verifier token into
   `QBO_WEBHOOK_VERIFIER_TOKEN`.
3. Visit `http://localhost:3000/qbo/connect` and authorize your sandbox
   company. Tokens are persisted in Postgres and refreshed automatically.
4. `npm run seed` creates a demo customer.

## Tests

```bash
docker compose up -d   # tests run against a dedicated invoice_sync_test DB
npm test
```

30 tests cover the core edge cases: duplicate webhook delivery, out-of-order
events, echo suppression of our own writes, timeout-after-write recovery
without duplicates, LWW resolution in both directions (including wholesale
overwrite with audit of the losing state, void-vs-edit by recency, and
recreation of an externally hard-deleted invoice when the internal write is
newer), delete/void propagation, payment idempotency, retry with backoff,
permanent-failure dead-lettering, and crashed-worker lease recovery. The pipeline tests run against real Postgres (the queue semantics —
`ON CONFLICT`, `SKIP LOCKED`, leases — are exactly what's under test) with the
in-memory provider substituted through the factory.

## Assumptions

- **Single realm/tenant, single currency** (QBO sandbox default). Multi-realm
  would add a `realm_id` dimension to links and events.
- **Item/account mapping is a lookup table** (`item_mappings`), self-healing
  by item name on first use. A full chart-of-accounts sync is out of scope;
  line items reference QBO Items which carry the GL account mapping inside QBO.
- **Internal quantities are integers**; money is integer cents everywhere in
  the domain (decimal strings only at provider/API edges).
- **Internal "delete" maps to QBO Void**: hard-deleting records in the
  accounting system of record would destroy the audit trail. A QBO hard delete
  maps to internal `deleted`.
- **QBO void detection is heuristic** (zeroed totals + "Voided" private note):
  QBO's Invoice entity has no explicit voided flag on reads.
- **Payments are immutable** once recorded; syncing a payment means
  replicating it to the other side exactly once. Payment edits/voids in QBO
  are out of scope (flagged as future work).
- Payment status (`open/partial/paid`) is **derived from payments**, not
  synced as invoice state — the payments themselves sync as entities.
- API and worker run in **one process** for evaluator convenience; they share
  no in-memory state (everything goes through Postgres), so splitting them is
  a deployment change, not a code change.

## Known gaps / future work

- Reconciliation job (QBO Change Data Capture polling + internal scan) to
  catch lost webhooks and do initial backfill — designed for (the inbox
  accepts `source: reconciliation` events) but not yet implemented.
- Payment void/edit propagation.
- An opt-in guardrail on top of LWW for high-risk cases (e.g. financial edits
  on partially paid invoices) if pure LWW proves too aggressive in practice —
  the resolver is a single pure function, so the policy is easy to swap.
