#!/usr/bin/env bash
set -Eeuo pipefail

# Self-heal opencode-gateway and per-user daemon startup chain.
# Scope:
#   - verify gateway systemd unit is loaded and active
#   - diff installed service files against repo source (detect drift)
#   - validate ReadWritePaths entries exist on disk
#   - verify per-user daemon socket is connectable for given user(s)
#   - optionally reinstall drifted service files + daemon-reload + restart
#
# This script intentionally does NOT spawn opencode daemon processes directly.
# It only manages systemd units via systemctl.

MODE="check"
TARGET_USER="${SUDO_USER:-$(id -un)}"
REPO_ROOT=""
TIMEOUT_SECONDS=15

usage() {
  cat <<'EOF'
Usage: scripts/gateway-self-heal.sh [--check|--heal] [options]

Modes:
  --check                 Inspect service files, mount paths, socket health. No mutation. Default.
  --heal                  Reinstall drifted service files, daemon-reload, restart failed units.

Options:
  --user USERNAME         Target user for daemon socket check. Default: $SUDO_USER or current user.
  --repo-root PATH        Override repo root. Default: auto-detect from script location.
  --timeout SECONDS       Wait time for socket after restart. Default: 15
  -h, --help              Show this help.
EOF
}

log()  { printf '[gateway-self-heal] %s\n' "$*"; }
warn() { printf '[gateway-self-heal] WARN: %s\n' "$*" >&2; }
die()  { printf '[gateway-self-heal] ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --heal)  MODE="heal" ;;
    --user)
      [ "$#" -ge 2 ] || die "--user requires a value"
      TARGET_USER="$2"; shift ;;
    --repo-root)
      [ "$#" -ge 2 ] || die "--repo-root requires a value"
      REPO_ROOT="$2"; shift ;;
    --timeout)
      [ "$#" -ge 2 ] || die "--timeout requires a value"
      TIMEOUT_SECONDS="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

case "$TIMEOUT_SECONDS" in
  ''|*[!0-9]*) die "--timeout must be a positive integer" ;;
esac
[ "$TIMEOUT_SECONDS" -gt 0 ] || die "--timeout must be > 0"

# --- Resolve repo root ---
if [ -z "$REPO_ROOT" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
[ -f "$REPO_ROOT/daemon/opencode-gateway.c" ] || die "repo root not found at $REPO_ROOT"

# --- Service file pairs: repo source → installed target ---
declare -A SERVICE_FILES=(
  ["$REPO_ROOT/daemon/opencode-gateway.service"]="/etc/systemd/system/opencode-gateway.service"
  ["$REPO_ROOT/templates/system/opencms-daemon-wheel@.service"]="/etc/systemd/system/opencms-daemon-wheel@.service"
)

NEEDS_RELOAD=0
NEEDS_GATEWAY_RESTART=0
NEEDS_DAEMON_RESTART=0
ERRORS=0

# ============================================================
# Phase 1: Service file drift detection
# ============================================================

check_service_drift() {
  local src="$1" dst="$2" label="$3"
  if [ ! -f "$dst" ]; then
    warn "${label}: not installed at ${dst}"
    ERRORS=$((ERRORS + 1))
    return 1
  fi
  if ! diff -q "$src" "$dst" >/dev/null 2>&1; then
    warn "${label}: installed file differs from repo"
    diff --unified=3 "$dst" "$src" || true
    ERRORS=$((ERRORS + 1))
    return 1
  fi
  log "${label}: in sync"
  return 0
}

log "=== Phase 1: Service file drift ==="
for src in "${!SERVICE_FILES[@]}"; do
  dst="${SERVICE_FILES[$src]}"
  label="$(basename "$src")"
  if ! check_service_drift "$src" "$dst" "$label"; then
    case "$label" in
      opencode-gateway.service) NEEDS_GATEWAY_RESTART=1 ;;
      *sudoer*) NEEDS_DAEMON_RESTART=1 ;;
    esac
    NEEDS_RELOAD=1
  fi
done

# ============================================================
# Phase 2: ReadWritePaths validation (gateway unit)
# ============================================================

log "=== Phase 2: ReadWritePaths validation ==="
GATEWAY_UNIT="$REPO_ROOT/daemon/opencode-gateway.service"
RWP_LINE="$(grep -E '^ReadWritePaths=' "$GATEWAY_UNIT" || true)"
if [ -n "$RWP_LINE" ]; then
  RWP_VALUE="${RWP_LINE#ReadWritePaths=}"
  for p in $RWP_VALUE; do
    if [ ! -e "$p" ]; then
      warn "ReadWritePaths entry does not exist: ${p}"
      warn "ProtectSystem=strict will fail mount namespace setup (exit 226/NAMESPACE)"
      ERRORS=$((ERRORS + 1))
    fi
  done
  if [ "$ERRORS" -eq 0 ]; then
    log "all ReadWritePaths entries exist"
  fi
else
  log "no ReadWritePaths directive found (skip)"
fi

# ============================================================
# Phase 3: Gateway unit status
# ============================================================

log "=== Phase 3: Gateway service status ==="
GW_ACTIVE="$(systemctl is-active opencode-gateway.service 2>/dev/null || echo "unknown")"
log "opencode-gateway.service: ${GW_ACTIVE}"
if [ "$GW_ACTIVE" != "active" ]; then
  warn "gateway is not active (${GW_ACTIVE})"
  NEEDS_GATEWAY_RESTART=1
  ERRORS=$((ERRORS + 1))
