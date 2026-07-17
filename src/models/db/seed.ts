import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config.js";
import { migrate } from "./migrate.js";
import { createDb } from "./pool.js";

/**
 * Demo seed: a sample customer for the internal system. Item mappings are
 * self-healing (looked up in QBO by name on first use), so the demo only
 * needs internal item codes that match QBO sandbox item names, e.g.
 * "Services" or "Hours".
 */
export async function seed(databaseUrl: string): Promise<void> {
  await migrate(databaseUrl);
  const db = createDb(databaseUrl);
  try {
    const existing = await db
      .selectFrom("customers")
      .select("id")
      .where("name", "=", "Acme Corp")
      .executeTakeFirst();
    if (!existing) {
      const customer = await db
        .insertInto("customers")
        .values({ name: "Acme Corp", email: "billing@acme.test" })
        .returningAll()
        .executeTakeFirstOrThrow();
      console.log(`created customer "Acme Corp" (${customer.id})`);
    } else {
      console.log(`customer "Acme Corp" already exists (${existing.id})`);
    }
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed(loadConfig().databaseUrl).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
