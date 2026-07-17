import pg from "pg";
import { sql, type Kysely } from "kysely";
import { migrate } from "../../src/models/db/migrate.js";
import { createDb } from "../../src/models/db/pool.js";
import type { Database } from "../../src/models/db/schema.js";

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://sync:sync@localhost:5433/invoice_sync";
const TEST_DB_NAME = "invoice_sync_test";
const TEST_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://sync:sync@localhost:5433/${TEST_DB_NAME}`;

let prepared = false;

/** Create (once) and migrate the dedicated test database. */
export async function setupTestDb(): Promise<Kysely<Database>> {
  if (!prepared) {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      TEST_DB_NAME,
    ]);
    if (exists.rows.length === 0) {
      await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    }
    await admin.end();
    await migrate(TEST_URL);
    prepared = true;
  }
  return createDb(TEST_URL);
}

export async function truncateAll(db: Kysely<Database>): Promise<void> {
  await sql`TRUNCATE customers, invoices, invoice_lines, payments, entity_links,
            inbound_events, audit_log, provider_tokens, item_mappings
            RESTART IDENTITY CASCADE`.execute(db);
}
