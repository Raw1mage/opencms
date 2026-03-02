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
    sudo "$@"
    return
  fi

  log_err "This operation requires root (or sudo): $*"
  exit 1
}

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
  if [[ -f "${wrapper_src}" ]]; then
    run_as_root install -d -m 755 "/usr/local/libexec"
    run_as_root install -m 755 "${wrapper_src}" "${wrapper_dst}"
    log_ok "Installed privilege wrapper: ${wrapper_dst}"
  else
    log_warn "Wrapper source not found: ${wrapper_src}"
  fi

  local sudoers_file="/etc/sudoers.d/opencode-run-as-user"
  local tmp_sudoers="/tmp/opencode-run-as-user.sudoers.$$"
  cat >"${tmp_sudoers}" <<EOF
Defaults:${SYSTEM_SERVICE_USER} !requiretty
${SYSTEM_SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/libexec/opencode-run-as-user
EOF
  run_as_root install -m 440 "${tmp_sudoers}" "${sudoers_file}"
  rm -f "${tmp_sudoers}"
  if command -v visudo >/dev/null 2>&1; then
    run_as_root visudo -cf "${sudoers_file}" >/dev/null
  fi
  log_ok "Installed sudoers policy: ${sudoers_file}"

  local env_dir="/etc/opencode"
  local env_file="${env_dir}/opencode.env"
  local env_template="${ROOT_DIR}/templates/system/opencode.env"
  local tmp_env="/tmp/opencode.env.$$"
  run_as_root install -d -m 755 "${env_dir}"
  if run_as_root test -f "${env_file}"; then
    log_ok "Keeping existing env file: ${env_file}"
  else
    if [[ ! -f "${env_template}" ]]; then
      log_err "Missing env template: ${env_template}"
      exit 1
    fi
    cp "${env_template}" "${tmp_env}"
    run_as_root install -m 644 "${tmp_env}" "${env_file}"
    rm -f "${tmp_env}"
    log_ok "Created env file: ${env_file}"
  fi

  local unit_file="/etc/systemd/system/${SYSTEM_SERVICE_NAME}.service"
  local tmp_unit="/tmp/${SYSTEM_SERVICE_NAME}.service.$$"
  cat >"${tmp_unit}" <<EOF
[Unit]
Description=OpenCode Web Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SYSTEM_SERVICE_USER}
Group=${SYSTEM_SERVICE_USER}
WorkingDirectory=${ROOT_DIR}
Environment=HOME=/nonexistent
Environment=OPENCODE_DATA_HOME=/var/lib/opencode
Environment=XDG_CONFIG_HOME=/var/lib/opencode/config
Environment=XDG_DATA_HOME=/var/lib/opencode/data
Environment=XDG_STATE_HOME=/var/lib/opencode/state
Environment=XDG_CACHE_HOME=/var/lib/opencode/cache
Environment=OPENCODE_WEB_NO_OPEN=1
Environment=OPENCODE_ALLOW_GLOBAL_FS_BROWSE=1
Environment=OPENCODE_FRONTEND_PATH=${ROOT_DIR}/packages/app/dist
EnvironmentFile=-/etc/opencode/opencode.env
ExecStart=/usr/bin/env bash -lc 'BUN_BIN="\${OPENCODE_BUN_BIN:-}"; if [[ -z "\${BUN_BIN}" ]]; then BUN_BIN="\$(command -v bun || true)"; fi; if [[ -z "\${BUN_BIN}" && -x "\${HOME}/.bun/bin/bun" ]]; then BUN_BIN="\${HOME}/.bun/bin/bun"; fi; if [[ -z "\${BUN_BIN}" ]]; then echo "bun not found; set OPENCODE_BUN_BIN in /etc/opencode/opencode.env"; exit 1; fi; exec "\${BUN_BIN}" --conditions=browser "${ROOT_DIR}/packages/opencode/src/index.ts" web --port "\${OPENCODE_PORT:-1080}" --hostname "\${OPENCODE_HOSTNAME:-0.0.0.0}"'
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

  run_as_root install -m 644 "${tmp_unit}" "${unit_file}"
  rm -f "${tmp_unit}"
  log_ok "Installed systemd unit: ${unit_file}"

  run_as_root systemctl daemon-reload
  run_as_root systemctl enable "${SYSTEM_SERVICE_NAME}.service"
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

  if ! command -v sudo >/dev/null 2>&1; then
    log_warn "sudo not found; skipping system package installation."
    log_warn "Re-run with --skip-system after manually installing required dependencies."
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

  if [[ "${SYSTEM_INIT}" -eq 1 ]]; then
    system_init
  fi

  install_system_packages
  install_bun_if_needed

  export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
  export PATH="${BUN_INSTALL}/bin:${PATH}"

  ensure_command bun "Bun is required to continue."

  log_info "Installing JS dependencies (bun install)..."
  bun install

  log_info "Building web frontend (packages/app)..."
  bun run --cwd packages/app build

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
  1) TUI:     bun run dev
  2) Web:     ./webctl.sh build-frontend && ./webctl.sh start
  3) Desktop: bun run --cwd packages/desktop tauri dev

System service (if enabled):
  sudo systemctl status ${SYSTEM_SERVICE_NAME}.service
  sudo systemctl restart ${SYSTEM_SERVICE_NAME}.service

EOF
}

main "$@"
