import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { Database } from "./schema.js";

// int8 (bigint) comes back as string by default; our amounts are integer
// cents well inside Number.MAX_SAFE_INTEGER, so parse to number.
pg.types.setTypeParser(20, (v) => Number(v));

export function createDb(databaseUrl: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
