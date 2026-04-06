#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

WITH_DESKTOP=0
SKIP_SYSTEM=0
ASSUME_YES=1
SYSTEM_INIT=0
SYSTEM_SERVICE_NAME="opencode-gateway"
SYSTEM_INIT_DONE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err() { echo -e "${RED}[ERR]${NC} $1"; }

ensure_clean_repo_deploy_source() {
  if ! command -v git >/dev/null 2>&1; then
    log_err "git is required to verify deploy source cleanliness."
    exit 1
  fi

  local status
  status="$(git -C "${ROOT_DIR}" status --short --untracked-files=normal)"
  if [[ -n "${status}" ]]; then
    log_err "Dirty repo detected; refusing install/deploy from uncommitted source."
    log_warn "Commit, stash, or revert local changes before running install.sh."
    printf '%s\n' "${status}"
    exit 1
  fi
}

usage() {
  cat <<'EOF'
OpenCode bootstrap installer

Usage:
  ./install.sh [options]

Options:
  --with-desktop   Install extra desktop(Tauri) prerequisites
  --skip-system    Skip OS package installation
  --system-init    Initialize Linux system user + systemd service
  --service-user   (deprecated, ignored — gateway runs as root)
  --service-name   systemd unit basename for --system-init (default: opencode-gateway)
  --yes, -y        Non-interactive mode
  --help, -h       Show help
EOF
}

confirm() {
  local prompt="$1"
  if [[ "${ASSUME_YES}" -eq 1 ]]; then
    return 0
  fi
  read -r -p "${prompt} [y/N]: " ans
  [[ "${ans}" =~ ^[Yy]$ ]]
}

ensure_command() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    log_err "Missing command: ${cmd}. ${hint}"
    exit 1
  fi
}

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
    return $?
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return $?
  fi

  log_err "This operation requires root (or sudo): $*"
  exit 1
}

# ── Fingerprint helpers (make-style skip) ──────────────────────────────

# Compare sha256 of two files; returns 0 (true) if identical.
files_identical() {
  local src="$1" dst="$2"
  [[ -f "${dst}" ]] || return 1
  local h1 h2
  h1="$(sha256sum "${src}" | awk '{print $1}')"
  h2="$(sha256sum "${dst}" | awk '{print $1}')"
  [[ "${h1}" == "${h2}" ]]
}

# Same as files_identical but dst requires sudo to read.
files_identical_root() {
  local src="$1" dst="$2"
  run_as_root test -f "${dst}" || return 1
  local h1 h2
  h1="$(sha256sum "${src}" | awk '{print $1}')"
  h2="$(run_as_root sha256sum "${dst}" | awk '{print $1}')"
  [[ "${h1}" == "${h2}" ]]
}

# Compute a deterministic hash over a directory tree (content + relative paths).
# Usage: dir_fingerprint /path/to/dir  →  prints a single sha256
dir_fingerprint() {
  local dir="$1"
  [[ -d "${dir}" ]] || { echo ""; return; }
  # hash every file's content, prefix with relative path, then hash the list
  find "${dir}" -type f -print0 | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
}

# Compare directory tree fingerprints; returns 0 if identical.
dirs_identical_root() {
  local src="$1" dst="$2"
  run_as_root test -d "${dst}" || return 1
  local h1 h2
  h1="$(dir_fingerprint "${src}")"
  h2="$(run_as_root bash -c "$(declare -f dir_fingerprint); dir_fingerprint '${dst}'")"
  [[ -n "${h1}" && "${h1}" == "${h2}" ]]
}

# ── End fingerprint helpers ────────────────────────────────────────────

