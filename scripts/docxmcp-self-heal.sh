#!/usr/bin/env bash
set -Eeuo pipefail

# Self-heal docxmcp's per-user MCP runtime without touching opencode daemon/gateway.
# Scope:
#   - read /etc/opencode/mcp-apps.json first, then
#     ~/.config/opencode/mcp-apps.json, for the docxmcp app path/url
#   - ensure /run/user/$UID/opencode/sockets/docxmcp exists with mode 0700
#   - verify /healthz over the expected Unix socket
#   - optionally recreate only the docxmcp docker compose service when the socket
#     is missing/stale

APP_ID="docxmcp"
MODE="heal"
DOCXMCP_DIR=""
PROJECT_NAME="docxmcp-${USER:-$(id -un)}"
TIMEOUT_SECONDS=45

usage() {
  cat <<'EOF'
Usage: scripts/docxmcp-self-heal.sh [--check|--heal] [options]

Modes:
  --check                 Inspect registry, socket, compose and health only. No mutation.
  --heal                  Repair runtime socket dir and recreate docxmcp compose service if needed. Default.

Options:
  --app-id ID             MCP app id in mcp-apps.json. Default: docxmcp
  --docxmcp-dir PATH      Override docxmcp repo path instead of reading registry.
  --project-name NAME     Docker compose project name. Default: docxmcp-$USER
  --timeout SECONDS       Wait time for socket/health after compose up. Default: 45
  -h, --help              Show this help.

This script intentionally does NOT spawn, kill, or restart opencode daemon/gateway.
It only manages the external docxmcp Docker Compose service.
EOF
}

log() { printf '[docxmcp-self-heal] %s\n' "$*"; }
warn() { printf '[docxmcp-self-heal] WARN: %s\n' "$*" >&2; }
die() { printf '[docxmcp-self-heal] ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --heal) MODE="heal" ;;
    --app-id)
      [ "$#" -ge 2 ] || die "--app-id requires a value"
      APP_ID="$2"
      shift
      ;;
    --docxmcp-dir)
      [ "$#" -ge 2 ] || die "--docxmcp-dir requires a value"
      DOCXMCP_DIR="$2"
      shift
      ;;
    --project-name)
      [ "$#" -ge 2 ] || die "--project-name requires a value"
      PROJECT_NAME="$2"
      shift
      ;;
    --timeout)
      [ "$#" -ge 2 ] || die "--timeout requires a value"
      TIMEOUT_SECONDS="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

case "$MODE" in
  check|heal) ;;
  *) die "invalid mode: $MODE" ;;
esac

case "$TIMEOUT_SECONDS" in
  ''|*[!0-9]*) die "--timeout must be a positive integer" ;;
esac
[ "$TIMEOUT_SECONDS" -gt 0 ] || die "--timeout must be > 0"

UID_NUM="$(id -u)"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${UID_NUM}}"
SOCKET_DIR="${RUNTIME_DIR}/opencode/sockets/${APP_ID}"
SOCKET_PATH="${SOCKET_DIR}/${APP_ID}.sock"
SYSTEM_REGISTRY_PATH="/etc/opencode/mcp-apps.json"
USER_REGISTRY_PATH="${HOME}/.config/opencode/mcp-apps.json"
REGISTRY_PATH=""

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

need_cmd python3
need_cmd docker
need_cmd curl

