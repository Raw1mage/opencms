#!/usr/bin/env bash
# opencode-app-install — Privileged wrapper for MCP App lifecycle operations.
#
# This script is installed to /usr/local/bin/opencode-app-install and
# invoked via sudo by per-user daemons (system-manager MCP tool).
# It is the ONLY mechanism for non-root processes to write to
# /opt/opencode-apps/ and /etc/opencode/mcp-apps.json.
#
# Sudoers entry (installed by install.sh):
#   ALL ALL=(root) NOPASSWD: /usr/local/bin/opencode-app-install
#
# Usage:
#   sudo opencode-app-install clone  <github-url> <app-id>
#   sudo opencode-app-install register <app-id> <app-path>
#   sudo opencode-app-install remove <app-id>
#
# Security:
#   - All paths are resolved and validated against /opt/opencode-apps/
#   - No arbitrary path writes allowed
#   - All created files are chown'd to opencode:opencode

set -euo pipefail

readonly APPS_DIR="/opt/opencode-apps"
readonly MCP_APPS_JSON="/etc/opencode/mcp-apps.json"
readonly SVC_USER="opencode"

die() { echo "[ERR] $1" >&2; exit 1; }
ok()  { echo "[OK] $1"; }

# Validate app-id: alphanumeric, hyphens, underscores only
validate_app_id() {
  local id="$1"
  if [[ ! "${id}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    die "Invalid app-id '${id}': only alphanumeric, hyphens, and underscores allowed"
  fi
  if [[ "${#id}" -gt 64 ]]; then
    die "App-id '${id}' too long (max 64 chars)"
  fi
}

# Ensure target path is strictly under APPS_DIR (prevent path traversal)
safe_app_path() {
  local id="$1"
  local resolved
  resolved="$(realpath -m "${APPS_DIR}/${id}")"
  if [[ "${resolved}" != "${APPS_DIR}/"* ]]; then
    die "Path traversal rejected: ${id} resolves to ${resolved}"
  fi
  echo "${resolved}"
}

cmd_clone() {
  local url="${1:-}"
  local id="${2:-}"
  [[ -z "${url}" ]] && die "Usage: opencode-app-install clone <github-url> <app-id>"
  [[ -z "${id}" ]]  && die "Usage: opencode-app-install clone <github-url> <app-id>"

  validate_app_id "${id}"
  local target
  target="$(safe_app_path "${id}")"

  if [[ -d "${target}" ]]; then
    die "App directory already exists: ${target}"
  fi

  # Validate URL looks like a git remote (basic check)
  if [[ ! "${url}" =~ ^https?:// ]] && [[ ! "${url}" =~ ^git@ ]]; then
    die "Invalid source URL: ${url}"
  fi

  git clone --depth 1 "${url}" "${target}" 2>&1
  chown -R "${SVC_USER}:${SVC_USER}" "${target}"
  ok "Cloned ${url} → ${target} (owner: ${SVC_USER})"
}

cmd_register() {
  local id="${1:-}"
  local app_path="${2:-}"
  [[ -z "${id}" ]]       && die "Usage: opencode-app-install register <app-id> <app-path>"
  [[ -z "${app_path}" ]] && die "Usage: opencode-app-install register <app-id> <app-path>"

  validate_app_id "${id}"

  # Resolve app_path — allow paths outside /opt/opencode-apps/ (e.g. local dev paths)
  local resolved
  resolved="$(realpath -m "${app_path}")"
  if [[ ! -d "${resolved}" ]]; then
    die "App path does not exist: ${resolved}"
  fi

  # Ensure mcp-apps.json exists
  if [[ ! -f "${MCP_APPS_JSON}" ]]; then
    echo '{"version":1,"apps":{}}' > "${MCP_APPS_JSON}"
    chown "${SVC_USER}:${SVC_USER}" "${MCP_APPS_JSON}"
  fi

  # Add entry using a simple jq-free approach (python fallback)
  local tmp_file
  tmp_file="$(mktemp)"
  python3 -c "
import json, sys
with open('${MCP_APPS_JSON}') as f:
    data = json.load(f)
data.setdefault('apps', {})['${id}'] = {
    'path': '${resolved}',
    'enabled': True,
    'installedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
    'source': {'type': 'local'}
}
with open('${tmp_file}', 'w') as f:
    json.dump(data, f, indent=2)
" || die "Failed to update mcp-apps.json"

  mv "${tmp_file}" "${MCP_APPS_JSON}"
  chown "${SVC_USER}:${SVC_USER}" "${MCP_APPS_JSON}"
  chmod 0644 "${MCP_APPS_JSON}"
  ok "Registered app '${id}' → ${resolved} in ${MCP_APPS_JSON}"
}

cmd_remove() {
  local id="${1:-}"
  [[ -z "${id}" ]] && die "Usage: opencode-app-install remove <app-id>"

  validate_app_id "${id}"

  # Remove from mcp-apps.json
  if [[ -f "${MCP_APPS_JSON}" ]]; then
    local tmp_file
    tmp_file="$(mktemp)"
    python3 -c "
import json
with open('${MCP_APPS_JSON}') as f:
    data = json.load(f)
data.get('apps', {}).pop('${id}', None)
with open('${tmp_file}', 'w') as f:
    json.dump(data, f, indent=2)
" || die "Failed to update mcp-apps.json"
    mv "${tmp_file}" "${MCP_APPS_JSON}"
    chown "${SVC_USER}:${SVC_USER}" "${MCP_APPS_JSON}"
    chmod 0644 "${MCP_APPS_JSON}"
    ok "Removed app '${id}' from ${MCP_APPS_JSON}"
  fi

  # Remove app directory if it's under APPS_DIR
  local target
  target="$(safe_app_path "${id}")"
  if [[ -d "${target}" ]]; then
    rm -rf "${target}"
    ok "Deleted app directory: ${target}"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────
case "${1:-}" in
  clone)    shift; cmd_clone "$@" ;;
  register) shift; cmd_register "$@" ;;
  remove)   shift; cmd_remove "$@" ;;
  *)
    echo "Usage: opencode-app-install {clone|register|remove} [args...]" >&2
    echo "" >&2
    echo "Commands:" >&2
    echo "  clone  <github-url> <app-id>   Clone repo to /opt/opencode-apps/<id>" >&2
    echo "  register <app-id> <app-path>   Register app in /etc/opencode/mcp-apps.json" >&2
    echo "  remove <app-id>                Unregister and optionally delete app" >&2
    exit 1
    ;;
esac