system_init() {
  local os
  os="$(uname -s)"

  if [[ "${os}" != "Linux" ]]; then
    log_err "--system-init currently supports Linux only."
    exit 1
  fi

  ensure_command systemctl "systemd is required for --system-init."

  # ── Clean up legacy service artifacts (but keep opencode user) ─────
  _clean_legacy_service_artifacts

  # ── Ensure opencode system user for file-ownership isolation (DD-4) ─
  _ensure_opencode_system_user

  # ── App directories + mcp-apps.json + sudo wrapper ──────────────────
  _ensure_app_directories
  _install_app_sudo_wrapper

  # ── Per-user daemon launcher (/usr/local/libexec) ──────────────────
  local daemon_launcher_src="${ROOT_DIR}/templates/system/opencode-user-daemon-launch.sh"
  local daemon_launcher_dst="/usr/local/libexec/opencode-user-daemon-launch"
  if [[ -f "${daemon_launcher_src}" ]]; then
    if files_identical_root "${daemon_launcher_src}" "${daemon_launcher_dst}"; then
      log_ok "Daemon launcher up-to-date: ${daemon_launcher_dst}"
    else
      run_as_root install -d -m 755 "/usr/local/libexec"
      run_as_root install -m 755 "${daemon_launcher_src}" "${daemon_launcher_dst}"
      log_ok "Installed per-user daemon launcher: ${daemon_launcher_dst}"
    fi
  else
    log_warn "Daemon launcher source not found: ${daemon_launcher_src}"
  fi

  # ── /etc/opencode — config directory (root-owned) ──────────────────
  local env_dir="/etc/opencode"
  local runtime_cfg_file="${env_dir}/opencode.cfg"
  local runtime_cfg_template="${ROOT_DIR}/templates/system/opencode.cfg"
  local tmp_runtime_cfg="/tmp/opencode.cfg.$$"
  local runtime_env_file="${env_dir}/opencode.env"
  local runtime_env_template="${ROOT_DIR}/templates/system/opencode.env"
  local installed_frontend_path="/usr/local/share/opencode/frontend"
  local runtime_webctl_dst="${env_dir}/webctl.sh"
  local planner_templates_src="${ROOT_DIR}/templates/specs"
  local planner_templates_dst="${env_dir}/specs"
  run_as_root install -d -m 755 "${env_dir}"

  # Google binding registry — gateway reads, per-user daemons write via gateway API.
  # Owned opencode:opencode 0664 (DD-4: file-ownership isolation).
  local binding_file="${env_dir}/google-bindings.json"
  if [ ! -f "${binding_file}" ] || [ ! -s "${binding_file}" ]; then
    echo '{}' | run_as_root tee "${binding_file}" > /dev/null
    log_ok "Initialized Google binding registry: ${binding_file}"
  fi
  run_as_root chown opencode:opencode "${binding_file}"
  run_as_root chmod 0664 "${binding_file}"

  if files_identical_root "${ROOT_DIR}/webctl.sh" "${runtime_webctl_dst}"; then
    log_ok "Runtime web controller up-to-date: ${runtime_webctl_dst}"
  else
    run_as_root install -m 755 "${ROOT_DIR}/webctl.sh" "${runtime_webctl_dst}"
    log_ok "Installed runtime web controller: ${runtime_webctl_dst}"
  fi

  if [[ ! -f "${runtime_cfg_template}" ]]; then
    log_err "Missing runtime config template: ${runtime_cfg_template}"
    exit 1
  fi

  if [[ -d "${planner_templates_src}" ]]; then
    run_as_root install -d -m 755 "${planner_templates_dst}"
    if dirs_identical_root "${planner_templates_src}" "${planner_templates_dst}"; then
      log_ok "Planner templates up-to-date: ${planner_templates_dst}"
    else
      run_as_root cp -r "${planner_templates_src}/"* "${planner_templates_dst}/"
      log_ok "Installed planner templates: ${planner_templates_dst}"
    fi
  else
    log_warn "Planner templates source not found: ${planner_templates_src}"
  fi

  if run_as_root test -f "${runtime_cfg_file}"; then
    local cfg_ok=1
    run_as_root grep -q "^OPENCODE_FRONTEND_PATH=\"${installed_frontend_path}\"" "${runtime_cfg_file}" || cfg_ok=0
    run_as_root grep -q "^OPENCODE_WEBCTL_PATH=\"${runtime_webctl_dst}\"" "${runtime_cfg_file}" || cfg_ok=0
    if [[ "${cfg_ok}" -eq 1 ]]; then
      log_ok "Runtime config up-to-date: ${runtime_cfg_file}"
    else
      run_as_root cp "${runtime_cfg_file}" "${tmp_runtime_cfg}"
      if grep -q '^OPENCODE_FRONTEND_PATH=' "${tmp_runtime_cfg}"; then
        sed -i "s|^OPENCODE_FRONTEND_PATH=.*|OPENCODE_FRONTEND_PATH=\"${installed_frontend_path}\"|" "${tmp_runtime_cfg}"
      else
        printf '\nOPENCODE_FRONTEND_PATH="%s"\n' "${installed_frontend_path}" >> "${tmp_runtime_cfg}"
      fi
      if grep -q '^OPENCODE_WEBCTL_PATH=' "${tmp_runtime_cfg}"; then
        sed -i "s|^OPENCODE_WEBCTL_PATH=.*|OPENCODE_WEBCTL_PATH=\"${runtime_webctl_dst}\"|" "${tmp_runtime_cfg}"
      else
        printf 'OPENCODE_WEBCTL_PATH="%s"\n' "${runtime_webctl_dst}" >> "${tmp_runtime_cfg}"
      fi
      run_as_root install -m 644 "${tmp_runtime_cfg}" "${runtime_cfg_file}"
      rm -f "${tmp_runtime_cfg}"
      log_ok "Normalized runtime config: ${runtime_cfg_file}"
    fi
  else
    cp "${runtime_cfg_template}" "${tmp_runtime_cfg}"
    run_as_root install -m 644 "${tmp_runtime_cfg}" "${runtime_cfg_file}"
    rm -f "${tmp_runtime_cfg}"
    log_ok "Created runtime config: ${runtime_cfg_file}"
  fi

  # Install opencode.env (per-user daemon routing config) — only if not present.
  # Preserves local operator customizations on subsequent reinstalls.
  if [[ -f "${runtime_env_template}" ]]; then
    if run_as_root test -f "${runtime_env_file}"; then
      log_ok "Runtime env config present (not overwritten): ${runtime_env_file}"
    else
      run_as_root install -m 644 "${runtime_env_template}" "${runtime_env_file}"
      log_ok "Created runtime env config: ${runtime_env_file}"
    fi
  fi

  # ── Binaries ───────────────────────────────────────────────────────
  local bin_src="${ROOT_DIR}/dist/opencode-linux-x64/bin/opencode"
  local bin_dst="/usr/local/bin/opencode"
  if files_identical_root "${bin_src}" "${bin_dst}"; then
    log_ok "Binary up-to-date: ${bin_dst}"
  else
    log_info "Installing binary to ${bin_dst}..."
    run_as_root install -m 755 "${bin_src}" "${bin_dst}"
  fi

  local mcp_src="${ROOT_DIR}/dist/opencode-linux-x64/mcp"
  local mcp_dst="/usr/local/lib/opencode/mcp"
  run_as_root install -d -m 755 "${mcp_dst}"
  if [[ -d "${mcp_src}" ]]; then
    local mcp_changed=0
    for f in "${mcp_src}/"*; do
      if [[ -f "$f" ]]; then
        local mcp_name
        mcp_name="$(basename "$f")"
        if files_identical_root "$f" "${mcp_dst}/${mcp_name}"; then
          continue
        fi
        run_as_root install -m 755 "$f" "${mcp_dst}/${mcp_name}"
        mcp_changed=1
      fi
    done
    if [[ "${mcp_changed}" -eq 0 ]]; then
      log_ok "MCP servers up-to-date: ${mcp_dst}"
    else
      log_ok "Updated MCP servers in: ${mcp_dst}"
    fi
  fi

  # ── Frontend static assets (root-owned) ────────────────────────────
  run_as_root install -d -m 755 "/usr/local/share/opencode/frontend"
  if [[ -d "${ROOT_DIR}/packages/app/dist" ]]; then
    if dirs_identical_root "${ROOT_DIR}/packages/app/dist" "/usr/local/share/opencode/frontend"; then
      log_ok "Frontend up-to-date: ${installed_frontend_path}"
    else
      log_info "Installing web frontend to ${installed_frontend_path}..."
      run_as_root cp -r "${ROOT_DIR}/packages/app/dist/"* "/usr/local/share/opencode/frontend/"
    fi
  fi

  # ── Systemd units ──────────────────────────────────────────────────
  local units_changed=0

  # Gateway (C root daemon) — the primary service
  local gateway_unit_src="${ROOT_DIR}/daemon/opencode-gateway.service"
  local gateway_unit_dst="/etc/systemd/system/opencode-gateway.service"
  local gateway_user_unit_src="${ROOT_DIR}/daemon/opencode-user@.service"
  local gateway_user_unit_dst="/etc/systemd/system/opencode-user@.service"
  local gateway_bin_src="${ROOT_DIR}/daemon/opencode-gateway"
  local gateway_login_src="${ROOT_DIR}/daemon/login.html"

  if [[ -f "${gateway_unit_src}" ]]; then
    if files_identical_root "${gateway_unit_src}" "${gateway_unit_dst}"; then
      log_ok "Gateway unit up-to-date: ${gateway_unit_dst}"
    else
      run_as_root install -m 644 "${gateway_unit_src}" "${gateway_unit_dst}"
      log_ok "Installed gateway unit: ${gateway_unit_dst}"
      units_changed=1
    fi
  fi

  if [[ -f "${gateway_user_unit_src}" ]]; then
    if files_identical_root "${gateway_user_unit_src}" "${gateway_user_unit_dst}"; then
      log_ok "Gateway per-user unit up-to-date: ${gateway_user_unit_dst}"
    else
      run_as_root install -m 644 "${gateway_user_unit_src}" "${gateway_user_unit_dst}"
      log_ok "Installed gateway per-user unit: ${gateway_user_unit_dst}"
      units_changed=1
    fi
  fi

  # Per-user daemon template (systemd-managed alternative to gateway fork)
  local daemon_template_src="${ROOT_DIR}/templates/system/opencode-user-daemon@.service"
  local daemon_template_dst="/etc/systemd/system/opencode-user-daemon@.service"
  if [[ -f "${daemon_template_src}" ]]; then
    if files_identical_root "${daemon_template_src}" "${daemon_template_dst}"; then
      log_ok "Daemon unit template up-to-date: ${daemon_template_dst}"
    else
      run_as_root install -m 644 "${daemon_template_src}" "${daemon_template_dst}"
      log_ok "Installed per-user daemon unit template: ${daemon_template_dst}"
      units_changed=1
    fi
  else
    log_warn "Per-user daemon unit template not found: ${daemon_template_src}"
  fi

  if [[ -x "${gateway_bin_src}" ]]; then
    run_as_root install -m 755 "${gateway_bin_src}" /usr/local/bin/opencode-gateway
    log_ok "Installed gateway binary: /usr/local/bin/opencode-gateway"
  fi

  if [[ -f "${gateway_login_src}" ]]; then
    run_as_root mkdir -p /usr/local/share/opencode
    run_as_root install -m 644 "${gateway_login_src}" /usr/local/share/opencode/login.html
    log_ok "Installed gateway login page: /usr/local/share/opencode/login.html"
  fi

  if [[ "${units_changed}" -eq 1 ]]; then
    run_as_root systemctl daemon-reload
  fi
  run_as_root systemctl enable "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null
  log_ok "Enabled service: ${SYSTEM_SERVICE_NAME}.service"

  SYSTEM_INIT_DONE=1
}

