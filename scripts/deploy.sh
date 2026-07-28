#!/usr/bin/env bash
#
# Manual deploy helper for the demo VM (Docker + Caddy, see DEPLOY.md).
#
# The droplet IP and public host are NOT in this file: this repo is public, so
# they are read from a gitignored config file (.deploy.env) or from the real
# environment. See deploy.env.example.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${DEPLOY_CONFIG:-$REPO_ROOT/.deploy.env}"
EXAMPLE_FILE="deploy.env.example"

# Local mirror of the VM's .env, used by env:pull / env:push. Gitignored, and
# deliberately NOT the same file as the local dev .env so a pull can never
# destroy a working local setup.
ENV_MIRROR_DEFAULT="$REPO_ROOT/.env.vm"

# Values that may come from .deploy.env or from the environment.
CONFIG_VARS="DEPLOY_HOST DEPLOY_USER DEPLOY_PATH PUBLIC_HOST DEPLOY_COMPOSE_FILE DEPLOY_SSH_KEY DEPLOY_SSH_PORT"

if [ -t 2 ]; then
  C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_YELLOW=''; C_CYAN=''; C_BOLD=''; C_OFF=''
fi

log()  { printf '%s==>%s %s\n' "$C_CYAN" "$C_OFF" "$*" >&2; }
warn() { printf '%swarn:%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

usage() {
  cat >&2 <<EOF
${C_BOLD}deploy.sh${C_OFF} — manual deploy for the demo VM

Usage: scripts/deploy.sh <command> [options]

  push [--dry-run] [-y] [--no-build]   rsync the source to the VM, then rebuild
  deploy                               and restart the stack (alias of push)
  up                                   start the stack without rsync/rebuild
  restart [service] [-y]               restart containers, no rebuild
  status | ps                          container status + /health check
  health                               /health check against the public host
  logs [service] [-n N] [--no-follow]  tail container logs (default: all)
  seed [-y]                            run the demo seed inside the app container
  ssh [-- cmd ...]                     interactive shell (or one-off command)
  exec -- <cmd ...>                    run a command in the app container
  script <file.ts> [args ...]          run scripts/<file.ts> on the VM (tsx)
  env:pull [--file F]                  download the VM's .env to .env.vm
  env:push [--file F] [-y]             upload .env.vm to the VM (diff + backup)
  prune [-y]                           remove dangling images on the VM
  check                                verify ssh / app dir / docker / .env
  config                               print the resolved target (no secrets)

Config: $CONFIG_FILE (gitignored) or environment variables.
        Copy $EXAMPLE_FILE and fill it in.
Set DEPLOY_YES=1 to answer every confirmation prompt with yes.
EOF
}

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

load_config() {
  # Real environment variables win over the config file, so a one-off
  # DEPLOY_HOST=... can target a different box without editing anything.
  local var preset
  for var in $CONFIG_VARS; do
    eval "__PRESET_$var=\"\${$var-}\""
  done

  if [ -f "$CONFIG_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$CONFIG_FILE"
    set +a
  fi

  for var in $CONFIG_VARS; do
    eval "preset=\"\${__PRESET_$var-}\""
    if [ -n "$preset" ]; then
      eval "$var=\"\$preset\""
    fi
  done

  DEPLOY_USER="${DEPLOY_USER:-root}"
  DEPLOY_PATH="${DEPLOY_PATH:-/opt/invoice-sync}"
  DEPLOY_COMPOSE_FILE="${DEPLOY_COMPOSE_FILE:-docker-compose.prod.yml}"
  DEPLOY_HOST="${DEPLOY_HOST:-}"
  PUBLIC_HOST="${PUBLIC_HOST:-}"
  DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
  DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-}"

  if [ -z "$DEPLOY_HOST" ]; then
    printf '%serror:%s DEPLOY_HOST is not set.\n' "$C_RED" "$C_OFF" >&2
    cat >&2 <<EOF

  This repo is public, so the droplet address is never committed. Create the
  gitignored config file:

      cp $EXAMPLE_FILE ${CONFIG_FILE#"$REPO_ROOT"/}
      \$EDITOR ${CONFIG_FILE#"$REPO_ROOT"/}      # set DEPLOY_HOST (droplet IP)

  or export it for a single run:

      DEPLOY_HOST=203.0.113.10 scripts/deploy.sh $CMD
EOF
    exit 1
  fi

  # sslip.io hostname convention from DEPLOY.md: 203.0.113.10 -> 203-0-113-10.sslip.io
  if [ -z "$PUBLIC_HOST" ]; then
    case "$DEPLOY_HOST" in
      *[!0-9.]*) ;;
      *.*.*.*) PUBLIC_HOST="${DEPLOY_HOST//./-}.sslip.io" ;;
    esac
  fi

  # A quoted "~/..." in the config file would not be tilde-expanded by the
  # shell, and ssh -i does not expand it either.
  # shellcheck disable=SC2088  # matching a literal leading "~/" is the point
  case "$DEPLOY_SSH_KEY" in
    "~/"*) DEPLOY_SSH_KEY="$HOME/${DEPLOY_SSH_KEY#\~/}" ;;
  esac

  # Connection multiplexing: a push runs preflight, rsync and several compose
  # commands, and each one would otherwise prompt for the key passphrase
  # separately. The first connection opens a master socket the rest reuse, so
  # the passphrase is asked once and the socket closes itself after 5 minutes.
  local cm_opts="-o ControlMaster=auto -o ControlPath=$HOME/.ssh/.deploy-cm-%r@%h:%p -o ControlPersist=300"
  # shellcheck disable=SC2206  # deliberate word splitting of our own literal
  SSH_OPTS=(-o ConnectTimeout=10 $cm_opts)
  SSH_CMD="ssh -o ConnectTimeout=10 $cm_opts"
  if [ -n "$DEPLOY_SSH_KEY" ]; then
    [ -f "$DEPLOY_SSH_KEY" ] \
      || die "DEPLOY_SSH_KEY points at '$DEPLOY_SSH_KEY', which does not exist. Fix it in ${CONFIG_FILE#"$REPO_ROOT"/} or unset it to use your ~/.ssh/config."
    SSH_OPTS+=(-i "$DEPLOY_SSH_KEY")
    SSH_CMD="$SSH_CMD -i $(printf '%q' "$DEPLOY_SSH_KEY")"
  fi
  if [ -n "$DEPLOY_SSH_PORT" ]; then
    SSH_OPTS+=(-p "$DEPLOY_SSH_PORT")
    SSH_CMD="$SSH_CMD -p $(printf '%q' "$DEPLOY_SSH_PORT")"
  fi
  SSH_TARGET="$DEPLOY_USER@$DEPLOY_HOST"
}

