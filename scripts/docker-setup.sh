#!/bin/bash
# =============================================================================
# Opencode Docker Production Setup Script
# =============================================================================
#
# This script initializes the production environment for running opencode
# in Docker containers. It handles:
#   - Directory structure creation with proper permissions
#   - Binary building (requires bun installed)
#   - Docker image building
#   - Environment configuration
#
# Usage:
#   ./scripts/docker-setup.sh           # Interactive setup
#   ./scripts/docker-setup.sh --all     # Full setup (build + image)
#   ./scripts/docker-setup.sh --dirs    # Only create directories
#   ./scripts/docker-setup.sh --build   # Only build binary
#   ./scripts/docker-setup.sh --image   # Only build Docker image
#
# Prerequisites:
#   - bun (for building the binary)
#   - docker & docker-compose
#   - sudo access (for /opt/opencode directory creation)
#
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
OPENCODE_ROOT="${OPENCODE_ROOT:-/opt/opencode}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

# Use PUID/PGID to avoid conflict with readonly UID/GID bash variables
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_ok() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "$1 is not installed. Please install it first."
        return 1
    fi
    return 0
}

# =============================================================================
# Setup Functions
# =============================================================================

setup_directories() {
    log_info "Creating directory structure at ${OPENCODE_ROOT}..."

    # Check if we need sudo
    if [ ! -w "$(dirname "${OPENCODE_ROOT}")" ]; then
        log_info "Root access required for /opt directory"
        SUDO="sudo"
    else
        SUDO=""
    fi

    # Create directory structure matching Docker container expectations
    # Container uses uid 1000 (ubuntu user renamed to opencode)
    $SUDO mkdir -p "${OPENCODE_ROOT}/config/opencode"
    $SUDO mkdir -p "${OPENCODE_ROOT}/data/bin"
    $SUDO mkdir -p "${OPENCODE_ROOT}/data/log"
    $SUDO mkdir -p "${OPENCODE_ROOT}/cache/opencode"
    $SUDO mkdir -p "${OPENCODE_ROOT}/state/opencode"
    $SUDO mkdir -p "${OPENCODE_ROOT}/logs"

    # Set permissions - CRITICAL: Must match container user (uid 1000)
    log_info "Setting permissions (uid:gid = ${PUID}:${PGID})..."
    $SUDO chown -R "${PUID}:${PGID}" "${OPENCODE_ROOT}"
    $SUDO chmod -R 755 "${OPENCODE_ROOT}"
    $SUDO chmod 700 "${OPENCODE_ROOT}/config"  # Config may contain secrets

    # Create default config if not exists
    CONFIG_FILE="${OPENCODE_ROOT}/config/opencode/opencode.json"
    if [ ! -f "${CONFIG_FILE}" ]; then
        log_info "Creating default configuration..."
        $SUDO tee "${CONFIG_FILE}" > /dev/null << 'EOF'
{
  "$schema": "https://opencode.ai/schemas/opencode.json",
  "instructions": [],
  "disabled_providers": [],
  "experimental": {}
}
EOF
        $SUDO chown "${PUID}:${PGID}" "${CONFIG_FILE}"
    fi

    log_ok "Directory structure created"
}

build_binary() {
    log_info "Building opencode binary..."

    # Check prerequisites
    if ! check_command bun; then
        return 1
    fi

    cd "${PROJECT_DIR}/packages/opencode"

    # Build single binary for linux-x64
    # Note: This creates a glibc-linked binary, so Docker must use glibc-based image (Ubuntu, not Alpine)
    log_info "Running: bun run build --single"
    bun run build --single

    # Verify binary was created
    BINARY_PATH="${PROJECT_DIR}/packages/opencode/dist/opencode-linux-x64/bin/opencode"
    if [ -f "${BINARY_PATH}" ]; then
        log_ok "Binary built successfully: ${BINARY_PATH}"
        ls -lh "${BINARY_PATH}"
    else
        log_error "Binary not found at expected path: ${BINARY_PATH}"
        return 1
    fi

    cd "${PROJECT_DIR}"
}