# ── Legacy cleanup: remove "opencode" service user artifacts ─────────
# Called by system_init() on every install to ensure stale artifacts from
# the old single-process architecture are cleaned up.
_clean_legacy_service_artifacts() {
  # Clean up legacy service artifacts (opencode-web.service, old sudoers, old
  # wrappers) but KEEP the opencode system user — it is now repurposed for
  # file-ownership isolation (DD-4: all product files on customer systems are
  # owned by opencode:opencode for clear permission boundaries).
  local cleaned=0

  # 1. Remove legacy opencode-web.service (ran as User=opencode)
  if run_as_root test -f "/etc/systemd/system/opencode-web.service"; then
    run_as_root systemctl disable --now opencode-web.service 2>/dev/null || true
    run_as_root rm -f /etc/systemd/system/opencode-web.service
    log_ok "Removed legacy unit: opencode-web.service"
    cleaned=1
  fi

  # 2. Remove legacy sudoers policy (old run-as-user pattern, not the new app-install)
  if run_as_root test -f "/etc/sudoers.d/opencode-run-as-user"; then
    run_as_root rm -f /etc/sudoers.d/opencode-run-as-user
    log_ok "Removed legacy sudoers: /etc/sudoers.d/opencode-run-as-user"
    cleaned=1
  fi

  # 3. Remove legacy privilege wrapper (source no longer exists)
  if run_as_root test -f "/usr/local/libexec/opencode-run-as-user"; then
    run_as_root rm -f /usr/local/libexec/opencode-run-as-user
    log_ok "Removed legacy wrapper: /usr/local/libexec/opencode-run-as-user"
    cleaned=1
  fi

  if [[ "${cleaned}" -eq 1 ]]; then
    log_info "Legacy service artifact cleanup complete"
  fi
}

