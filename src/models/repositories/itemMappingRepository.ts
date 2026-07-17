import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { ItemMappingRepository } from "./types.js";

export class PgItemMappingRepository implements ItemMappingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async getExternalItemId(provider: string, itemCode: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("item_mappings")
      .select("external_item_id")
      .where("provider", "=", provider)
      .where("item_code", "=", itemCode)
      .executeTakeFirst();
    return row?.external_item_id ?? null;
  }

  async getItemCode(provider: string, externalItemId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("item_mappings")
      .select("item_code")
      .where("provider", "=", provider)
      .where("external_item_id", "=", externalItemId)
      .executeTakeFirst();
    return row?.item_code ?? null;
  }

  async upsert(
    provider: string,
    itemCode: string,
    externalItemId: string,
    externalName?: string,
  ): Promise<void> {
    await this.db
      .insertInto("item_mappings")
      .values({
        provider,
        item_code: itemCode,
        external_item_id: externalItemId,
        external_name: externalName ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["provider", "item_code"]).doUpdateSet({
          external_item_id: externalItemId,
          external_name: externalName ?? null,
        }),
      )
      .execute();
  }
}