# Re-quote a command given as separate words so it survives the ssh shell.
quote_args() {
  local out="" arg
  for arg in "$@"; do
    out="$out $(printf '%q' "$arg")"
  done
  printf '%s' "${out# }"
}

banner() {
  printf '%s---------------------------------------------%s\n' "$C_BOLD" "$C_OFF" >&2
  printf '%s  target %s : %s%s\n' "$C_BOLD" "$SSH_TARGET" "$DEPLOY_PATH" "$C_OFF" >&2
  printf '%s  compose %s%s\n' "$C_BOLD" "$DEPLOY_COMPOSE_FILE" "$C_OFF" >&2
  [ -n "$DEPLOY_SSH_KEY" ] && printf '%s  key     %s%s\n' "$C_BOLD" "$DEPLOY_SSH_KEY" "$C_OFF" >&2
  [ -n "$PUBLIC_HOST" ] && printf '%s  public  https://%s%s\n' "$C_BOLD" "$PUBLIC_HOST" "$C_OFF" >&2
  printf '%s---------------------------------------------%s\n' "$C_BOLD" "$C_OFF" >&2
}

# Fails loudly and specifically: nobody wants to debug an opaque ssh error
# minutes before a demo.
preflight() {
  log "preflight: ssh $SSH_TARGET"
  if ! remote 'echo ok' >/dev/null 2>&1; then
    printf '%serror:%s cannot ssh to %s\n' "$C_RED" "$C_OFF" "$SSH_TARGET" >&2
    cat >&2 <<EOF

  Things to check, in order:
    1. ssh ${DEPLOY_SSH_KEY:+-i $DEPLOY_SSH_KEY }$SSH_TARGET      # does this work by hand?
    2. "Permission denied (publickey)" -> set DEPLOY_SSH_KEY in
       ${CONFIG_FILE#"$REPO_ROOT"/} to the droplet's private key, or add a
       Host entry to ~/.ssh/config.
    3. Timeout -> wrong DEPLOY_HOST, or port 22 is closed in the firewall.

  Current target: $SSH_TARGET (from ${CONFIG_FILE#"$REPO_ROOT"/} / environment)
EOF
    exit 1
  fi

  remote "test -d $(printf '%q' "$DEPLOY_PATH")" \
    || die "$DEPLOY_PATH does not exist on $SSH_TARGET. Create it first: scripts/deploy.sh ssh -- mkdir -p $DEPLOY_PATH (see DEPLOY.md step 1)."

  remote "command -v docker >/dev/null && docker compose version >/dev/null" \
    || die "docker compose is not available on $SSH_TARGET (see DEPLOY.md step 1)."

  # Caddy interpolates PUBLIC_HOST from .env and refuses to start without it;
  # the deploy never ships a .env, so a missing one means a broken stack.
  if ! remote "test -f $(printf '%q' "$DEPLOY_PATH/.env")" 2>/dev/null; then
    warn "$DEPLOY_PATH/.env is missing on the VM — the stack will not start."
    warn "Create it there (DEPLOY.md step 3) or push one: scripts/deploy.sh env:push --file <local .env>"
  fi
}

confirm() {
  local prompt="$1" reply
  if [ "${ASSUME_YES:-0}" = "1" ] || [ "${DEPLOY_YES:-0}" = "1" ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    die "$prompt — refusing without a terminal; re-run with -y if you are sure."
  fi
  printf '%s%s%s [y/N] ' "$C_YELLOW" "$prompt" "$C_OFF" >&2
  read -r reply
  case "$reply" in
    y | Y | yes | YES) return 0 ;;
    *) log "aborted"; exit 1 ;;
  esac
}

# --------------------------------------------------------------------------
# Remote helpers
# --------------------------------------------------------------------------

# The command string is deliberately assembled here and expanded by the remote
# shell; paths that vary are passed through printf %q by the callers.
# shellcheck disable=SC2029
remote() {
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SSH_TARGET" "$1"
}

remote_tty() {
  ssh -t ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SSH_TARGET" "$1"
}

# docker compose invocation, already cd'd into the app directory.
compose_cmd() {
  printf "cd %q && docker compose -f %q" "$DEPLOY_PATH" "$DEPLOY_COMPOSE_FILE"
}

compose() { remote "$(compose_cmd) $1"; }
compose_tty() { remote_tty "$(compose_cmd) $1"; }

health() {
  [ -n "$PUBLIC_HOST" ] || die "PUBLIC_HOST is not set and could not be derived from DEPLOY_HOST."
  local url="https://$PUBLIC_HOST/health" body
  if body="$(curl -fsS --max-time 15 "$url" 2>&1)"; then
    log "health $url -> $body"
    return 0
  fi
  warn "health $url failed: $body"
  return 1
}

wait_health() {
  local attempts="${1:-20}" i=1
  [ -n "$PUBLIC_HOST" ] || { warn "no PUBLIC_HOST, skipping health check"; return 0; }
  log "waiting for https://$PUBLIC_HOST/health ..."
  while [ "$i" -le "$attempts" ]; do
    if curl -fsS --max-time 10 "https://$PUBLIC_HOST/health" >/dev/null 2>&1; then
      health
      return 0
    fi
    sleep 3
    i=$((i + 1))
  done
  warn "still unhealthy after $((attempts * 3))s — check 'scripts/deploy.sh logs app'"
  return 1
}

# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

# Never shipped to the VM. `.env` and `.env.vm` are excluded so a deploy can
# never overwrite the VM's credentials (use env:push for that, deliberately).
rsync_excludes() {
  RSYNC_ARGS=(
    '--exclude=.git/'
    '--exclude=node_modules/'
    '--exclude=dist/'
    '--exclude=.env'
    '--exclude=.env.vm'
    '--exclude=.env.bak.*'
    '--exclude=.deploy.env'
    '--exclude=*.log'
    '--exclude=.DS_Store'
    '--exclude=.claude/'
    '--exclude=.vscode/'
    '--exclude=.idea/'
    # rsync --delete already spares excluded paths on the receiver; the
    # protect rules state that guarantee for the VM's credentials explicitly.
    '--filter=protect .env'
    '--filter=protect .env.bak.*'
  )
}

cmd_push() {
  local dry_run=0 build=1 arg
  for arg in "$@"; do
    case "$arg" in
      -n | --dry-run) dry_run=1 ;;
      -y | --yes) ASSUME_YES=1 ;;
      --no-build) build=0 ;;
      *) die "push: unknown option '$arg'" ;;
    esac
  done

  banner
  # A dry run runs the same preflight and the same rsync (with -n), so it is a
  # real rehearsal of the live push, not a different code path.
  if [ "$dry_run" = "1" ]; then
    log "DRY RUN — connects and lists changes, writes nothing to the VM"
  fi
  preflight
  if [ "$dry_run" != "1" ]; then
    confirm "Deploy $REPO_ROOT to $SSH_TARGET:$DEPLOY_PATH (rebuilds and restarts containers)?"
  fi

  rsync_excludes
  if [ "$dry_run" = "1" ]; then
    RSYNC_ARGS+=(-n -v)
  # macOS ships rsync 2.6.9 (openrsync), which predates --info=; only ask for
  # the summary when the local rsync is new enough to understand the flag.
  elif rsync --help 2>&1 | grep -q -- '--info='; then
    RSYNC_ARGS+=(--info=stats1)
  else
    RSYNC_ARGS+=(--stats)
  fi

  log "rsync -> $SSH_TARGET:$DEPLOY_PATH/"
  rsync -az --delete \
    -e "$SSH_CMD" \
    "${RSYNC_ARGS[@]}" \
    "$REPO_ROOT/" "$SSH_TARGET:$DEPLOY_PATH/" \
    || die "rsync to $SSH_TARGET:$DEPLOY_PATH failed — nothing was rebuilt. The VM's .env and Postgres volume are untouched."

  if [ "$dry_run" = "1" ]; then
    log "dry run finished — no files written, no containers touched"
    log "run the same command without --dry-run to deploy for real"
    return 0
  fi

  if [ "$build" = "1" ]; then
    log "docker compose up -d --build"
    compose "up -d --build" || die "build/start failed on $SSH_TARGET — inspect it with: scripts/deploy.sh logs"
  else
    log "docker compose up -d"
    compose "up -d" || die "start failed on $SSH_TARGET — inspect it with: scripts/deploy.sh logs"
  fi

  reload_caddy
  compose "ps"
  wait_health 20 || true
}