_ensure_opencode_system_user() {
  # DD-4: opencode system account exists purely for file-ownership isolation.
  # It does NOT run any processes — gateway runs as root, per-user daemons run
  # as login users. This account owns /opt/opencode-apps/, /etc/opencode/, and
  # /var/log/opencode/ so customer admins can clearly identify product files.
  local svc_user="opencode"

  if run_as_root id -u "${svc_user}" >/dev/null 2>&1; then
    log_ok "System user '${svc_user}' already exists (uid $(run_as_root id -u "${svc_user}"))"
  else
    run_as_root useradd --system --no-create-home --shell /usr/sbin/nologin "${svc_user}"
    log_ok "Created system user '${svc_user}' for file-ownership isolation"
  fi
}

_ensure_app_directories() {
  local svc_user="opencode"

  # /opt/opencode-apps/ — shared MCP App install directory
  run_as_root install -d -o "${svc_user}" -g "${svc_user}" -m 755 /opt/opencode-apps
  log_ok "App install directory ready: /opt/opencode-apps/ (${svc_user}:${svc_user})"

  # /var/log/opencode/ — system logs
  run_as_root install -d -o "${svc_user}" -g "${svc_user}" -m 755 /var/log/opencode
  log_ok "Log directory ready: /var/log/opencode/ (${svc_user}:${svc_user})"

  # /etc/opencode/ — ownership transfer from root:root to opencode:opencode
  if run_as_root test -d "/etc/opencode"; then
    run_as_root chown -R "${svc_user}:${svc_user}" /etc/opencode
    log_ok "Config directory ownership set: /etc/opencode/ (${svc_user}:${svc_user})"
  fi

  # /etc/opencode/mcp-apps.json — App registry (system-level)
  local mcp_apps_file="/etc/opencode/mcp-apps.json"
  if ! run_as_root test -f "${mcp_apps_file}"; then
    echo '{"version":1,"apps":{}}' | run_as_root tee "${mcp_apps_file}" > /dev/null
    run_as_root chown "${svc_user}:${svc_user}" "${mcp_apps_file}"
    run_as_root chmod 0644 "${mcp_apps_file}"
    log_ok "Initialized MCP App registry: ${mcp_apps_file}"
  fi
}