fi

# ============================================================
# Phase 4: User daemon socket check
# ============================================================

log "=== Phase 4: User daemon socket (${TARGET_USER}) ==="
TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || echo "")"
if [ -z "$TARGET_UID" ]; then
  warn "cannot resolve uid for ${TARGET_USER}"
  ERRORS=$((ERRORS + 1))
else
  DAEMON_SOCK="/run/user/${TARGET_UID}/opencode/daemon.sock"
  if [ -S "$DAEMON_SOCK" ]; then
    log "socket exists: ${DAEMON_SOCK}"
    if curl --silent --fail --max-time 3 --unix-socket "$DAEMON_SOCK" \
         "http://localhost/api/v2/global/health" >/dev/null 2>&1; then
      log "daemon health=ok"
    else
      warn "socket exists but health check failed"
      NEEDS_DAEMON_RESTART=1
      ERRORS=$((ERRORS + 1))
    fi
  else
    log "socket missing: ${DAEMON_SOCK}"
    # Check if a systemd unit is running but on wrong transport
    SUDOER_UNIT="opencms-daemon-wheel@${TARGET_USER}.service"
    REGULAR_UNIT="opencms-daemon-user@${TARGET_USER}.service"
    for unit in "$SUDOER_UNIT" "$REGULAR_UNIT"; do
      unit_active="$(systemctl is-active "$unit" 2>/dev/null || echo "inactive")"
      if [ "$unit_active" = "active" ]; then
        cmdline="$(systemctl show -p ExecStart "$unit" 2>/dev/null || true)"
        if echo "$cmdline" | grep -q -- '--port'; then
          warn "${unit} is active but using TCP (--port) instead of Unix socket"
          warn "likely missing OPENCODE_USER_DAEMON_TRANSPORT=unix in unit file"
        else
          warn "${unit} is active but socket not present"
        fi
        NEEDS_DAEMON_RESTART=1
        ERRORS=$((ERRORS + 1))
        break
      fi
    done
    if [ "$NEEDS_DAEMON_RESTART" -eq 0 ]; then
      log "no daemon unit active for ${TARGET_USER} (gateway will spawn on next request)"
    fi
  fi
fi

# ============================================================
# Summary
# ============================================================

log "=== Summary ==="
log "errors=${ERRORS} mode=${MODE}"

if [ "$ERRORS" -eq 0 ]; then
  log "all checks passed"
  exit 0
fi

if [ "$MODE" = "check" ]; then
  warn "issues found; run with --heal to fix"
  exit 2
fi

# ============================================================
# Heal
# ============================================================

log "=== Healing ==="

# Step 1: Reinstall drifted service files
for src in "${!SERVICE_FILES[@]}"; do
  dst="${SERVICE_FILES[$src]}"
  if [ ! -f "$dst" ] || ! diff -q "$src" "$dst" >/dev/null 2>&1; then
    log "installing $(basename "$src") → ${dst}"
    cp "$src" "$dst"
    NEEDS_RELOAD=1
  fi
done

if [ "$NEEDS_RELOAD" -eq 1 ]; then
  log "daemon-reload"
  systemctl daemon-reload
fi

# Step 2: Restart gateway if needed
if [ "$NEEDS_GATEWAY_RESTART" -eq 1 ]; then
  log "restarting opencode-gateway.service"
  systemctl restart opencode-gateway.service
  sleep 1
  GW_ACTIVE="$(systemctl is-active opencode-gateway.service 2>/dev/null || echo "unknown")"
  if [ "$GW_ACTIVE" = "active" ]; then
    log "gateway restarted successfully"
  else
    die "gateway failed to restart; check: journalctl -u opencode-gateway"
  fi
fi

# Step 3: Restart user daemon if needed
if [ "$NEEDS_DAEMON_RESTART" -eq 1 ] && [ -n "${TARGET_UID:-}" ]; then
  SUDOER_UNIT="opencms-daemon-wheel@${TARGET_USER}.service"
  REGULAR_UNIT="opencms-daemon-user@${TARGET_USER}.service"

  # Determine which unit to use
  DAEMON_UNIT=""
  for unit in "$SUDOER_UNIT" "$REGULAR_UNIT"; do
    if systemctl is-enabled "$unit" >/dev/null 2>&1 ||
       systemctl is-active "$unit" >/dev/null 2>&1; then
      DAEMON_UNIT="$unit"
      break
    fi
  done

  if [ -n "$DAEMON_UNIT" ]; then
    log "restarting ${DAEMON_UNIT}"
    systemctl restart "$DAEMON_UNIT"

    DAEMON_SOCK="/run/user/${TARGET_UID}/opencode/daemon.sock"
    deadline=$((SECONDS + TIMEOUT_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
      if [ -S "$DAEMON_SOCK" ] && curl --silent --fail --max-time 3 \
           --unix-socket "$DAEMON_SOCK" \
           "http://localhost/api/v2/global/health" >/dev/null 2>&1; then
        log "daemon socket healthy: ${DAEMON_SOCK}"
        break
      fi
      sleep 1
    done
    if [ "$SECONDS" -ge "$deadline" ]; then
      warn "daemon did not become healthy within ${TIMEOUT_SECONDS}s"
      warn "check: journalctl -u ${DAEMON_UNIT}"
    fi
  else
    log "no daemon unit found for ${TARGET_USER}; gateway will spawn on next authenticated request"
  fi
fi

log "self-heal complete"
