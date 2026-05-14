#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

# ═══════════════════════════════════════════════════════════════════════
# Declarative file manifest — single source of truth for all deployments.
# Format: "source_path|destination_path|mode|description"
# Source paths are relative to ROOT_DIR unless absolute.
# ═══════════════════════════════════════════════════════════════════════

SYSTEM_FILES=(
  # ── Systemd units ──
  "daemon/opencode-gateway.service|/etc/systemd/system/opencode-gateway.service|0644|Gateway service unit"
  "daemon/opencode-user@.service|/etc/systemd/system/opencode-user@.service|0644|Gateway per-user unit"
  "templates/system/opencms-daemon-user@.service|/etc/systemd/system/opencms-daemon-user@.service|0644|Per-user daemon unit (sandboxed)"
  "templates/system/opencms-daemon-wheel@.service|/etc/systemd/system/opencms-daemon-wheel@.service|0644|Per-user daemon unit (wheel, no sandbox)"

  # ── Executables ──
  "templates/system/opencms-daemon-launch.sh|/usr/local/libexec/opencms-daemon-launch|0755|Per-user daemon launcher"
  "templates/system/opencode-app-install.sh|/usr/local/bin/opencode-app-install|0755|MCP App install sudo wrapper"
  "webctl.sh|/etc/opencode/webctl.sh|0755|Runtime web controller"

  # ── Config templates (only installed if target missing) ──
  "templates/system/opencode.cfg|/etc/opencode/opencode.cfg|0644|Runtime config (template)"
  "templates/system/opencode.env|/etc/opencode/opencode.env|0644|Per-user daemon routing config (template)"
)

# Files that are always overwritten on deploy (service files, scripts).
# Config files (.cfg, .env) are only written on first install to preserve
# operator customizations — unless --force is used.
CONFIG_TEMPLATES=("opencode.cfg" "opencode.env")

# ═══════════════════════════════════════════════════════════════════════
# Build artifacts — installed by --system-init, not by --deploy
# ═══════════════════════════════════════════════════════════════════════

BUILD_FILES=(
  "dist/opencode-linux-x64/bin/opencode|/usr/local/bin/opencode|0755|CLI binary"
  "daemon/opencode-gateway|/usr/local/bin/opencode-gateway|0755|Gateway C binary"
  "daemon/login.html|/usr/local/share/opencode/login.html|0644|Gateway login page"
)

# ═══════════════════════════════════════════════════════════════════════

WITH_DESKTOP=0
SKIP_SYSTEM=0
ASSUME_YES=1
SYSTEM_INIT=0
DEPLOY_ONLY=0
FORCE_CONFIG=0
SYSTEM_SERVICE_NAME="opencode-gateway"

RED='\033[0;31m'  GREEN='\033[0;32m'
YELLOW='\033[1;33m'  BLUE='\033[0;34m'  NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()   { echo -e "${GREEN}[ OK ]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()  { echo -e "${RED}[ERR ]${NC} $1"; }

usage() {
  cat <<'EOF'
OpenCMS bootstrap installer

Usage:
  ./install.sh [options]

Modes:
  --system-init    Full first-time setup: OS packages, build, users, dirs,
                   deploy all files, enable + start gateway service.
  --deploy         Sync system files only (service units, launch scripts,
                   webctl). Skips build, user creation, OS packages.
                   Fast path for development iteration.

Options:
  --force          Also overwrite config files (opencode.cfg, opencode.env)
                   that are normally preserved after first install.
  --with-desktop   Install extra desktop (Tauri) prerequisites
  --skip-system    Skip OS package installation
  --service-name   systemd unit basename (default: opencode-gateway)
  --yes, -y        Non-interactive mode
  --help, -h       Show help

Examples:
  # First-time setup on a new machine
  ./install.sh --system-init

  # Changed a .service file or launch script during development
  ./install.sh --deploy

  # Also refresh config templates
  ./install.sh --deploy --force
EOF
}

# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════

confirm() {
  [[ "${ASSUME_YES}" -eq 1 ]] && return 0
  read -r -p "$1 [y/N]: " ans
  [[ "${ans}" =~ ^[Yy]$ ]]
}

ensure_command() {
  command -v "$1" >/dev/null 2>&1 || { log_err "Missing command: $1. $2"; exit 1; }
}

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then "$@"; return $?; fi
  if command -v sudo >/dev/null 2>&1; then sudo "$@"; return $?; fi
  log_err "This operation requires root (or sudo): $*"; exit 1
}