_install_app_sudo_wrapper() {
  # Sudo wrapper: allows per-user daemons (via system-manager MCP) to install,
  # remove, and register MCP Apps in /opt/opencode-apps/ without root shell.
  local wrapper_src="${ROOT_DIR}/templates/system/opencode-app-install.sh"
  local wrapper_dst="/usr/local/bin/opencode-app-install"
  local sudoers_file="/etc/sudoers.d/opencode-app-install"

  if [[ ! -f "${wrapper_src}" ]]; then
    log_warn "App install wrapper source not found: ${wrapper_src} (skipping)"
    return
  fi

  if files_identical_root "${wrapper_src}" "${wrapper_dst}"; then
    log_ok "App install wrapper up-to-date: ${wrapper_dst}"
  else
    run_as_root install -m 755 "${wrapper_src}" "${wrapper_dst}"
    log_ok "Installed App install wrapper: ${wrapper_dst}"
  fi

  # Sudoers: ALL users can invoke this specific wrapper without password
  local sudoers_content="ALL ALL=(root) NOPASSWD: ${wrapper_dst}"
  if run_as_root test -f "${sudoers_file}"; then
    local existing
    existing="$(run_as_root cat "${sudoers_file}" 2>/dev/null || true)"
    if [[ "${existing}" == "${sudoers_content}" ]]; then
      log_ok "Sudoers policy up-to-date: ${sudoers_file}"
      return
    fi
  fi
  echo "${sudoers_content}" | run_as_root tee "${sudoers_file}" > /dev/null
  run_as_root chmod 0440 "${sudoers_file}"
  log_ok "Installed sudoers policy: ${sudoers_file}"
}

