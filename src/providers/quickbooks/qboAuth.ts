import { randomBytes } from "node:crypto";
import type { QboConfig } from "../../config.js";
import type { ProviderTokenRepository, ProviderTokens } from "../../models/repositories/types.js";
import { PermanentProviderError, TransientProviderError } from "../errors.js";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

/**
 * OAuth2 for QBO, implemented against the token endpoint directly: access
 * tokens live ~1h, refresh tokens rotate on every refresh, and both are
 * persisted so a process restart does not lose the connection.
 */
export class QboAuth {
  private pendingStates = new Set<string>();
  private refreshInFlight: Promise<ProviderTokens> | null = null;

  constructor(
    private readonly config: QboConfig,
    private readonly tokens: ProviderTokenRepository,
  ) {}

  buildAuthorizeUrl(): string {
    const state = randomBytes(16).toString("hex");
    this.pendingStates.add(state);
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      redirect_uri: this.config.redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async handleCallback(code: string, realmId: string, state: string): Promise<void> {
    if (!this.pendingStates.delete(state)) {
      throw new PermanentProviderError("OAuth callback with unknown state (possible CSRF)");
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
    });
    const parsed = await this.tokenRequest(body);
    await this.saveTokens(parsed, realmId);
  }

  async getRealmId(): Promise<string> {
    const stored = await this.requireTokens();
    return stored.realmId;
  }

  /** Returns a valid access token, refreshing if it expires within 3 min. */
  async getAccessToken(): Promise<string> {
    const stored = await this.requireTokens();
    if (stored.accessTokenExpiresAt.getTime() - Date.now() > 3 * 60_000) {
      return stored.accessToken;
    }
    return (await this.refresh(stored)).accessToken;
  }

  /** Called by the HTTP client on an unexpected 401. */
  async forceRefresh(): Promise<string> {
    const stored = await this.requireTokens();
    return (await this.refresh(stored)).accessToken;
  }

  private async refresh(stored: ProviderTokens): Promise<ProviderTokens> {
    // Serialize concurrent refreshes: the refresh token rotates, so two
    // parallel refreshes would invalidate each other.
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        try {
          const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: stored.refreshToken,
          });
          const parsed = await this.tokenRequest(body);
          return await this.saveTokens(parsed, stored.realmId);
        } finally {
          this.refreshInFlight = null;
        }
      })();
    }
    return this.refreshInFlight;
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      "base64",
    );
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new TransientProviderError("QBO token endpoint unreachable", err);
    }
    if (!res.ok) {
      const text = await res.text();
      if (res.status >= 500) {
        throw new TransientProviderError(`QBO token endpoint ${res.status}: ${text}`);
      }
      throw new PermanentProviderError(`QBO token request rejected (${res.status}): ${text}`);
    }
    return (await res.json()) as TokenResponse;
  }

  private async saveTokens(parsed: TokenResponse, realmId: string): Promise<ProviderTokens> {
    const now = Date.now();
    const tokens: ProviderTokens = {
      provider: "quickbooks",
      realmId,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      accessTokenExpiresAt: new Date(now + parsed.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + parsed.x_refresh_token_expires_in * 1000),
    };
    await this.tokens.save(tokens);
    return tokens;
  }

  private async requireTokens(): Promise<ProviderTokens> {
    const stored = await this.tokens.get("quickbooks");
    if (!stored) {
      throw new PermanentProviderError(
        "QuickBooks is not connected: visit /qbo/connect to authorize",
      );
    }
    return stored;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}
