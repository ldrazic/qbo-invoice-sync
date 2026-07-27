# CLAUDE.md — qbo-invoice-sync

Two-way invoice/payment sync between an internal invoicing system and
QuickBooks Online. TypeScript (strict, ESM), Fastify, Postgres (Kysely), zod.
Runtime is `tsx` — there is no build step; paths resolve relative to `src/`.

## Commands

```bash
docker compose up -d          # Postgres on localhost:5433 (required for tests)
npm run dev                   # API + sync worker, migrations run on boot
npm test                      # vitest, ~4s, needs Postgres up
npx tsc --noEmit              # typecheck (strict)
npm run seed                  # demo customer
```

**Definition of done for ANY change: `npx tsc --noEmit` clean AND `npm test`
green.** Never report a task complete without running both. New behavior
needs a test (see `tests/CLAUDE.md`).

## Architecture (60 seconds)

Event pipeline, idempotent end to end:

```
webhooks (internal + QBO) → EventQueue (Postgres: dedupe by unique key,
claim via FOR UPDATE SKIP LOCKED + lease) → SyncWorker → SyncService:
refetch BOTH sides → suppress echoes (snapshot hash) → resolve vs last
synced snapshot (last-write-wins) → apply under optimistic locking →
markSynced (new common ancestor) + audit_log entry
```

| Path | Role |
|---|---|
| `src/models/invoice.ts` | Canonical domain types, `stableStringify`, snapshot hash |
| `src/models/money.ts` | Integer cents ↔ decimal strings (edges only) |
| `src/models/repositories/` | Repo interfaces (`types.ts`) + Postgres impls |
| `src/models/db/migrations/` | Sequential SQL, applied in lexical order at boot |
| `src/queue/` | EventQueue interface + Postgres impl (inbox + work queue) |
| `src/services/syncService.ts` | Core pipeline — read `src/services/CLAUDE.md` first |
| `src/services/conflictResolver.ts` | Pure LWW resolution function |
| `src/workers/syncWorker.ts` | Claim loop, backoff, dead-letter |
| `src/providers/` | AccountingProvider port + QBO/fake adapters — read `src/providers/CLAUDE.md` |
| `src/controllers/` + `src/routes/` | Thin HTTP layer; zod at boundaries |
| `src/public/` | Console + Schematic UI (vanilla, served by the app) |

## Invariants — do not break these

1. **Money is integer cents** in the domain. Decimal strings only in
   `money.ts` conversions at provider/API edges. Never use JS floats.
2. **Never trust event payloads.** The pipeline always refetches current
   state from both systems before acting.
3. **Compare snapshots only with `stableStringify`/`snapshotHash`.**
   Postgres jsonb reorders object keys; plain `JSON.stringify` equality
   gives false diffs (this was a real bug).
4. **Every successful sync write must end in `links.markSynced(...)`** with
   the new hash/snapshot/tokens — echo suppression and LWW both depend on
   it. A write path that skips it makes webhooks bounce forever.
5. **Webhook HMAC verifies the RAW body.** `server.ts` captures `rawBody`
   in the content-type parser; don't replace it with a default JSON parser.
6. **Idempotency layers**: unique dedupe key at ingest; lookup-before-create
   by `DocNumber` (invoices) / `PaymentRefNum` (payments) before any create
   retry; optimistic locking (QBO `SyncToken`, internal `version`);
   external payments idempotent via unique `payments.external_ref`
   (`<provider>:payment:<externalId>:<invoiceDocNumber>`, NULL for
   internally-originated payments).
7. **Internal delete → provider VOID** (accounting audit trail is never
   hard-deleted). Provider hard-delete → internal `deleted` (soft).
8. **This repo is PUBLIC.** Never commit deployment URLs, IPs, realm ids,
   tokens, or anything from `.env` (gitignored). `.env.example` keeps
   placeholders only.

## Conventions

- Strict TS with `exactOptionalPropertyTypes`: optional params/fields that
  callers may pass as absent need explicit `| undefined`.
- Repos and providers are consumed through the interfaces in
  `src/models/repositories/types.ts` / `src/providers/accountingProvider.ts`
  — never import a concrete impl outside its wiring point (`src/index.ts`,
  `providerFactory.ts`).
- New migration = next `NNN_name.sql` in `src/models/db/migrations/` AND the
  mirrored change in `src/models/db/schema.ts`.
- `ON CONFLICT (col)` needs a FULL unique index (not partial) — Postgres
  can't infer partial ones (bit us with `payments.external_ref`).
- Comments explain constraints/policies, not what the code does.

## Parallel work (worktrees)

Each agent works in its own worktree/branch; integrator merges and runs the
gates. Every worktree needs its own `npm install`. Tests can run
concurrently across worktrees by giving each its own database:

```bash
TEST_DATABASE_URL=postgres://sync:sync@localhost:5433/invoice_sync_wt1 npm test
```

(`tests/helpers/testDb.ts` creates the database automatically from the URL.)
