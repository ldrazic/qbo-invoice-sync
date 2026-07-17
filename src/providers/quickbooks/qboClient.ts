import type { QboConfig } from "../../config.js";
import type { QboAuth } from "./qboAuth.js";
import {
  AmbiguousWriteError,
  PermanentProviderError,
  StaleVersionError,
  TransientProviderError,
} from "../errors.js";

const BASE_URLS = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
} as const;

const REQUEST_TIMEOUT_MS = 20_000;
// QBO allows ~500 req/min per realm; stay under it.
const RATE_LIMIT_PER_MINUTE = 450;

/**
 * Thin QBO REST client: auth header injection, 401-refresh-retry, rate
 * limiting, timeout handling, and mapping of QBO fault codes onto our typed
 * errors. Retries themselves belong to the worker, not this layer — except
 * the single 401 retry, which is a token refresh, not a real retry.
 */
export class QboClient {
  private requestTimestamps: number[] = [];

  constructor(
    private readonly config: QboConfig,
    private readonly auth: QboAuth,
  ) {}

  async get(path: string): Promise<Record<string, unknown> | null> {
    return this.request("GET", path, undefined, { isWrite: false });
  }

  async query(queryString: string): Promise<Record<string, unknown>> {
    const q = encodeURIComponent(queryString);
    const result = await this.request("GET", `/query?query=${q}`, undefined, { isWrite: false });
    return (result?.QueryResponse ?? {}) as Record<string, unknown>;
  }

  async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const result = await this.request("POST", path, body, { isWrite: true });
    if (result === null) {
      throw new PermanentProviderError(`QBO POST ${path} returned an unexpected empty result`);
    }
    return result;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    opts: { isWrite: boolean; isRetryAfter401?: boolean },
  ): Promise<Record<string, unknown> | null> {
    await this.rateLimit();
    const realmId = await this.auth.getRealmId();
    const token = await this.auth.getAccessToken();
    const url = `${BASE_URLS[this.config.environment]}/v3/company/${realmId}${path}${
      path.includes("?") ? "&" : "?"
    }minorversion=75`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout or network failure. For writes the request may have been
      // applied remotely — signal ambiguity so the pipeline recovers via
      // lookup-before-retry instead of blind re-create.
      if (opts.isWrite) {
        throw new AmbiguousWriteError(`QBO ${method} ${path} failed after send: ${String(err)}`, err);
      }
      throw new TransientProviderError(`QBO ${method} ${path} network failure: ${String(err)}`, err);
    }

    if (res.ok) {
      return (await res.json()) as Record<string, unknown>;
    }

    const text = await res.text();

    if (res.status === 401 && !opts.isRetryAfter401) {
      await this.auth.forceRefresh();
      return this.request(method, path, body, { ...opts, isRetryAfter401: true });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TransientProviderError(`QBO ${res.status} on ${method} ${path}: ${text}`);
    }

    const fault = parseFaultCodes(text);
    // 5010: stale object (SyncToken mismatch) -> optimistic-lock conflict.
    if (fault.includes("5010")) {
      throw new StaleVersionError(`QBO stale SyncToken on ${method} ${path}`);
    }
    // 610: object not found (e.g. hard-deleted invoice).
    if (fault.includes("610")) {
      return null;
    }
    throw new PermanentProviderError(`QBO ${res.status} on ${method} ${path}: ${text}`);
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 60_000);
    if (this.requestTimestamps.length >= RATE_LIMIT_PER_MINUTE) {
      const oldest = this.requestTimestamps[0]!;
      const waitMs = 60_000 - (now - oldest) + 50;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.requestTimestamps.push(Date.now());
  }
}

function parseFaultCodes(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as {
      Fault?: { Error?: Array<{ code?: string }> };
      fault?: { error?: Array<{ code?: string }> };
    };
    const errors = parsed.Fault?.Error ?? parsed.fault?.error ?? [];
    return errors.map((e) => e.code ?? "").filter(Boolean);
  } catch {
    return [];
  }
}
