# Deploy on DigitalOcean (HTTPS without DNS)

The demo runs on any VM with Docker. HTTPS is solved **without a custom
domain** using [sslip.io](https://sslip.io): `<ip-with-dashes>.sslip.io`
resolves to the VM's IP, and Caddy issues/renews the Let's Encrypt
certificate automatically. Intuit requires HTTPS for the OAuth redirect and
for webhooks, so this replaces ngrok with a stable URL.

Example used below: droplet IP `137.184.10.20` → public host
`137-184-10-20.sslip.io`.

---

## Quick start (scripted)

`scripts/deploy.sh` wraps the manual steps below. The droplet address is never
committed — this repo is public — so it is read from a gitignored config file.

```bash
cp deploy.env.example .deploy.env
$EDITOR .deploy.env               # DEPLOY_HOST = your droplet IP

npm run deploy:dry                # rehearse: connects, lists what would change
npm run deploy                    # rsync + rebuild + restart + health check
```

`.deploy.env` (all values can be overridden by real environment variables):

| Variable | Required | Default / example |
|---|---|---|
| `DEPLOY_HOST` | yes | `137.184.10.20` (droplet IP) |
| `DEPLOY_USER` | no | `root` |
| `DEPLOY_PATH` | no | `/opt/invoice-sync` |
| `PUBLIC_HOST` | no | derived: `137-184-10-20.sslip.io` |
| `DEPLOY_SSH_KEY` | no | unset → use `~/.ssh/config`; e.g. `~/.ssh/id_droplet` |
| `DEPLOY_SSH_PORT` | no | `22` |
| `DEPLOY_COMPOSE_FILE` | no | `docker-compose.prod.yml` |

If ssh rejects your default key (`Permission denied (publickey)`), either set
`DEPLOY_SSH_KEY` or — cleaner — add a `Host` entry to `~/.ssh/config` and leave
the variable unset:

```
Host demo-droplet
  HostName 137.184.10.20
  User root
  IdentityFile ~/.ssh/id_droplet
```

then set `DEPLOY_HOST=demo-droplet` and `PUBLIC_HOST=137-184-10-20.sslip.io`
(the sslip.io host can no longer be derived from a name).

### Commands

Every command prints the exact host and path it is about to touch, and every
destructive one asks for confirmation (`-y`, or `DEPLOY_YES=1`, skips the
prompt).

| Command | npm alias | What it does |
|---|---|---|
| `push` / `deploy` | `npm run deploy` | rsync the source, then `up -d --build`, then wait for `/health` |
| `push --dry-run` | `npm run deploy:dry` | same preflight + same rsync with `-n`; writes nothing |
| `push --no-build` | — | rsync + `up -d` without rebuilding the image |
| `up` | — | start the stack (e.g. after a droplet reboot), no rsync/rebuild |
| `restart [service]` | `npm run deploy:restart` | `docker compose restart`, no rebuild |
| `status` / `ps` | `npm run deploy:status` | container status + `/health` |
| `health` | `npm run deploy:health` | `/health` against the public host |
| `logs [service] [-n N] [--no-follow]` | `npm run deploy:logs` | tail logs, all services by default |
| `seed` | `npm run deploy:seed` | step 6's seed, inside the app container |
| `ssh [-- cmd ...]` | `npm run deploy:ssh` | interactive shell in `DEPLOY_PATH` (or one command) |
| `exec -- <cmd ...>` | — | run a command in the app container |
| `env:pull` | `npm run deploy:env:pull` | download the VM's `.env` to `.env.vm` (gitignored) |
| `env:push` | `npm run deploy:env:push` | upload `.env.vm` to the VM, after a diff and a backup |
| `prune` | — | remove dangling images on the VM (frees disk; volumes untouched) |
| `check` | — | preflight only: ssh, app dir, docker compose, VM `.env` |
| `config` | — | print the resolved target |

Pass extra arguments through npm with `--`, e.g. `npm run deploy:logs -- app -n 50`.

### Safety properties

- The VM's `.env` is **excluded** from the rsync and additionally marked
  `protect`, so a deploy can never overwrite or delete the QBO credentials.
  Changing it is a separate, explicit `env:push` that diffs first and leaves a
  timestamped backup on the VM.
- `env:pull` writes to `.env.vm`, never to your local dev `.env`.
- Nothing in the script touches Docker volumes, so `pgdata_prod` (Postgres) and
  `caddy_data` (certificates) survive every command, `prune` included.
- `--dry-run` runs the real preflight and the real rsync (with `-n`): use it to
  validate config before the first live push.

---

The rest of this document is the underlying manual procedure — what the script
does and why. Follow it for the one-time droplet setup (steps 1, 3 and 5),
which the script does not automate.

## 1. Prepare the droplet (once)

```bash
# as root on the droplet (Ubuntu)
apt update && apt install -y docker.io docker-compose-v2
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

(If you use DigitalOcean's firewall instead of ufw: open TCP 22/80/443.)

## 2. Upload the code

`scripts/deploy.sh push` does this (plus step 4). By hand:

```bash
# from your machine
rsync -av --exclude node_modules --exclude .git --exclude .env \
  ./ root@137.184.10.20:/opt/invoice-sync/
```

`deploy/` must be included: `deploy/Caddyfile` and the webhook-switch service
are bind-mounted by `docker-compose.prod.yml`.

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

(`scripts/deploy.sh push` runs exactly this after the rsync, then polls
`/health`.)

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
2. Seed the demo customer — `npm run deploy:seed`, or on the VM:
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
- Logs: `npm run deploy:logs -- app`, or on the VM
  `docker compose -f docker-compose.prod.yml logs -f app`.
- If the droplet runs low on disk after several rebuilds:
  `scripts/deploy.sh prune` (dangling images only — volumes are never removed).
