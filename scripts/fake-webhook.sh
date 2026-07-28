#!/usr/bin/env bash
# Post a correctly-signed QuickBooks webhook at any URL, to exercise the
# switch (deploy/webhook-switch) without waiting for a real QBO event.
#
# The signature is an HMAC-SHA256 of the exact bytes sent, keyed with the
# verifier token — so this also proves the switch forwarded the body
# unmodified: if it re-serialized the JSON, the app answers 401.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
usage: scripts/fake-webhook.sh [--url URL] [--entity invoice|payment]
                               [--id ID] [--op Create|Update|Delete]

  --url     where to post (default: https://$PUBLIC_HOST/webhooks/qbo,
            PUBLIC_HOST read from .deploy.env)
  --entity  entity name in the payload         (default: invoice)
  --id      entity id                          (default: 1)
  --op      operation                          (default: Update)

The verifier token comes from $QBO_WEBHOOK_VERIFIER_TOKEN, else from
.env.vm, else from .env — it must match the VM's, or the app returns 401.
EOF
}

entity="invoice" id="1" op="Update" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) url="${2:?--url needs a value}"; shift 2 ;;
    --entity) entity="${2:?--entity needs a value}"; shift 2 ;;
    --id) id="${2:?--id needs a value}"; shift 2 ;;
    --op) op="${2:?--op needs a value}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

read_var() {
  # Last assignment wins, matching how a shell would source the file.
  [ -f "$2" ] || return 1
  grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"
}

token="${QBO_WEBHOOK_VERIFIER_TOKEN:-}"
[ -n "$token" ] || token="$(read_var QBO_WEBHOOK_VERIFIER_TOKEN "$REPO_ROOT/.env.vm" || true)"
[ -n "$token" ] || token="$(read_var QBO_WEBHOOK_VERIFIER_TOKEN "$REPO_ROOT/.env" || true)"
if [ -z "$token" ]; then
  echo "error: no QBO_WEBHOOK_VERIFIER_TOKEN found (env, .env.vm, or .env)." >&2
  echo "       run 'npm run deploy:env:pull' to fetch the VM's, or export it." >&2
  exit 1
fi

if [ -z "$url" ]; then
  host="$(read_var PUBLIC_HOST "$REPO_ROOT/.deploy.env" || true)"
  [ -n "$host" ] || { echo "error: no --url and no PUBLIC_HOST in .deploy.env" >&2; exit 1; }
  url="https://$host/webhooks/qbo"
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
printf '{"eventNotifications":[{"realmId":"0","dataChangeEvent":{"entities":[{"name":"%s","id":"%s","operation":"%s","lastUpdated":"%s"}]}}]}' \
  "$entity" "$id" "$op" "$(date -u +%Y-%m-%dT%H:%M:%S)" > "$body"

sig="$(openssl dgst -sha256 -hmac "$token" -binary < "$body" | openssl base64 -A)"

echo "==> POST $url"
echo "    $entity id=$id op=$op  ($(wc -c < "$body" | tr -d ' ') bytes)"
printf '    response: '
curl -sS -w '  [HTTP %{http_code}, %{time_total}s]\n' \
  -X POST "$url" \
  -H 'content-type: application/json' \
  -H "intuit-signature: $sig" \
  --data-binary @"$body"

cat <<'EOF'

  {"accepted":N,...}      the app received it with an intact signature
  {"error":"invalid ..."} the body was altered in transit, or the token differs
  502/504                 in forward mode: the tunnel is down
EOF