read_registry_field() {
  local field="$1"
  python3 - "$SYSTEM_REGISTRY_PATH" "$USER_REGISTRY_PATH" "$APP_ID" "$field" <<'PY'
import json, sys
system_path, user_path, app_id, field = sys.argv[1:5]
app = {}
for path in (system_path, user_path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        continue
    candidate = data.get("apps", {}).get(app_id)
    if candidate:
        app = candidate
        break
value = app.get(field, "")
if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

resolve_registry_path() {
  python3 - "$SYSTEM_REGISTRY_PATH" "$USER_REGISTRY_PATH" "$APP_ID" <<'PY'
import json, sys
system_path, user_path, app_id = sys.argv[1:4]
for path in (system_path, user_path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        continue
    if data.get("apps", {}).get(app_id):
        print(path)
        raise SystemExit(0)
print("")
PY
}

REGISTRY_PATH="$(resolve_registry_path)"
REG_PATH="$(read_registry_field path)"
REG_URL="$(read_registry_field url)"
REG_ENABLED="$(read_registry_field enabled)"
REG_TRANSPORT="$(read_registry_field transport)"

if [ -z "$DOCXMCP_DIR" ]; then
  [ -n "$REG_PATH" ] || die "${APP_ID} not found in ${SYSTEM_REGISTRY_PATH} or ${USER_REGISTRY_PATH}; pass --docxmcp-dir PATH if this is intentional"
  DOCXMCP_DIR="$REG_PATH"
fi

[ -d "$DOCXMCP_DIR" ] || die "docxmcp directory does not exist: ${DOCXMCP_DIR}"
[ -f "${DOCXMCP_DIR}/docker-compose.yml" ] || die "docker-compose.yml not found in ${DOCXMCP_DIR}"

EXPECTED_URL="unix://${SOCKET_PATH}:/mcp"
if [ -n "$REG_URL" ] && [ "$REG_URL" != "$EXPECTED_URL" ]; then
  warn "registry url differs from current runtime expectation"
  warn "registry: ${REG_URL}"
  warn "expected: ${EXPECTED_URL}"
fi

if [ -n "$REG_TRANSPORT" ] && [ "$REG_TRANSPORT" != "streamable-http" ]; then
  warn "registry transport is ${REG_TRANSPORT}, expected streamable-http"
fi

if [ "$REG_ENABLED" = "false" ]; then
  warn "registry marks ${APP_ID} disabled; socket can be healthy but opencode will not load it"
fi

healthcheck() {
  [ -S "$SOCKET_PATH" ] || return 1
  curl --silent --show-error --fail --max-time 5 \
    --unix-socket "$SOCKET_PATH" \
    "http://docxmcp.local/healthz" >/dev/null
}

compose_ps() {
  docker compose -p "$PROJECT_NAME" ps
}

print_state() {
  log "mode=${MODE}"
  log "registry=${REGISTRY_PATH}"
  log "app_id=${APP_ID} enabled=${REG_ENABLED:-unknown} transport=${REG_TRANSPORT:-unknown}"
  log "docxmcp_dir=${DOCXMCP_DIR}"
  log "compose_project=${PROJECT_NAME}"
  log "socket_dir=${SOCKET_DIR}"
  log "socket_path=${SOCKET_PATH}"
  if [ -d "$SOCKET_DIR" ]; then
    log "socket_dir_status=exists"
  else
    log "socket_dir_status=missing"
  fi
  if [ -S "$SOCKET_PATH" ]; then
    log "socket_status=exists"
  else
    log "socket_status=missing"
  fi
}

print_state

if healthcheck; then
  log "health=ok"
  exit 0
fi

if [ "$MODE" = "check" ]; then
  warn "health=failed"
  warn "run with --heal to recreate the docxmcp compose service if needed"
  exit 2
fi

log "health=failed; starting self-heal"

if [ ! -d "$SOCKET_DIR" ]; then
  log "creating socket directory"
  mkdir -p "$SOCKET_DIR"
fi
chmod 700 "$SOCKET_DIR"

log "current compose status:"
(
  cd "$DOCXMCP_DIR"
  compose_ps || true
)

log "recreating docxmcp compose service to refresh the runtime bind mount"
(
  cd "$DOCXMCP_DIR"
  docker compose -p "$PROJECT_NAME" up -d --force-recreate
)

deadline=$((SECONDS + TIMEOUT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  if healthcheck; then
    log "health=ok"
    log "self-heal complete"
    exit 0
  fi
  sleep 1
done

warn "health still failing after ${TIMEOUT_SECONDS}s"
warn "final compose status:"
(
  cd "$DOCXMCP_DIR"
  compose_ps || true
) >&2

die "docxmcp did not become healthy at ${SOCKET_PATH}"