build_docker_image() {
    log_info "Building Docker image..."

    # Check prerequisites
    if ! check_command docker; then
        return 1
    fi

    cd "${PROJECT_DIR}"

    # Check if binary exists
    BINARY_PATH="packages/opencode/dist/opencode-linux-x64/bin/opencode"
    if [ ! -f "${BINARY_PATH}" ]; then
        log_warn "Binary not found. Building it first..."
        build_binary || return 1
    fi

    # Build Docker image
    # Note: Uses Ubuntu 24.04 (glibc) because the binary is glibc-linked
    # Uses existing ubuntu user (uid 1000) to match host permissions
    log_info "Running: docker build -f Dockerfile.production -t opencode:latest ."
    docker build -f Dockerfile.production -t opencode:latest .

    log_ok "Docker image built successfully"
    docker images opencode:latest
}

setup_env_file() {
    log_info "Setting up environment file..."

    cd "${PROJECT_DIR}"

    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            log_ok "Created .env from .env.example"
            log_warn "Please edit .env and set your configuration values"
        else
            log_error ".env.example not found"
            return 1
        fi
    else
        log_info ".env already exists, skipping"
    fi

    # Ensure .env is in .gitignore
    if ! grep -q "^\.env$" .gitignore 2>/dev/null; then
        echo ".env" >> .gitignore
        log_ok "Added .env to .gitignore"
    fi
}

print_summary() {
    echo ""
    echo "=============================================================="
    echo "                    SETUP COMPLETE"
    echo "=============================================================="
    echo ""
    echo "Directory structure:"
    echo "  ${OPENCODE_ROOT}/"
    echo "  ├── config/opencode/    # Configuration files"
    echo "  │   ├── opencode.json   # Main config"
    echo "  │   ├── auth.json       # API keys (create manually)"
    echo "  │   └── accounts.json   # Multi-account settings"
    echo "  ├── data/               # Persistent data"
    echo "  │   ├── bin/            # Downloaded binaries"
    echo "  │   └── log/            # Application logs"
    echo "  ├── cache/opencode/     # Cache files"
    echo "  ├── state/opencode/     # Runtime state"
    echo "  │   └── model-health.json"
    echo "  └── logs/               # Container logs"
    echo ""
    echo "Important notes:"
    echo "  - Container uses uid ${PUID} (matches host user for volume permissions)"
    echo "  - Binary is glibc-linked, so Docker uses Ubuntu (not Alpine)"
    echo "  - Use PUID/PGID env vars (not UID/GID which are bash read-only)"
    echo ""
    echo "Commands:"
    echo "  ./webctl.sh start      # Start web service on port 1080"
    echo "  ./webctl.sh stop       # Stop the service"
    echo "  ./webctl.sh status     # Check service status"
    echo "  ./webctl.sh logs       # View container logs"
    echo "  ./webctl.sh build      # Rebuild Docker image"
    echo ""
    echo "Or use docker-compose directly:"
    echo "  docker-compose -f docker-compose.production.yml --profile web up -d"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    echo "=============================================================="
    echo "           Opencode Docker Production Setup"
    echo "=============================================================="
    echo ""

    case "${1:-}" in
        --all)
            setup_directories
            build_binary
            build_docker_image
            setup_env_file
            print_summary
            ;;
        --dirs)
            setup_directories
            ;;
        --build)
            build_binary
            ;;
        --image)
            build_docker_image
            ;;
        --env)
            setup_env_file
            ;;
        --help|-h)
            echo "Usage: $0 [option]"
            echo ""
            echo "Options:"
            echo "  --all     Full setup (directories + binary + image + env)"
            echo "  --dirs    Only create directory structure"
            echo "  --build   Only build the binary"
            echo "  --image   Only build Docker image"
            echo "  --env     Only setup .env file"
            echo "  --help    Show this help message"
            echo ""
            echo "Without options, runs interactive setup."
            ;;
        *)
            # Interactive mode
            echo "Select setup options:"
            echo ""
            echo "  1) Full setup (recommended for first time)"
            echo "  2) Create directories only"
            echo "  3) Build binary only"
            echo "  4) Build Docker image only"
            echo "  5) Setup .env file only"
            echo "  6) Exit"
            echo ""
            read -p "Enter choice [1-6]: " choice

            case "$choice" in
                1)
                    setup_directories
                    build_binary
                    build_docker_image
                    setup_env_file
                    print_summary
                    ;;
                2) setup_directories ;;
                3) build_binary ;;
                4) build_docker_image ;;
                5) setup_env_file ;;
                6) exit 0 ;;
                *) log_error "Invalid choice"; exit 1 ;;
            esac
            ;;
    esac
}

main "$@"