# deploy/Caddyfile is bind-mounted, so editing it changes no container spec and
# `up -d` leaves Caddy running the routes it booted with 10 days ago. Reload
# explicitly after every push; `caddy reload` is graceful and keeps the issued
# certificates, so a restart (and a fresh ACME round trip) is only the fallback.
reload_caddy() {
  log "caddy reload (picking up deploy/Caddyfile)"
  if ! compose "exec -T caddy caddy reload --config /etc/caddy/Caddyfile" >/dev/null 2>&1; then
    warn "caddy reload failed — falling back to restart"
    compose "restart caddy" || warn "caddy restart failed; check: scripts/deploy.sh logs caddy"
  fi
}

cmd_up() {
  banner
  compose "up -d"
  compose "ps"
  wait_health 20 || true
}

cmd_restart() {
  local service=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -y | --yes) ASSUME_YES=1; shift ;;
      -*) die "restart: unknown option '$1'" ;;
      *) service="$1"; shift ;;
    esac
  done
  banner
  if [ -n "$service" ]; then
    confirm "Restart '$service' on $SSH_TARGET?"
    compose "restart $(printf '%q' "$service")"
  else
    confirm "Restart all containers on $SSH_TARGET?"
    compose "restart"
  fi
  compose "ps"
  wait_health 20 || true
}

