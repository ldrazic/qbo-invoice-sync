# Design write-up

The README covers architecture and setup; this document explains the main
decisions and the tradeoffs behind them.

## Canonical model in the middle

Neither system's wire format leaks into the sync core. Both sides map into a
`CanonicalInvoice`, and conflict detection runs on a stricter subset,
`ComparableInvoice`, which contains only the fields that are actually
synchronized. Two deliberate exclusions:

- **Payment-derived status** (`open/partial/paid`) and `balanceCents` are not
  compared: they are a *consequence* of payments, which sync as their own
  entities. Comparing them would make every payment look like an invoice
  conflict. Only `voided`/`deleted` is a lifecycle fact of the invoice itself.
- **Timestamps** are bookkeeping, not content.

Money is integer cents everywhere inside the domain; decimal strings exist
only at the provider/API edges. JS floats never touch amounts (`0.1 + 0.2`
is not an accounting policy).

## Inbox pattern instead of processing webhooks inline

Every change notification (from either side) is persisted to `inbound_events`
with a unique `dedupe_key` before anything else happens; the HTTP handler acks
immediately. The same table doubles as the durable work queue
(`FOR UPDATE SKIP LOCKED` + lease). This one decision buys most of the
reliability story:

- duplicate webhook delivery → `ON CONFLICT DO NOTHING`, a no-op;
- webhook endpoint stays fast → no provider-side redelivery storms;
- a crashed worker's claimed events are reclaimed after the lease expires;
- retries, backoff, and dead-lettering are ordinary rows, inspectable and
  requeueable via `/admin`.

The queue itself is a port, not a Postgres commitment: the worker and the
ingestion endpoints depend on the `EventQueue` contract (publish / claim /
ack / retryLater / deadLetter in `src/queue/eventQueue.ts`), and the inbox
table is one adapter behind it. Swapping in a broker means writing another
adapter and mapping the semantics — publish-side dedupe onto an idempotent
producer or a consumer-side dedupe store, claim+lease onto consumer groups or
visibility timeouts, retry/dead-letter onto retry and DLQ topics. Postgres
was the right *first* adapter on purpose: at this scale it gives exactly-once
claiming, ordered delivery, delayed retries, and an inspectable dead-letter
queue for free, in a system that already runs Postgres.

## Never trust the payload

The pipeline treats an event only as a *hint that something changed* and
always refetches current state from both systems before acting. QBO webhooks
carry no payload anyway, but this also makes out-of-order and stale events
degrade into no-ops: by the time an old event is processed, refetched state
already reflects the newer edit and the diff is empty.

## Conflict resolution: snapshot-based three-way diff + LWW

Each link stores the state as of the last successful sync
(`last_synced_snapshot`) — a common ancestor. On every event:

1. Diff each side against the ancestor to learn *who* changed.
2. One side changed → propagate it. Not a conflict, no timestamps involved.
3. Both sides changed (or no ancestor exists) → **last write wins**,
   wholesale, by source modification timestamp; ties go to QBO as the
   accounting system of record. The losing state is written to the audit log
   (`conflict_lww`, `overwritten` field), so nothing is lost silently.

Alternatives considered:

- **Field-level merge** — rejected: invoice lines and totals are not
  independently mergeable (a merged invoice that nobody wrote is worse than a
  clearly-attributed overwrite), and QBO updates are full-replace anyway.
- **Manual review queue** — rejected for the core loop: it turns every clock
  skew into stuck sync. The resolver is one pure function
  (`conflictResolver.ts`), so bolting an "escalate instead of overwrite"
  policy onto high-risk cases (e.g. financial edits on partially paid
  invoices) is a small, isolated change — noted as future work.

Accepted costs, explicitly: concurrent edits to *different* fields lose the
older side's edit, and correctness depends on both systems' clocks.

## Idempotency in layers

One mechanism is never enough when writes can time out ambiguously:

1. **Inbox dedupe key** kills exact redeliveries.
2. **Echo suppression**: after we write to a system, the webhook that write
   generates hashes equal to `last_synced_hash` and is skipped — no
   ping-pong loops.
3. **Natural business keys on the provider**: `docNumber` → QBO `DocNumber`,
   internal payment id → QBO `PaymentRefNum`. A create that times out after
   the provider committed (`AmbiguousWriteError`) is recovered on retry by
   lookup-before-create instead of blind re-create. The same lookup links
   pre-existing records that live in both systems with no linkage row.
4. **Optimistic locking both ways** (QBO `SyncToken`, internal `version`):
   a concurrent edit during our write is rejected, refetched, re-resolved.

## Delete vs void

The two systems disagree about what "delete" means, so the policy is explicit:
internal delete/void both become QBO **Void** (hard-deleting in the accounting
system of record would destroy the audit trail); a QBO hard delete becomes
internal `deleted` (soft — internal rows are never physically deleted). If QBO
hard-deletes but the internal side has the *newer* edit, LWW recreates the
invoice in QBO and re-points the link.

QBO has no voided flag on invoice reads, so void detection is a documented
heuristic: zeroed totals plus the "Voided" private note QBO stamps.

## Failure taxonomy

Provider errors are typed at the client boundary and the worker only reacts to
types: `TransientProviderError` (network, 429, 5xx) → exponential backoff +
jitter; `StaleVersionError` → fast retry (refetch resolves it);
`AmbiguousWriteError` → retry through the lookup-before-create path;
`PermanentProviderError` (validation, 4xx) → dead-letter immediately, visible
and requeueable in `/admin/events?status=dead`.

## What I deliberately did not build

- **Reconciliation job** (QBO Change Data Capture + internal scan) to catch
  lost webhooks and do initial backfill. The inbox already accepts
  `source: reconciliation` events; the job itself is future work.
- **Payment edits/voids** — payments are modeled immutable; sync means
  replicate exactly once.
- **Full chart-of-accounts sync** — item mapping is a lookup table that
  self-heals by item name; GL account mapping lives on the QBO Item.
- **Multi-realm / multi-currency** — would add a `realm_id` dimension to
  links and events; out of scope for the sandbox.
