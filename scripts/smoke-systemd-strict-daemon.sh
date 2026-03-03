#!/usr/bin/env bash

set -euo pipefail

TARGET_USER="${1:-${SUDO_USER:-${USER:-}}}"
BASE_URL="${OPENCODE_SMOKE_BASE_URL:-http://127.0.0.1:1080}"
CHECK_STRICT_DOWN="${OPENCODE_SMOKE_CHECK_STRICT_DOWN:-0}"

if [[ -z "${TARGET_USER}" ]]; then
  echo "[smoke] target user is required (arg1 or USER)." >&2
  exit 2
fi

AUTH_ARGS=()
USER_ARGS=(-H "x-opencode-user: ${TARGET_USER}")
if [[ -n "${OPENCODE_CLI_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${OPENCODE_CLI_TOKEN}")
elif [[ -n "${OPENCODE_TEST_BASIC_AUTH:-}" ]]; then
  AUTH_ARGS=(-u "${OPENCODE_TEST_BASIC_AUTH}")
fi

ok() { echo "[OK] $*"; }
warn() { echo "[WARN] $*"; }
fail() { echo "[FAIL] $*"; exit 1; }

require_active() {
  local unit="$1"
  if sudo systemctl is-active --quiet "$unit"; then
    ok "$unit is active"
  else
    fail "$unit is not active"
  fi
}

require_env_flag() {
  local key="$1"
  local want="$2"
  local got
  got="$(sudo awk -F= -v k="$key" '$1==k{print $2}' /etc/opencode/opencode.env | tail -n1 || true)"
  if [[ "$got" == "$want" ]]; then
    ok "env $key=$want"
  else
    fail "env $key expected '$want' got '${got:-<unset>}'"
  fi
}

http_code() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local code
  if [[ -n "$body" ]]; then
    code="$(curl -sS -o /tmp/opencode_smoke_body.json -w '%{http_code}' -X "$method" "${AUTH_ARGS[@]}" "${USER_ARGS[@]}" -H 'Content-Type: application/json' -d "$body" "${BASE_URL}${path}")"
  else
    code="$(curl -sS -o /tmp/opencode_smoke_body.json -w '%{http_code}' -X "$method" "${AUTH_ARGS[@]}" "${USER_ARGS[@]}" "${BASE_URL}${path}")"
  fi
  printf '%s' "$code"
}

expect_200() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local code
  code="$(http_code "$method" "$path" "$body")"
  if [[ "$code" == "200" ]]; then
    ok "$method $path -> 200"
    return
  fi
  if [[ "$code" == "401" ]]; then
    fail "$method $path -> 401 (provide OPENCODE_CLI_TOKEN or OPENCODE_TEST_BASIC_AUTH)"
  fi
  fail "$method $path -> $code; body=$(cat /tmp/opencode_smoke_body.json)"
}

expect_503() {
  local method="$1"
  local path="$2"
  local code
  code="$(http_code "$method" "$path")"
  if [[ "$code" == "503" ]]; then
    ok "$method $path -> 503 (strict mode confirmed)"
  else
    fail "$method $path expected 503 got $code; body=$(cat /tmp/opencode_smoke_body.json)"
  fi
}

echo "[smoke] target_user=${TARGET_USER} base_url=${BASE_URL}"

require_active "opencode-web.service"
require_active "opencode-user-daemon@${TARGET_USER}.service"

require_env_flag "OPENCODE_PER_USER_DAEMON_EXPERIMENTAL" "1"
require_env_flag "OPENCODE_PER_USER_DAEMON_ROUTE_CONFIG" "1"
require_env_flag "OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_LIST" "1"
require_env_flag "OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_MUTATION" "1"
require_env_flag "OPENCODE_USER_WORKER_EXPERIMENTAL" "0"

expect_200 GET /experimental/user-daemon
expect_200 GET /config
expect_200 GET /account

if [[ "$CHECK_STRICT_DOWN" == "1" ]]; then
  warn "strict-down test enabled: masking user daemon temporarily"
  sudo systemctl stop "opencode-user-daemon@${TARGET_USER}.service"
  sudo systemctl mask "opencode-user-daemon@${TARGET_USER}.service" >/dev/null
  trap 'sudo systemctl unmask "opencode-user-daemon@${TARGET_USER}.service" >/dev/null 2>&1 || true; sudo systemctl start "opencode-user-daemon@${TARGET_USER}.service" >/dev/null 2>&1 || true' EXIT
  sleep 1
  expect_503 GET /config
  expect_503 GET /account
  sudo systemctl unmask "opencode-user-daemon@${TARGET_USER}.service" >/dev/null
  sudo systemctl start "opencode-user-daemon@${TARGET_USER}.service"
  trap - EXIT
  ok "strict-down test complete"
fi

ok "smoke test completed"
