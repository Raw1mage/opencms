
#!/bin/bash
# =============================================================================
# Opencode Web Service Control Script
# =============================================================================
#
# Usage:
#   ./webctl.sh <command>
#
# Commands:
#   deploy  - Full deployment: build all + sync + start (recommended)
#   start   - Start the web service (alias: up)
#   stop    - Stop the web service (alias: down)
#   restart - Restart the web service
#   status  - Show service status
#   logs    - Show service logs (follow mode)
#   build   - Build the Docker image (includes binary + frontend + sync)
#   sync    - Sync config files from home directory
#   shell   - Open a shell in the container
#
# =============================================================================

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env file if exists
ENV_FILE="${SCRIPT_DIR}/.env"
if [ -f "${ENV_FILE}" ]; then
    set -a
    source "${ENV_FILE}"
    set +a
fi
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.production.yml"
PROJECT_NAME="opencode"
CONTAINER_NAME="opencode-web"
WEB_PORT="${OPENCODE_PORT:-1080}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        log_error "Docker is not running. Please start Docker first."
        exit 1
    fi
}

# Check if compose file exists
check_compose() {
    if [ ! -f "${COMPOSE_FILE}" ]; then
        log_error "Compose file not found: ${COMPOSE_FILE}"
        exit 1
    fi
}

# Initialize directories if needed
init_dirs() {
    local OPENCODE_ROOT="${OPENCODE_ROOT:-/opt/opencode}"

    if [ ! -d "${OPENCODE_ROOT}/config" ]; then
        log_warn "Directories not initialized. Creating with sudo..."
        sudo mkdir -p "${OPENCODE_ROOT}/config/opencode"
        sudo mkdir -p "${OPENCODE_ROOT}/data/opencode"
        sudo mkdir -p "${OPENCODE_ROOT}/data/bin"
        sudo mkdir -p "${OPENCODE_ROOT}/data/log"
        sudo mkdir -p "${OPENCODE_ROOT}/cache/opencode"
        sudo mkdir -p "${OPENCODE_ROOT}/state/opencode"
        sudo mkdir -p "${OPENCODE_ROOT}/logs"
        sudo chown -R 1000:1000 "${OPENCODE_ROOT}"
        log_success "Directories created at ${OPENCODE_ROOT}"
    fi

    # Ensure opencode subdirectory exists in data (for accounts.json)
    if [ ! -d "${OPENCODE_ROOT}/data/opencode" ]; then
        log_info "Creating data/opencode directory..."
        sudo mkdir -p "${OPENCODE_ROOT}/data/opencode"
        sudo chown 1000:1000 "${OPENCODE_ROOT}/data/opencode"
    fi

    # Ensure opencode subdirectory exists in state (for model.json)
    if [ ! -d "${OPENCODE_ROOT}/state/opencode" ]; then
        log_info "Creating state/opencode directory..."
        sudo mkdir -p "${OPENCODE_ROOT}/state/opencode"
        sudo chown 1000:1000 "${OPENCODE_ROOT}/state/opencode"
    fi
}

# Build binary locally
do_build_binary() {
    log_info "Building opencode binary..."

    cd "${SCRIPT_DIR}"

    # Check if bun is available
    if ! command -v bun &> /dev/null; then
        log_error "bun is not installed. Please install bun first: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        log_info "Installing dependencies..."
        bun install
    fi

    # Build binary
    bun run build --single

    log_success "Binary built: dist/opencode-linux-x64/bin/opencode"
}

# Build frontend
do_build_frontend() {
    log_info "Building frontend..."

    cd "${SCRIPT_DIR}/packages/app"

    # Check if bun is available
    if ! command -v bun &> /dev/null; then
        log_error "bun is not installed. Please install bun first: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        log_info "Installing frontend dependencies..."
        bun install
    fi

    # Build frontend
    bun run build

    log_success "Frontend built: dist/"
}

