#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

WITH_DESKTOP=0
SKIP_SYSTEM=0
ASSUME_YES=0

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

  log_ok "Environment bootstrap complete."
  cat <<'EOF'

Next steps:
  1) TUI:     bun run dev
  2) Web:     ./webctl.sh build-frontend && ./webctl.sh start
  3) Desktop: bun run --cwd packages/desktop tauri dev

EOF
}

main "$@"