start_system_service_if_ready() {
  if [[ "${SYSTEM_INIT_DONE}" -ne 1 ]]; then
    return
  fi

  if [[ "${ASSUME_YES}" -eq 1 ]] || confirm "Start ${SYSTEM_SERVICE_NAME}.service now?"; then
    run_as_root systemctl restart "${SYSTEM_SERVICE_NAME}.service"
    run_as_root systemctl --no-pager status "${SYSTEM_SERVICE_NAME}.service" || true
  else
    log_warn "Service not started yet. Use: sudo systemctl start ${SYSTEM_SERVICE_NAME}.service"
  fi
}

install_bun_if_needed() {
  if command -v bun >/dev/null 2>&1; then
    log_ok "Bun already installed: $(bun --version)"
    return
  fi

  log_info "Installing Bun..."
  ensure_command curl "Please install curl first."
  curl -fsSL https://bun.sh/install | bash

  export BUN_INSTALL="${HOME}/.bun"
  export PATH="${BUN_INSTALL}/bin:${PATH}"

  if ! command -v bun >/dev/null 2>&1; then
    log_err "Bun installed but not found in current PATH."
    log_warn "Please run: source ~/.bashrc (or restart shell), then rerun ./install.sh"
    exit 1
  fi

  log_ok "Bun installed: $(bun --version)"
}

