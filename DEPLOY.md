# Deploy on DigitalOcean (HTTPS without DNS)

The demo runs on any VM with Docker. HTTPS is solved **without a custom
domain** using [sslip.io](https://sslip.io): `<ip-with-dashes>.sslip.io`
resolves to the VM's IP, and Caddy issues/renews the Let's Encrypt
certificate automatically. Intuit requires HTTPS for the OAuth redirect and
for webhooks, so this replaces ngrok with a stable URL.

Example used below: droplet IP `137.184.10.20` → public host
`137-184-10-20.sslip.io`.

## 1. Prepare the droplet (once)

```bash
# as root on the droplet (Ubuntu)
apt update && apt install -y docker.io docker-compose-v2
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

(If you use DigitalOcean's firewall instead of ufw: open TCP 22/80/443.)

## 2. Upload the code

```bash
# from your machine
rsync -av --exclude node_modules --exclude .git --exclude .env \
  ./ root@137.184.10.20:/opt/invoice-sync/
```

## 3. Configure `.env` on the VM

`/opt/invoice-sync/.env` (the compose file overrides `DATABASE_URL`; what
matters here is QBO and `PUBLIC_HOST`). Set `PUBLIC_HOST` here — Caddy reads
it for the TLS hostname, so keeping it in `.env` avoids passing the wrong
value on the command line:

```
PORT=3000
ACCOUNTING_PROVIDER=quickbooks
# Your droplet IP with dashes + .sslip.io (this must be YOUR IP):
PUBLIC_HOST=137-184-10-20.sslip.io
QBO_CLIENT_ID=<your client id>
QBO_CLIENT_SECRET=<your client secret>
QBO_REDIRECT_URI=https://137-184-10-20.sslip.io/qbo/callback
QBO_WEBHOOK_VERIFIER_TOKEN=<verifier token from the portal>
QBO_ENVIRONMENT=sandbox
SYNC_POLL_INTERVAL_MS=1000
SYNC_MAX_ATTEMPTS=8
```

## 4. Bring it up

`PUBLIC_HOST` comes from `.env`, so do NOT pass it on the command line (a
wrong value there silently reconfigures Caddy for the wrong hostname and the
site stops responding):

```bash
cd /opt/invoice-sync
docker compose -f docker-compose.prod.yml up -d --build
```

Verify: `https://<your-host>.sslip.io/health` → `{"ok":true}` with a valid
certificate (the first request may take a few seconds while the cert is
issued).

## 5. Point Intuit at the new URL

On [developer.intuit.com](https://developer.intuit.com) → your app
(**Development** section):

1. **Keys & credentials → Redirect URIs**: add
   `https://137-184-10-20.sslip.io/qbo/callback`
2. **Webhooks → Endpoint URL**:
   `https://137-184-10-20.sslip.io/webhooks/qbo` (Invoice and Payment
   entities). If the portal regenerates the verifier token, update `.env` and
   `docker compose -f docker-compose.prod.yml restart app`.

## 6. Connect QuickBooks and seed

The VM's database starts empty (OAuth tokens live in Postgres), so authorize
again:

1. Visit `https://137-184-10-20.sslip.io/qbo/connect` and authorize the
   sandbox company → `{"connected":true,...}`.
2. Seed the demo customer:
   `docker compose -f docker-compose.prod.yml exec app node_modules/.bin/tsx src/models/db/seed.ts`

## Optional: protect the endpoints for the interview

The `/internal/*` and `/admin/*` endpoints are public. For the interview you
can enable basic auth by uncommenting the block in `deploy/Caddyfile`
(instructions for generating the hash are in the file) and running
`docker compose -f docker-compose.prod.yml restart caddy`. `/webhooks/*` and
`/qbo/*` must stay open: Intuit calls them (webhooks are HMAC-verified
anyway).

## Notes

- The URL is stable as long as the droplet's IP does not change (with a
  DigitalOcean Reserved IP it stays fixed even if the VM is recreated).
- Data persists in the `pgdata_prod` (Postgres) and `caddy_data`
  (certificates) volumes.
- Logs: `docker compose -f docker-compose.prod.yml logs -f app`