files_identical() {
  local src="$1" dst="$2"
  [[ -f "${dst}" ]] || return 1
  local h1 h2
  h1="$(sha256sum "${src}" | awk '{print $1}')"
  h2="$(sha256sum "${dst}" | awk '{print $1}')"
  [[ "${h1}" == "${h2}" ]]
}

files_identical_root() {
  local src="$1" dst="$2"
  run_as_root test -f "${dst}" || return 1
  local h1 h2
  h1="$(sha256sum "${src}" | awk '{print $1}')"
  h2="$(run_as_root sha256sum "${dst}" | awk '{print $1}')"
  [[ "${h1}" == "${h2}" ]]
}

dir_fingerprint() {
  local dir="$1"
  [[ -d "${dir}" ]] || { echo ""; return; }
  find "${dir}" -type f -print0 | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
}

dirs_identical_root() {
  local src="$1" dst="$2"
  run_as_root test -d "${dst}" || return 1
  local h1 h2
  h1="$(dir_fingerprint "${src}")"
  h2="$(run_as_root bash -c "$(declare -f dir_fingerprint); dir_fingerprint '${dst}'")"
  [[ -n "${h1}" && "${h1}" == "${h2}" ]]
}

is_config_template() {
  local filename="$1"
  for tmpl in "${CONFIG_TEMPLATES[@]}"; do
    [[ "${filename}" == "${tmpl}" ]] && return 0
  done
  return 1
}

