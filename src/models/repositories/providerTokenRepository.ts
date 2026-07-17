import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { ProviderTokenRepository, ProviderTokens } from "./types.js";

export class PgProviderTokenRepository implements ProviderTokenRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async get(provider: string): Promise<ProviderTokens | null> {
    const row = await this.db
      .selectFrom("provider_tokens")
      .selectAll()
      .where("provider", "=", provider)
      .executeTakeFirst();
    if (!row) return null;
    return {
      provider: row.provider,
      realmId: row.realm_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      accessTokenExpiresAt: row.access_token_expires_at,
      refreshTokenExpiresAt: row.refresh_token_expires_at,
    };
  }

  async save(tokens: ProviderTokens): Promise<void> {
    await this.db
      .insertInto("provider_tokens")
      .values({
        provider: tokens.provider,
        realm_id: tokens.realmId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        access_token_expires_at: tokens.accessTokenExpiresAt,
        refresh_token_expires_at: tokens.refreshTokenExpiresAt,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("provider").doUpdateSet({
          realm_id: tokens.realmId,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          access_token_expires_at: tokens.accessTokenExpiresAt,
          refresh_token_expires_at: tokens.refreshTokenExpiresAt,
          updated_at: new Date(),
        }),
      )
      .execute();
  }
}
