#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

WITH_DESKTOP=0
SKIP_SYSTEM=0
ASSUME_YES=0
SYSTEM_INIT=0
SYSTEM_SERVICE_USER="opencode"
SYSTEM_SERVICE_NAME="opencode-web"
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
  --service-user   Service account name for --system-init (default: opencode)
  --service-name   systemd unit basename for --system-init (default: opencode-web)
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
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    if sudo "$@"; then
      return
    fi

    log_err "sudo failed while running: $*"
    log_warn "If you are in a restricted shell (e.g. no_new_privileges), rerun with --skip-system"
    log_warn "or execute install/deploy from a host shell that allows privilege escalation."
    exit 1
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

detect_nologin_shell() {
  if command -v nologin >/dev/null 2>&1; then
    command -v nologin
    return
  fi
  if [[ -x "/usr/sbin/nologin" ]]; then
    echo "/usr/sbin/nologin"
    return
  fi
  if [[ -x "/sbin/nologin" ]]; then
    echo "/sbin/nologin"
    return
  fi
  echo "/bin/false"
}

system_init() {
  local os
  os="$(uname -s)"

  if [[ "${os}" != "Linux" ]]; then
    log_err "--system-init currently supports Linux only."
    exit 1
  fi

  ensure_command systemctl "systemd is required for --system-init."

  local shell_path
  shell_path="$(detect_nologin_shell)"

  log_info "Initializing system service account: ${SYSTEM_SERVICE_USER}"
  if run_as_root id -u "${SYSTEM_SERVICE_USER}" >/dev/null 2>&1; then
    log_ok "Service user already exists: ${SYSTEM_SERVICE_USER}"
    # Keep service account non-login and home-less (nobody-style)
    run_as_root usermod --home /nonexistent --shell "${shell_path}" "${SYSTEM_SERVICE_USER}" || true
  else
    run_as_root useradd --system --no-create-home --home-dir /nonexistent --shell "${shell_path}" "${SYSTEM_SERVICE_USER}"
    log_ok "Created service user: ${SYSTEM_SERVICE_USER}"
  fi

  log_info "Preparing service runtime directories..."
  run_as_root install -d -m 750 "/var/lib/opencode"
  run_as_root chown -R "${SYSTEM_SERVICE_USER}:${SYSTEM_SERVICE_USER}" "/var/lib/opencode"

  local wrapper_src="${ROOT_DIR}/scripts/opencode-run-as-user.sh"
  local wrapper_dst="/usr/local/libexec/opencode-run-as-user"
  local daemon_launcher_src="${ROOT_DIR}/templates/system/opencode-user-daemon-launch.sh"
  local daemon_launcher_dst="/usr/local/libexec/opencode-user-daemon-launch"
  if [[ -f "${wrapper_src}" ]]; then
    if files_identical_root "${wrapper_src}" "${wrapper_dst}"; then
      log_ok "Privilege wrapper up-to-date: ${wrapper_dst}"
    else
      run_as_root install -d -m 755 "/usr/local/libexec"
      run_as_root install -m 755 "${wrapper_src}" "${wrapper_dst}"
      log_ok "Installed privilege wrapper: ${wrapper_dst}"
    fi
  else
    log_warn "Wrapper source not found: ${wrapper_src}"
  fi

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

  local sudoers_file="/etc/sudoers.d/opencode-run-as-user"
  local tmp_sudoers="/tmp/opencode-run-as-user.sudoers.$$"
  cat >"${tmp_sudoers}" <<EOF
Defaults:${SYSTEM_SERVICE_USER} !requiretty
${SYSTEM_SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/libexec/opencode-run-as-user
${SYSTEM_SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl start opencode-user-daemon@*.service
${SYSTEM_SERVICE_USER} ALL=(root) NOPASSWD: /bin/systemctl start opencode-user-daemon@*.service
EOF
  if files_identical_root "${tmp_sudoers}" "${sudoers_file}"; then
    rm -f "${tmp_sudoers}"
    log_ok "Sudoers policy up-to-date: ${sudoers_file}"
  else
    run_as_root install -m 440 "${tmp_sudoers}" "${sudoers_file}"
    rm -f "${tmp_sudoers}"
    if command -v visudo >/dev/null 2>&1; then
      run_as_root visudo -cf "${sudoers_file}" >/dev/null
    fi
    log_ok "Installed sudoers policy: ${sudoers_file}"
  fi

  local env_dir="/etc/opencode"
  local runtime_cfg_file="${env_dir}/opencode.cfg"
  local runtime_cfg_template="${ROOT_DIR}/templates/system/opencode.cfg"
  local tmp_runtime_cfg="/tmp/opencode.cfg.$$"
  local installed_frontend_path="/usr/local/share/opencode/frontend"
  local runtime_webctl_dst="${env_dir}/webctl.sh"
  local planner_templates_src="${ROOT_DIR}/templates/specs"
  local planner_templates_dst="${env_dir}/specs"
  run_as_root install -d -m 755 "${env_dir}"
  if files_identical_root "${ROOT_DIR}/webctl.sh" "${runtime_webctl_dst}"; then
    log_ok "Runtime web controller up-to-date: ${runtime_webctl_dst}"
  else
    run_as_root install -m 755 "${ROOT_DIR}/webctl.sh" "${runtime_webctl_dst}"
    run_as_root chown -R "${SYSTEM_SERVICE_USER}:${SYSTEM_SERVICE_USER}" "${env_dir}"
    run_as_root chmod 755 "${env_dir}"
    run_as_root chmod g=u "${env_dir}"/*
    log_ok "Installed runtime web controller: ${runtime_webctl_dst}"
  fi

  # Add invoking user to the service group so they can execute
  # scripts in /etc/opencode/ without privilege escalation.
  local invoking_user="${SUDO_USER:-$(whoami)}"
  if [[ "${invoking_user}" != "root" && "${invoking_user}" != "${SYSTEM_SERVICE_USER}" ]]; then
    if ! id -nG "${invoking_user}" 2>/dev/null | grep -qw "${SYSTEM_SERVICE_USER}"; then
      run_as_root usermod -aG "${SYSTEM_SERVICE_USER}" "${invoking_user}"
      log_ok "Added ${invoking_user} to group ${SYSTEM_SERVICE_USER}"
      log_warn "Group change takes effect on next login (or run: newgrp ${SYSTEM_SERVICE_USER})"
    else
      log_ok "${invoking_user} already in group ${SYSTEM_SERVICE_USER}"
    fi
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
    # Check if config already has correct values — skip sed if so
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

  run_as_root install -d -m 755 "/usr/local/share/opencode/frontend"
  if [[ -d "${ROOT_DIR}/packages/app/dist" ]]; then
    if dirs_identical_root "${ROOT_DIR}/packages/app/dist" "/usr/local/share/opencode/frontend"; then
      log_ok "Frontend up-to-date: ${installed_frontend_path}"
    else
      log_info "Installing web frontend to ${installed_frontend_path}..."
      run_as_root cp -r "${ROOT_DIR}/packages/app/dist/"* "/usr/local/share/opencode/frontend/"
      run_as_root chown -R "${SYSTEM_SERVICE_USER}:${SYSTEM_SERVICE_USER}" "/usr/local/share/opencode/frontend"
    fi
  fi

  local unit_file="/etc/systemd/system/${SYSTEM_SERVICE_NAME}.service"
  local tmp_unit="/tmp/${SYSTEM_SERVICE_NAME}.service.$$"
  local daemon_template_src="${ROOT_DIR}/templates/system/opencode-user-daemon@.service"
  local daemon_template_dst="/etc/systemd/system/opencode-user-daemon@.service"
  cat >"${tmp_unit}" <<EOF
[Unit]
Description=OpenCode Web Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SYSTEM_SERVICE_USER}
Group=${SYSTEM_SERVICE_USER}
WorkingDirectory=/var/lib/opencode
Environment=HOME=/nonexistent
Environment=OPENCODE_DATA_HOME=/var/lib/opencode
Environment=XDG_CONFIG_HOME=/var/lib/opencode/config
Environment=XDG_DATA_HOME=/var/lib/opencode/data
Environment=XDG_STATE_HOME=/var/lib/opencode/state
Environment=XDG_CACHE_HOME=/var/lib/opencode/cache
Environment=OPENCODE_LAUNCH_MODE=systemd
EnvironmentFile=-/etc/opencode/opencode.cfg
ExecStart=/usr/local/bin/opencode web --port \$OPENCODE_PORT --hostname \$OPENCODE_HOSTNAME
Restart=on-failure
RestartSec=2
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=/home /var/lib/opencode
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  local units_changed=0
  if files_identical_root "${tmp_unit}" "${unit_file}"; then
    rm -f "${tmp_unit}"
    log_ok "Systemd unit up-to-date: ${unit_file}"
  else
    run_as_root install -m 644 "${tmp_unit}" "${unit_file}"
    rm -f "${tmp_unit}"
    log_ok "Installed systemd unit: ${unit_file}"
    units_changed=1
  fi

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

  if [[ "${units_changed}" -eq 1 ]]; then
    run_as_root systemctl daemon-reload
  fi
  run_as_root systemctl enable "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null
  log_ok "Enabled service: ${SYSTEM_SERVICE_NAME}.service"

  SYSTEM_INIT_DONE=1
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
        shift
        SYSTEM_SERVICE_USER="${1:-}"
        if [[ -z "${SYSTEM_SERVICE_USER}" ]]; then
          log_err "--service-user requires a value"
          exit 1
        fi
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