# Sync accounts.json to host volume (after container dirs are ready)
do_sync_host_volumes() {
    log_info "Syncing auth files to host volumes..."

    local OPENCODE_ROOT="${OPENCODE_ROOT:-/opt/opencode}"
    local XDG_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
    local XDG_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/opencode"

    # Sync accounts.json
    if [ -f "${XDG_DATA}/accounts.json" ]; then
        if [ -d "${OPENCODE_ROOT}/data/opencode" ]; then
            log_info "  Syncing accounts.json..."
            sudo cp "${XDG_DATA}/accounts.json" "${OPENCODE_ROOT}/data/opencode/"
            sudo chmod 600 "${OPENCODE_ROOT}/data/opencode/accounts.json"
            sudo chown 1000:1000 "${OPENCODE_ROOT}/data/opencode/accounts.json"
            log_success "  accounts.json synced"
        else
            log_warn "  ${OPENCODE_ROOT}/data/opencode does not exist, skipping accounts.json sync"
        fi
    else
        log_warn "  No accounts.json found at ${XDG_DATA}/accounts.json"
    fi

    # Sync mcp-auth.json
    if [ -f "${XDG_DATA}/mcp-auth.json" ]; then
        if [ -d "${OPENCODE_ROOT}/data/opencode" ]; then
            log_info "  Syncing mcp-auth.json..."
            sudo cp "${XDG_DATA}/mcp-auth.json" "${OPENCODE_ROOT}/data/opencode/"
            sudo chmod 600 "${OPENCODE_ROOT}/data/opencode/mcp-auth.json"
            sudo chown 1000:1000 "${OPENCODE_ROOT}/data/opencode/mcp-auth.json"
            log_success "  mcp-auth.json synced"
        fi
    fi

    # Sync model.json
    if [ -f "${XDG_STATE}/model.json" ]; then
        if [ -d "${OPENCODE_ROOT}/state/opencode" ]; then
            log_info "  Syncing model.json..."
            sudo cp "${XDG_STATE}/model.json" "${OPENCODE_ROOT}/state/opencode/"
            sudo chown 1000:1000 "${OPENCODE_ROOT}/state/opencode/model.json"
            log_success "  model.json synced"
        fi
    fi
}

# Sync config files from home directory
do_sync_config() {
    log_info "Syncing config files from home directory..."

    cd "${SCRIPT_DIR}"

    if [ -x "${SCRIPT_DIR}/sync-config.sh" ]; then
        "${SCRIPT_DIR}/sync-config.sh"
        log_success "Config files synced"
    else
        log_error "sync-config.sh not found or not executable"
        exit 1
    fi
}

# Build Docker image
do_build() {
    log_info "Building opencode Docker image..."
    check_docker

    cd "${SCRIPT_DIR}"

    # Check if binary exists, build if not
    if [ ! -f "dist/opencode-linux-x64/bin/opencode" ]; then
        log_warn "Binary not found, building locally first..."
        do_build_binary
    fi

    # Check if frontend exists, build if not
    if [ ! -f "packages/app/dist/index.html" ]; then
        log_warn "Frontend not found, building locally first..."
        do_build_frontend
    fi

    # Sync config files before building image
    do_sync_config

    docker build -f Dockerfile.production -t opencode:latest .

    log_success "Image built successfully"
}

# Full deployment: build everything, sync, and start
do_deploy() {
    log_info "=== Full Deployment ==="
    echo ""

    check_docker
    cd "${SCRIPT_DIR}"

    # Step 1: Initialize host directories
    log_info "[1/7] Initializing host directories..."
    init_dirs

    # Step 2: Build binary
    log_info "[2/7] Building opencode binary..."
    do_build_binary

    # Step 3: Build frontend
    log_info "[3/7] Building frontend..."
    do_build_frontend

    # Step 4: Sync config files to ./config
    log_info "[4/7] Syncing config files..."
    do_sync_config

    # Step 5: Build Docker image
    log_info "[5/7] Building Docker image..."
    docker build -f Dockerfile.production -t opencode:latest .
    log_success "Image built successfully"

    # Step 6: Sync auth files to host volumes
    log_info "[6/7] Syncing auth files to host volumes..."
    do_sync_host_volumes

    # Step 7: Start the service
    log_info "[7/7] Starting service..."
    export OPENCODE_PORT="${WEB_PORT}"
    docker compose -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" --profile web down 2>/dev/null || true
    docker compose -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" --profile web up -d

    # Wait for service to be ready
    log_info "Waiting for service to be ready..."
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${WEB_PORT}/global/health" 2>/dev/null | grep -q "200"; then
            break
        fi
        sleep 1
        attempt=$((attempt + 1))
    done

    echo ""
    log_success "=== Deployment Complete ==="
    echo ""
    echo "  URL: http://localhost:${WEB_PORT}"
    if [ -n "${OPENCODE_SERVER_PASSWORD}" ]; then
        echo "  Auth: ${OPENCODE_SERVER_USERNAME:-opencode}:****"
    else
        log_warn "No password set. Set OPENCODE_SERVER_PASSWORD for security."
    fi
    echo ""
    echo "To view logs:   ./docker/webctl.sh logs"
    echo "To check status: ./docker/webctl.sh status"
    echo ""
}

