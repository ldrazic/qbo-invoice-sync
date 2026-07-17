try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on real environment variables.
}

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webhookVerifierToken: string;
  environment: "sandbox" | "production";
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  provider: "quickbooks" | "fake";
  qbo: QboConfig;
  syncPollIntervalMs: number;
  syncMaxAttempts: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = env.ACCOUNTING_PROVIDER === "fake" ? "fake" : "quickbooks";
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? "postgres://sync:sync@localhost:5433/invoice_sync",
    provider,
    qbo: {
      clientId: env.QBO_CLIENT_ID ?? "",
      clientSecret: env.QBO_CLIENT_SECRET ?? "",
      redirectUri: env.QBO_REDIRECT_URI ?? "http://localhost:3000/qbo/callback",
      webhookVerifierToken: env.QBO_WEBHOOK_VERIFIER_TOKEN ?? "",
      environment: env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox",
    },
    syncPollIntervalMs: Number(env.SYNC_POLL_INTERVAL_MS ?? 1000),
    syncMaxAttempts: Number(env.SYNC_MAX_ATTEMPTS ?? 8),
  };
}