ensure_clean_repo_deploy_source() {
  ensure_command git "git is required to verify deploy source cleanliness."
  local status
  status="$(git -C "${ROOT_DIR}" status --short --untracked-files=normal)"
  if [[ -n "${status}" ]]; then
    log_err "Dirty repo detected; refusing install/deploy from uncommitted source."
    log_warn "Commit, stash, or revert local changes before running install.sh."
    printf '%s\n' "${status}"
    exit 1
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Core: deploy system files from manifest
# ═══════════════════════════════════════════════════════════════════════

deploy_system_files() {
  log_info "═══ Deploying system files ═══"
  local units_changed=0
  local deployed=0
  local skipped=0

  for entry in "${SYSTEM_FILES[@]}"; do
    IFS='|' read -r src_rel dst mode desc <<< "${entry}"
    local src="${ROOT_DIR}/${src_rel}"
    local filename
    filename="$(basename "${src_rel}")"

    if [[ ! -f "${src}" ]]; then
      log_warn "Source not found: ${src_rel} (${desc})"
      continue
    fi

    # Config templates: skip if target exists (preserve operator edits)
    if is_config_template "${filename}" && [[ "${FORCE_CONFIG}" -eq 0 ]]; then
      if run_as_root test -f "${dst}"; then
        log_ok "${desc}: preserved (use --force to overwrite)"
        skipped=$((skipped + 1))
        continue
      fi
    fi

    if files_identical_root "${src}" "${dst}"; then
      log_ok "${desc}: up-to-date"
      skipped=$((skipped + 1))
      continue
    fi

    # Ensure parent directory exists
    local dst_dir
    dst_dir="$(dirname "${dst}")"
    run_as_root install -d -m 755 "${dst_dir}"
    run_as_root install -m "${mode}" "${src}" "${dst}"
    log_ok "${desc}: deployed → ${dst}"
    deployed=$((deployed + 1))

    # Track if any systemd unit changed
    case "${dst}" in
      /etc/systemd/system/*) units_changed=1 ;;
    esac
  done

  if [[ "${units_changed}" -eq 1 ]]; then
    run_as_root systemctl daemon-reload
    log_ok "systemctl daemon-reload"
  fi

  log_info "Deploy: ${deployed} updated, ${skipped} unchanged"
  return ${units_changed}
}

deploy_build_artifacts() {
  log_info "═══ Deploying build artifacts ═══"

  for entry in "${BUILD_FILES[@]}"; do
    IFS='|' read -r src_rel dst mode desc <<< "${entry}"
    local src="${ROOT_DIR}/${src_rel}"

    if [[ ! -f "${src}" ]]; then
      log_warn "Build artifact not found: ${src_rel} — run build first"
      continue
    fi

    if files_identical_root "${src}" "${dst}"; then
      log_ok "${desc}: up-to-date"
      continue
    fi

    local dst_dir
    dst_dir="$(dirname "${dst}")"
    run_as_root install -d -m 755 "${dst_dir}"
    run_as_root install -m "${mode}" "${src}" "${dst}"
    log_ok "${desc}: deployed → ${dst}"
  done

  # MCP servers (directory)
  local mcp_src="${ROOT_DIR}/dist/opencode-linux-x64/mcp"
  local mcp_dst="/usr/local/lib/opencode/mcp"
  if [[ -d "${mcp_src}" ]]; then
    run_as_root install -d -m 755 "${mcp_dst}"
    local mcp_changed=0
    for f in "${mcp_src}/"*; do
      [[ -f "$f" ]] || continue
      local name
      name="$(basename "$f")"
      if ! files_identical_root "$f" "${mcp_dst}/${name}"; then
        run_as_root install -m 755 "$f" "${mcp_dst}/${name}"
        mcp_changed=1
      fi
    done
    [[ "${mcp_changed}" -eq 0 ]] && log_ok "MCP servers: up-to-date" || log_ok "MCP servers: updated"
  fi

  # Frontend assets (directory)
  local fe_src="${ROOT_DIR}/packages/app/dist"
  local fe_dst="/usr/local/share/opencode/frontend"
  if [[ -d "${fe_src}" ]]; then
    run_as_root install -d -m 755 "${fe_dst}"
    if dirs_identical_root "${fe_src}" "${fe_dst}"; then
      log_ok "Frontend: up-to-date"
    else
      run_as_root cp -r "${fe_src}/"* "${fe_dst}/"
      log_ok "Frontend: deployed → ${fe_dst}"
    fi
  fi

  # Planner templates (directory)
  local spec_src="${ROOT_DIR}/templates/specs"
  local spec_dst="/etc/opencode/specs"
  if [[ -d "${spec_src}" ]]; then
    run_as_root install -d -m 755 "${spec_dst}"
    if dirs_identical_root "${spec_src}" "${spec_dst}"; then
      log_ok "Planner templates: up-to-date"
    else
      run_as_root cp -r "${spec_src}/"* "${spec_dst}/"
      log_ok "Planner templates: deployed → ${spec_dst}"
    fi
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# First-time init: users, directories, registries
# ═══════════════════════════════════════════════════════════════════════

init_system_prerequisites() {
  local os
  os="$(uname -s)"
  [[ "${os}" == "Linux" ]] || { log_err "--system-init supports Linux only."; exit 1; }
  ensure_command systemctl "systemd is required for --system-init."

  log_info "═══ System prerequisites ═══"

  # Clean legacy artifacts
  _clean_legacy_artifacts

  # System user (file-ownership isolation only, runs nothing)
  _ensure_system_user "opencode"

  # Directories
  run_as_root install -d -o opencode -g opencode -m 755 /opt/opencode-apps
  run_as_root install -d -o opencode -g opencode -m 755 /var/log/opencode
  run_as_root install -d -m 755 /etc/opencode
  log_ok "System directories ready"

  # JSON registries (create if missing, never overwrite)
  _init_json "/etc/opencode/google-bindings.json" '{}' "opencode:opencode" "0664"
  _init_json "/etc/opencode/mcp-apps.json" '{"version":1,"apps":{}}' "opencode:opencode" "0644"

  # /etc/opencode/ ownership
  run_as_root chown -R opencode:opencode /etc/opencode

  # Sudoers for app-install wrapper
  _install_sudoers "/usr/local/bin/opencode-app-install"

  log_ok "System prerequisites complete"
}

_ensure_system_user() {
  local user="$1"
  if run_as_root id -u "${user}" >/dev/null 2>&1; then
    log_ok "System user '${user}' exists (uid $(run_as_root id -u "${user}"))"
  else
    run_as_root useradd --system --no-create-home --shell /usr/sbin/nologin "${user}"
    log_ok "Created system user '${user}'"
  fi
}

_init_json() {
  local path="$1" content="$2" owner="$3" mode="$4"
  if run_as_root test -f "${path}"; then
    log_ok "Registry exists: ${path}"
  else
    echo "${content}" | run_as_root tee "${path}" > /dev/null
    run_as_root chown "${owner}" "${path}"
    run_as_root chmod "${mode}" "${path}"
    log_ok "Initialized: ${path}"
  fi
}

_install_sudoers() {
  local wrapper="$1"
  local sudoers_file="/etc/sudoers.d/opencode-app-install"
  local sudoers_content="ALL ALL=(root) NOPASSWD: ${wrapper}"
  if run_as_root test -f "${sudoers_file}"; then
    local existing
    existing="$(run_as_root cat "${sudoers_file}" 2>/dev/null || true)"
    if [[ "${existing}" == "${sudoers_content}" ]]; then
      log_ok "Sudoers policy: up-to-date"
      return
    fi
  fi
  echo "${sudoers_content}" | run_as_root tee "${sudoers_file}" > /dev/null
  run_as_root chmod 0440 "${sudoers_file}"
  log_ok "Sudoers policy: installed"
}

_clean_legacy_artifacts() {
  local cleaned=0
  if run_as_root test -f "/etc/systemd/system/opencode-web.service"; then
    run_as_root systemctl disable --now opencode-web.service 2>/dev/null || true
    run_as_root rm -f /etc/systemd/system/opencode-web.service
    log_ok "Removed legacy: opencode-web.service"
    cleaned=1
  fi
  for f in /etc/sudoers.d/opencode-run-as-user /usr/local/libexec/opencode-run-as-user; do
    if run_as_root test -f "$f"; then
      run_as_root rm -f "$f"
      log_ok "Removed legacy: $f"
      cleaned=1
    fi
  done
  [[ "${cleaned}" -eq 1 ]] && log_info "Legacy cleanup complete"
}

# ═══════════════════════════════════════════════════════════════════════
# Build
# ═══════════════════════════════════════════════════════════════════════

install_bun_if_needed() {
  if command -v bun >/dev/null 2>&1; then
    log_ok "Bun: $(bun --version)"
    return
  fi
  log_info "Installing Bun..."
  ensure_command curl "Please install curl first."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${HOME}/.bun"
  export PATH="${BUN_INSTALL}/bin:${PATH}"
  command -v bun >/dev/null 2>&1 || { log_err "Bun not in PATH after install."; exit 1; }
  log_ok "Bun installed: $(bun --version)"
}

install_system_packages() {
  [[ "${SKIP_SYSTEM}" -eq 1 ]] && { log_warn "Skipping system packages (--skip-system)."; return; }

  local os
  os="$(uname -s)"

  if [[ "${os}" == "Darwin" ]]; then
    command -v brew >/dev/null 2>&1 || { log_warn "Homebrew not found."; return; }
    log_info "Installing macOS deps via Homebrew..."
    brew update || true
    brew install git curl jq || true
    if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
      brew install rustup-init || true
      command -v cargo >/dev/null 2>&1 || rustup-init -y || true
    fi
    return
  fi

  [[ "${os}" == "Linux" ]] || { log_warn "Unsupported OS: ${os}"; return; }

  # Check if deps already present
  local need_install=0
  for cmd in git curl unzip xz jq pkg-config cc; do
    command -v "${cmd}" >/dev/null 2>&1 || { need_install=1; break; }
  done
  pkg-config --exists openssl >/dev/null 2>&1 || [[ -f "/usr/include/openssl/ssl.h" ]] || need_install=1

  if [[ "${need_install}" -eq 0 ]]; then
    log_ok "Linux dependencies: present"
    return
  fi

  command -v sudo >/dev/null 2>&1 || { log_warn "sudo not found; skipping."; return; }
  sudo -n true >/dev/null 2>&1 || { log_warn "sudo non-interactive unavailable; skipping."; return; }

  if command -v apt-get >/dev/null 2>&1; then
    log_info "Installing via apt-get..."
    sudo apt-get update
    sudo apt-get install -y git curl unzip xz-utils ca-certificates build-essential pkg-config libssl-dev jq
    if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
      sudo apt-get install -y rustup libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf || true
      command -v cargo >/dev/null 2>&1 || rustup-init -y || true
    fi
  elif command -v dnf >/dev/null 2>&1; then
    log_info "Installing via dnf..."
    sudo dnf install -y git curl unzip xz jq openssl-devel pkgconf-pkg-config
    sudo dnf groupinstall -y "Development Tools" || true
    if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
      sudo dnf install -y rustup gtk3-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel || true
      command -v cargo >/dev/null 2>&1 || rustup-init -y || true
    fi
  elif command -v pacman >/dev/null 2>&1; then
    log_info "Installing via pacman..."
    sudo pacman -Sy --noconfirm git curl unzip xz jq base-devel pkgconf openssl
    if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
      sudo pacman -S --noconfirm rustup gtk3 webkit2gtk libayatana-appindicator librsvg || true
      command -v cargo >/dev/null 2>&1 || rustup default stable || true
    fi
  else
    log_warn "No supported package manager (apt/dnf/pacman). Install deps manually."
  fi
}

build_backend() {
  export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
  export PATH="${BUN_INSTALL}/bin:${PATH}"
  ensure_command bun "Bun is required."

  local lock_hash_file="${ROOT_DIR}/node_modules/.lock-hash"
  local current_lock_hash=""
  if [[ -f "${ROOT_DIR}/bun.lock" ]]; then
    current_lock_hash="$(sha256sum "${ROOT_DIR}/bun.lock" | awk '{print $1}')"
  fi

  if [[ -n "${current_lock_hash}" && -f "${lock_hash_file}" ]] \
     && [[ "$(cat "${lock_hash_file}")" == "${current_lock_hash}" ]]; then
    log_ok "JS dependencies: up-to-date"
  else
    log_info "Installing JS dependencies..."
    bun install
    [[ -n "${current_lock_hash}" ]] && echo "${current_lock_hash}" > "${lock_hash_file}"
  fi

  log_info "Building backend binary..."
  bun run build --single --skip-install
}

# ═══════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --system-init)  SYSTEM_INIT=1 ;;
      --deploy)       DEPLOY_ONLY=1 ;;
      --force)        FORCE_CONFIG=1 ;;
      --with-desktop) WITH_DESKTOP=1 ;;
      --skip-system)  SKIP_SYSTEM=1 ;;
      --service-name) shift; SYSTEM_SERVICE_NAME="${1:?--service-name requires a value}" ;;
      --service-user) log_warn "--service-user is deprecated and ignored"; shift ;;
      --yes|-y)       ASSUME_YES=1 ;;
      --help|-h)      usage; exit 0 ;;
      *)              log_err "Unknown option: $1"; usage; exit 1 ;;
    esac
    shift
  done

  if [[ ! -f "${ROOT_DIR}/package.json" || ! -d "${ROOT_DIR}/packages" ]]; then
    log_err "Run from the opencode repository root."
    exit 1
  fi

  # ── --deploy: fast path ──
  if [[ "${DEPLOY_ONLY}" -eq 1 ]]; then
    log_info "OpenCMS deploy (system files only)"
    ensure_clean_repo_deploy_source
    deploy_system_files
    log_ok "Deploy complete. Restart services to apply:"
    log_info "  sudo systemctl restart ${SYSTEM_SERVICE_NAME}"
    log_info "  sudo systemctl restart opencms-daemon-wheel@\$(whoami)"
    exit 0
  fi

  # ── --system-init: full setup ──
  if [[ "${SYSTEM_INIT}" -eq 0 ]] && [[ "$(uname -s)" == "Linux" ]] && [[ "${ASSUME_YES}" -eq 0 ]]; then
    if confirm "Initialize Linux system service (recommended for multi-user)?"; then
      SYSTEM_INIT=1
    fi
  fi

  ensure_clean_repo_deploy_source
  log_info "OpenCMS bootstrap starting..."
  confirm "Proceed?" || { log_warn "Aborted."; exit 0; }

  install_system_packages
  install_bun_if_needed
  build_backend

  if [[ "${SYSTEM_INIT}" -eq 1 ]]; then
    init_system_prerequisites
    deploy_system_files
    deploy_build_artifacts

    run_as_root systemctl enable "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null
    log_ok "Enabled: ${SYSTEM_SERVICE_NAME}.service"

    if [[ "${ASSUME_YES}" -eq 1 ]] || confirm "Start ${SYSTEM_SERVICE_NAME}.service now?"; then
      run_as_root systemctl restart "${SYSTEM_SERVICE_NAME}.service"
      run_as_root systemctl --no-pager status "${SYSTEM_SERVICE_NAME}.service" || true
    fi
  fi

  if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
    if command -v cargo >/dev/null 2>&1; then
      log_ok "Rust toolchain: $(cargo --version | head -n1)"
    else
      log_warn "Rust toolchain not found. Desktop build may fail."
    fi
  fi

  log_ok "Bootstrap complete."
  cat <<EOF

Next steps:
  TUI (Dev):     bun run dev
  Web (Dev):     ./webctl.sh build-frontend && ./webctl.sh dev-start
  Desktop:       bun run --cwd packages/desktop tauri dev

System service:
  sudo systemctl status ${SYSTEM_SERVICE_NAME}
  sudo systemctl restart ${SYSTEM_SERVICE_NAME}

Quick deploy (after editing service files):
  ./install.sh --deploy

EOF
}

main "$@"