cmd_status() {
  banner
  compose "ps"
  health || true
}

cmd_logs() {
  local service="" tail="200" follow=1
  while [ $# -gt 0 ]; do
    case "$1" in
      -n | --tail) tail="${2:-200}"; shift 2 ;;
      --no-follow) follow=0; shift ;;
      -*) die "logs: unknown option '$1'" ;;
      *) service="$1"; shift ;;
    esac
  done
  banner
  local flags
  flags="--tail=$(printf '%q' "$tail")"
  [ "$follow" = "1" ] && flags="-f $flags"
  [ -n "$service" ] && flags="$flags $(printf '%q' "$service")"
  compose_tty "logs $flags"
}

cmd_seed() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -y | --yes) ASSUME_YES=1; shift ;;
      *) die "seed: unknown option '$1'" ;;
    esac
  done
  banner
  confirm "Run the demo seed inside the app container on $SSH_TARGET?"
  # -T: no TTY is allocated for a non-interactive ssh channel.
  compose "exec -T app node_modules/.bin/tsx src/models/db/seed.ts"
}

cmd_ssh() {
  banner
  if [ $# -eq 0 ]; then
    remote_tty "cd $(printf '%q' "$DEPLOY_PATH") && exec \$SHELL -l"
  else
    remote_tty "cd $(printf '%q' "$DEPLOY_PATH") && $(quote_args "$@")"
  fi
}

cmd_exec() {
  [ $# -gt 0 ] || die "exec: nothing to run (usage: exec -- <cmd ...>)"
  banner
  compose "exec -T app $(quote_args "$@")"
}

cmd_script() {
  [ $# -gt 0 ] || die "script: nothing to run (usage: script <file.ts> [args ...])"
  banner
  local file="$1"
  shift
  # The image copies only src/ (see Dockerfile), so scripts/ is absent from the
  # app container. rsync already put the deployed copy on the VM: mount that
  # into a one-off container, which also keeps ad-hoc diagnostics out of the
  # long-running service.
  compose "run --rm -v $(printf '%q' "$DEPLOY_PATH/scripts"):/app/scripts:ro app \
    node_modules/.bin/tsx $(quote_args "scripts/${file#scripts/}" "$@")"
}

cmd_env_pull() {
  local file="$ENV_MIRROR_DEFAULT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --file) file="${2:?--file needs a path}"; shift 2 ;;
      -y | --yes) ASSUME_YES=1; shift ;;
      *) die "env:pull: unknown option '$1'" ;;
    esac
  done

  banner
  local tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" EXIT
  remote "cat $(printf '%q' "$DEPLOY_PATH/.env")" > "$tmp" \
    || die "could not read $DEPLOY_PATH/.env on $SSH_TARGET"

  if [ -f "$file" ]; then
    if diff -q "$file" "$tmp" >/dev/null 2>&1; then
      log "$file already matches the VM's .env"
      return 0
    fi
    log "diff (local $file  ->  VM .env):"
    diff -u "$file" "$tmp" >&2 || true
    confirm "Overwrite local $file with the VM's .env?"
  fi

  cp "$tmp" "$file"
  chmod 600 "$file"
  log "wrote $file (gitignored)"
}

cmd_env_push() {
  local file="$ENV_MIRROR_DEFAULT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --file) file="${2:?--file needs a path}"; shift 2 ;;
      -y | --yes) ASSUME_YES=1; shift ;;
      *) die "env:push: unknown option '$1'" ;;
    esac
  done

  [ -f "$file" ] || die "env:push: $file not found — run 'scripts/deploy.sh env:pull' first."
  [ -s "$file" ] || die "env:push: $file is empty — refusing to overwrite the VM's credentials."
  grep -q '^PUBLIC_HOST=' "$file" \
    || warn "$file has no PUBLIC_HOST — Caddy needs it (docker-compose.prod.yml)."

  banner
  local tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" EXIT
  remote "cat $(printf '%q' "$DEPLOY_PATH/.env") 2>/dev/null || true" > "$tmp"

  if diff -q "$tmp" "$file" >/dev/null 2>&1; then
    log "VM .env already matches $file — nothing to do"
    return 0
  fi
  log "diff (VM .env  ->  local $file):"
  diff -u "$tmp" "$file" >&2 || true
  confirm "Overwrite $SSH_TARGET:$DEPLOY_PATH/.env with $file? (a timestamped backup is kept on the VM)"

  # Backup, then swap atomically — a half-written .env would break the whole
  # stack (Caddy refuses to start without PUBLIC_HOST).
  remote "set -e; cd $(printf '%q' "$DEPLOY_PATH"); \
    [ -f .env ] && cp .env \".env.bak.\$(date +%Y%m%d%H%M%S)\"; \
    cat > .env.incoming; chmod 600 .env.incoming; mv .env.incoming .env" < "$file"
  log "uploaded — restart the stack to pick it up: scripts/deploy.sh restart"
}