install_system_packages() {
  if [[ "${SKIP_SYSTEM}" -eq 1 ]]; then
    log_warn "Skipping system package installation (--skip-system)."
    return
  fi

  local os
  os="$(uname -s)"

  linux_deps_ready() {
    command -v git >/dev/null 2>&1 || return 1
    command -v curl >/dev/null 2>&1 || return 1
    command -v unzip >/dev/null 2>&1 || return 1
    command -v xz >/dev/null 2>&1 || return 1
    command -v jq >/dev/null 2>&1 || return 1
    command -v pkg-config >/dev/null 2>&1 || return 1
    command -v cc >/dev/null 2>&1 || return 1
    pkg-config --exists openssl >/dev/null 2>&1 || [[ -f "/usr/include/openssl/ssl.h" ]] || return 1
    return 0
  }

  if [[ "${os}" == "Darwin" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      log_warn "Homebrew not found. Install from https://brew.sh if you want auto package setup on macOS."
      return
    fi
    log_info "Installing macOS dependencies via Homebrew..."
    brew update || true
    brew install git curl jq || true
    if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
      brew install rustup-init || true
      if ! command -v cargo >/dev/null 2>&1; then
        rustup-init -y || true
      fi
    fi
    return
  fi

  if [[ "${os}" != "Linux" ]]; then
    log_warn "Unsupported OS for auto system package setup: ${os}. Continuing..."
    return
  fi

  if linux_deps_ready; then
    log_ok "Required Linux dependencies already present; skipping system package installation."
    return
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    log_warn "sudo not found; skipping system package installation."
    log_warn "Re-run with --skip-system after manually installing required dependencies."
    return
  fi

  if ! sudo -n true >/dev/null 2>&1; then
    log_warn "sudo non-interactive escalation unavailable; skipping system package installation."
    log_warn "This is expected in restricted environments (e.g. no_new_privileges)."
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    log_info "Installing Linux dependencies via apt-get..."
    sudo apt-get update
    sudo apt-get install -y git curl unzip xz-utils ca-certificates build-essential pkg-config libssl-dev jq
    if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
      sudo apt-get install -y rustup || true
      sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf || true
      if ! command -v cargo >/dev/null 2>&1; then
        rustup-init -y || true
      fi
    fi
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    log_info "Installing Linux dependencies via dnf..."
    sudo dnf install -y git curl unzip xz jq openssl-devel pkgconf-pkg-config
    sudo dnf groupinstall -y "Development Tools" || true
    if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
      sudo dnf install -y rustup || true
      sudo dnf install -y gtk3-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel || true
      if ! command -v cargo >/dev/null 2>&1; then
        rustup-init -y || true
      fi
    fi
    return
  fi

  if command -v pacman >/dev/null 2>&1; then
    log_info "Installing Linux dependencies via pacman..."
    sudo pacman -Sy --noconfirm git curl unzip xz jq base-devel pkgconf openssl
    if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
      sudo pacman -S --noconfirm rustup gtk3 webkit2gtk libayatana-appindicator librsvg || true
      if ! command -v cargo >/dev/null 2>&1; then
        rustup default stable || true
      fi
    fi
    return
  fi

  log_warn "No supported package manager detected (apt/dnf/pacman/brew)."
  log_warn "Please install required system packages manually."
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --with-desktop) WITH_DESKTOP=1 ;;
      --skip-system) SKIP_SYSTEM=1 ;;
      --system-init) SYSTEM_INIT=1 ;;
      --service-user)
        # Deprecated: legacy flag, ignored. Gateway runs as root; per-user
        # daemons run as the actual login user. No service account needed.
        log_warn "--service-user is deprecated and ignored (gateway architecture uses root + per-user setuid)"
        shift  # consume the value argument
        ;;
      --service-name)
        shift
        SYSTEM_SERVICE_NAME="${1:-}"
        if [[ -z "${SYSTEM_SERVICE_NAME}" ]]; then
          log_err "--service-name requires a value"
          exit 1
        fi
        ;;
      --yes|-y) ASSUME_YES=1 ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        log_err "Unknown option: $1"
        usage
        exit 1
        ;;
    esac
    shift
  done

  if [[ ! -f "${ROOT_DIR}/package.json" || ! -d "${ROOT_DIR}/packages" ]]; then
    log_err "Please run this script from the opencode repository root."
    exit 1
  fi

  ensure_clean_repo_deploy_source

  log_info "OpenCode bootstrap starting..."

  if ! confirm "Proceed with environment preparation?"; then
    log_warn "Aborted by user."
    exit 0
  fi

  if [[ "${SYSTEM_INIT}" -eq 0 ]] && [[ "$(uname -s)" == "Linux" ]] && [[ "${ASSUME_YES}" -eq 0 ]]; then
    if confirm "Also initialize Linux system service (recommended for PAM multi-user deployments)?"; then
      SYSTEM_INIT=1
    fi
  fi

  install_system_packages
  install_bun_if_needed

  export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
  export PATH="${BUN_INSTALL}/bin:${PATH}"

  ensure_command bun "Bun is required to continue."

  local lock_hash_file="${ROOT_DIR}/node_modules/.lock-hash"
  local current_lock_hash=""
  if [[ -f "${ROOT_DIR}/bun.lock" ]]; then
    current_lock_hash="$(sha256sum "${ROOT_DIR}/bun.lock" | awk '{print $1}')"
  fi
  if [[ -n "${current_lock_hash}" && -f "${lock_hash_file}" ]] \
     && [[ "$(cat "${lock_hash_file}")" == "${current_lock_hash}" ]]; then
    log_ok "JS dependencies up-to-date (bun.lock unchanged)."
  else
    log_info "Installing JS dependencies (bun install)..."
    bun install
    if [[ -n "${current_lock_hash}" ]]; then
      echo "${current_lock_hash}" > "${lock_hash_file}"
    fi
  fi

  log_info "Building backend binary (dist/opencode-linux-x64/bin/opencode)..."
  # skip-install to prevent recursive loops as bun install already triggered build.ts
  bun run build --single --skip-install

  if [[ "${SYSTEM_INIT}" -eq 1 ]]; then
    system_init
  fi

  if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
    if command -v cargo >/dev/null 2>&1; then
      log_ok "Rust toolchain detected: $(cargo --version | head -n1)"
    else
      log_warn "Rust toolchain not found. Desktop build may fail until Rust/Tauri prerequisites are installed."
    fi
  fi

  start_system_service_if_ready

  log_ok "Environment bootstrap complete."
  cat <<EOF

Next steps:
  1) TUI (Dev):   bun run dev
  2) Web (Dev):   ./webctl.sh build-frontend && ./webctl.sh dev-start
  3) Desktop:     bun run --cwd packages/desktop tauri dev

System service (Production):
  sudo systemctl status ${SYSTEM_SERVICE_NAME}.service
  sudo systemctl restart ${SYSTEM_SERVICE_NAME}.service

EOF
}

main "$@"