# Start service
do_start() {
    log_info "Starting opencode web service on port ${WEB_PORT}..."
    check_docker
    check_compose
    init_dirs

    # Export port for compose
    export OPENCODE_PORT="${WEB_PORT}"

    # Check if image exists
    if ! docker image inspect opencode:latest > /dev/null 2>&1; then
        log_warn "Image not found, building..."
        do_build
    fi

    # Start with web profile
    docker compose -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" --profile web up -d

    # Wait for service to be ready
    log_info "Waiting for service to be ready..."
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${WEB_PORT}" 2>/dev/null | grep -q "200\|401\|403"; then
            break
        fi
        sleep 1
        attempt=$((attempt + 1))
    done

    if [ $attempt -eq $max_attempts ]; then
        log_warn "Service may not be fully ready yet"
    fi

    log_success "Opencode web service started"
    echo ""
    echo "  URL: http://localhost:${WEB_PORT}"
    if [ -n "${OPENCODE_SERVER_PASSWORD}" ]; then
        echo "  Auth: ${OPENCODE_SERVER_USERNAME:-opencode}:****"
    else
        log_warn "No password set. Set OPENCODE_SERVER_PASSWORD for security."
    fi
    echo ""
}

# Stop service
do_stop() {
    log_info "Stopping opencode web service..."
    check_docker
    check_compose

    docker compose -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" --profile web down

    log_success "Service stopped"
}

# Restart service
do_restart() {
    do_stop
    sleep 2
    do_start
}

# Show status
do_status() {
    check_docker

    echo ""
    echo "=== Opencode Web Service Status ==="
    echo ""

    # Check if container is running
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        local container_id=$(docker ps -q -f name="${CONTAINER_NAME}")
        local status=$(docker inspect -f '{{.State.Status}}' "${container_id}")
        local health=$(docker inspect -f '{{.State.Health.Status}}' "${container_id}" 2>/dev/null || echo "N/A")
        local started=$(docker inspect -f '{{.State.StartedAt}}' "${container_id}")
        local port=$(docker port "${container_id}" 8080 2>/dev/null | head -1)

        echo -e "  Status:  ${GREEN}${status}${NC}"
        echo -e "  Health:  ${health}"
        echo "  Started: ${started}"
        echo "  Port:    ${port:-N/A}"
        echo ""

        # Resource usage
        echo "=== Resource Usage ==="
        docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}" "${container_id}"
    else
        echo -e "  Status: ${RED}stopped${NC}"
        echo ""
        echo "  Run './docker/webctl.sh start' to start the service"
    fi
    echo ""
}

# Show logs
do_logs() {
    check_docker

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_info "Following logs (Ctrl+C to exit)..."
        docker logs -f "${CONTAINER_NAME}"
    else
        log_error "Container is not running"
        exit 1
    fi
}

# Open shell
do_shell() {
    check_docker

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_info "Opening shell in container..."
        docker exec -it "${CONTAINER_NAME}" /bin/sh
    else
        log_error "Container is not running"
        exit 1
    fi
}

# Show help
do_help() {
    echo ""
    echo "Opencode Web Service Control"
    echo ""
    echo "Usage: ./docker/webctl.sh <command>"
    echo ""
    echo "Commands:"
    echo "  deploy        Full deployment: build binary + frontend + sync + start (recommended)"
    echo "  start, up     Start the web service"
    echo "  stop, down    Stop the web service"
    echo "  restart       Restart the web service"
    echo "  status        Show service status"
    echo "  logs          Show and follow logs"
    echo "  build         Build the Docker image (includes binary + frontend + sync)"
    echo "  sync          Sync config files from home directory"
    echo "  sync-host     Sync auth files to host volumes (after dirs exist)"
    echo "  shell         Open a shell in the container"
    echo "  help          Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  OPENCODE_PORT              Web service port (default: 1080)"
    echo "  OPENCODE_SERVER_PASSWORD   Web UI password"
    echo "  OPENCODE_SERVER_USERNAME   Web UI username (default: opencode)"
    echo "  OPENCODE_ROOT              Data directory (default: /opt/opencode)"
    echo "  WORKSPACE                  Code workspace directory"
    echo "  PROJECTS_DIR               Projects directory (default: ~/projects)"
    echo ""
    echo "First-time deployment:"
    echo "  ./docker/webctl.sh deploy                          # Full deployment (recommended)"
    echo ""
    echo "Examples:"
    echo "  ./docker/webctl.sh start                           # Start on port 1080"
    echo "  OPENCODE_PORT=8080 ./docker/webctl.sh start        # Start on port 8080"
    echo "  OPENCODE_SERVER_PASSWORD=secret ./docker/webctl.sh deploy  # Deploy with password"
    echo ""
}

# Main
case "${1:-}" in
    deploy)
        do_deploy
        ;;
    start|up)
        do_start
        ;;
    stop|down)
        do_stop
        ;;
    restart)
        do_restart
        ;;
    status)
        do_status
        ;;
    logs)
        do_logs
        ;;
    build)
        do_build
        ;;
    sync)
        do_sync_config
        ;;
    sync-host)
        init_dirs
        do_sync_host_volumes
        ;;
    shell)
        do_shell
        ;;
    help|--help|-h|"")
        do_help
        ;;
    *)
        log_error "Unknown command: $1"
        do_help
        exit 1
        ;;
esac