cmd_prune() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -y | --yes) ASSUME_YES=1; shift ;;
      *) die "prune: unknown option '$1'" ;;
    esac
  done
  banner
  confirm "Remove dangling Docker images on $SSH_TARGET? (volumes and .env are never touched)"
  remote "docker image prune -f"
  remote "df -h /"
}

cmd_check() {
  banner
  preflight
  log "preflight OK — ssh, $DEPLOY_PATH and docker compose all reachable"
  health || true
}

cmd_config() {
  banner
  printf 'config file : %s%s\n' "$CONFIG_FILE" "$([ -f "$CONFIG_FILE" ] && echo '' || echo ' (missing)')"
  printf 'DEPLOY_USER : %s\n' "$DEPLOY_USER"
  printf 'DEPLOY_HOST : %s\n' "$DEPLOY_HOST"
  printf 'DEPLOY_PATH : %s\n' "$DEPLOY_PATH"
  printf 'PUBLIC_HOST : %s\n' "${PUBLIC_HOST:-<unset>}"
  printf 'compose     : %s\n' "$DEPLOY_COMPOSE_FILE"
}

# --------------------------------------------------------------------------

CMD="${1:-help}"
[ $# -gt 0 ] && shift || true

case "$CMD" in
  help | -h | --help) usage; exit 0 ;;
esac

load_config

# `-- cmd ...` separators are only a readability aid for the caller.
case "$CMD" in
  ssh | exec | script)
    [ "${1:-}" = "--" ] && shift || true
    ;;
esac

case "$CMD" in
  push | deploy) cmd_push "$@" ;;
  up) cmd_up "$@" ;;
  restart) cmd_restart "$@" ;;
  status | ps) cmd_status "$@" ;;
  health) health ;;
  logs) cmd_logs "$@" ;;
  seed) cmd_seed "$@" ;;
  ssh) cmd_ssh "$@" ;;
  exec) cmd_exec "$@" ;;
  script) cmd_script "$@" ;;
  env:pull) cmd_env_pull "$@" ;;
  env:push) cmd_env_push "$@" ;;
  prune) cmd_prune "$@" ;;
  check) cmd_check "$@" ;;
  config) cmd_config "$@" ;;
  *) die "unknown command '$CMD' (run 'scripts/deploy.sh help')" ;;
esac
