#!/bin/bash
# =============================================================================
# Opencode Web Service Control Script
# Runs the backend directly from source — no Docker required.
# =============================================================================
#
# Usage:
#   ./webctl.sh <command>
#
# Commands:
#   start, up         Start the server from source
#   stop, down        Stop the server
#   restart           Restart the server
#   status            Show server status and health
#   logs              Follow the PTY debug log (/tmp/pty-debug.log)
#   build-frontend    Build packages/app/dist/ (run after frontend changes)
#   build-binary      Build the native opencode binary (for distribution)
#   help              Show this help message
#
# =============================================================================

set -e

# Configuration — script lives at the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env file if it exists
ENV_FILE="${PROJECT_ROOT}/.env"
if [ -f "${ENV_FILE}" ]; then
    set -a
    source "${ENV_FILE}"
    set +a
fi

WEB_PORT="${OPENCODE_PORT:-1080}"
HTPASSWD_PATH="${OPENCODE_SERVER_HTPASSWD:-${HOME}/.config/opencode/.htpasswd}"
PID_FILE="/tmp/opencode-web.pid"
FRONTEND_DIST="${PROJECT_ROOT}/packages/app/dist"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

print_auth_mode() {
    if [ -f "${HTPASSWD_PATH}" ]; then
        echo "  Auth: htpasswd (${HTPASSWD_PATH})"
    elif [ -n "${OPENCODE_SERVER_PASSWORD}" ]; then
        echo "  Auth: ${OPENCODE_SERVER_USERNAME:-opencode}:**** (env)"
    else
        log_warn "No auth configured. Set OPENCODE_SERVER_HTPASSWD or OPENCODE_SERVER_PASSWORD."
    fi
}

# Locate bun — may not be in PATH in all environments
find_bun() {
    if command -v bun &>/dev/null; then
        command -v bun
        return
    fi
    for candidate in "$HOME/.bun/bin/bun" "/usr/local/bin/bun" "/usr/bin/bun"; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return
        fi
    done
    log_error "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
    exit 1
}

# Kill whatever is currently occupying WEB_PORT (by PID file or port scan)
kill_existing() {
    if [ -f "${PID_FILE}" ]; then
        local pid
        pid=$(cat "${PID_FILE}")
        if kill -0 "${pid}" 2>/dev/null; then
            log_info "Stopping existing server (pid ${pid})..."
            kill "${pid}"
            sleep 1
        fi
        rm -f "${PID_FILE}"
    fi

    # Fallback: kill by port
    local port_pid
    port_pid=$(ss -tlnp 2>/dev/null | grep ":${WEB_PORT} " | grep -oP '(?<=pid=)[0-9]+' | head -1)
    if [ -n "${port_pid}" ]; then
        log_warn "Port ${WEB_PORT} still occupied by pid ${port_pid}, killing..."
        kill "${port_pid}" 2>/dev/null || true
        sleep 1
    fi
}

# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------
do_start() {
    local BUN_BIN
    BUN_BIN="$(find_bun)"

    if [ ! -f "${FRONTEND_DIST}/index.html" ]; then
        log_error "Frontend dist not found at ${FRONTEND_DIST}"
        log_info "Run first: ./docker/webctl.sh build-frontend"
        exit 1
    fi

    kill_existing

    log_info "Starting server from source on port ${WEB_PORT}..."

    OPENCODE_FRONTEND_PATH="${FRONTEND_DIST}" \
        "${BUN_BIN}" --conditions=browser \
        "${PROJECT_ROOT}/packages/opencode/src/index.ts" \
        web --port "${WEB_PORT}" --hostname 0.0.0.0 &

    local pid=$!
    echo "${pid}" > "${PID_FILE}"

    # Wait for health check
    log_info "Waiting for server to be ready..."
    local attempt=0
    local max_attempts=20
    while [ $attempt -lt $max_attempts ]; do
        if curl -s "http://localhost:${WEB_PORT}/api/v2/global/health" 2>/dev/null | grep -q '"healthy":true'; then
            break
        fi
        sleep 1
        attempt=$((attempt + 1))
    done

    if [ $attempt -eq $max_attempts ]; then
        log_warn "Server may not be ready yet. Check: ./docker/webctl.sh status"
    else
        log_success "Server started (pid ${pid})"
    fi

    echo ""
    echo "  URL:      http://localhost:${WEB_PORT}"
    echo "  PID:      ${pid}"
    echo "  Source:   ${PROJECT_ROOT}/packages/opencode/src/"
    echo "  Frontend: ${FRONTEND_DIST}"
    print_auth_mode
    echo ""
    echo "PTY debug log: ./docker/webctl.sh logs"
    echo "To stop:       ./docker/webctl.sh stop"
    echo ""
}

# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------
do_stop() {
    if [ -f "${PID_FILE}" ]; then
        local pid
        pid=$(cat "${PID_FILE}")
        if kill -0 "${pid}" 2>/dev/null; then
            log_info "Stopping server (pid ${pid})..."
            kill "${pid}"
            sleep 1
            log_success "Server stopped"
        else
            log_warn "PID ${pid} is not running"
        fi
        rm -f "${PID_FILE}"
    else
        local port_pid
        port_pid=$(ss -tlnp 2>/dev/null | grep ":${WEB_PORT} " | grep -oP '(?<=pid=)[0-9]+' | head -1)
        if [ -n "${port_pid}" ]; then
            log_info "Stopping process on port ${WEB_PORT} (pid ${port_pid})..."
            kill "${port_pid}" 2>/dev/null || true
            log_success "Server stopped"
        else
            log_warn "No server found on port ${WEB_PORT}"
        fi
    fi
}

# ---------------------------------------------------------------------------
# restart
# ---------------------------------------------------------------------------
do_restart() {
    do_stop
    sleep 1
    do_start
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
do_status() {
    echo ""
    echo "=== Opencode Web Server Status ==="
    echo ""
    if [ -f "${PID_FILE}" ]; then
        local pid
        pid=$(cat "${PID_FILE}")
        if kill -0 "${pid}" 2>/dev/null; then
            echo -e "  Status:   ${GREEN}running${NC} (pid ${pid})"
            echo "  URL:      http://localhost:${WEB_PORT}"
            echo "  Source:   ${PROJECT_ROOT}/packages/opencode/src/"
            echo "  Frontend: ${FRONTEND_DIST}"
            local health
            health=$(curl -s "http://localhost:${WEB_PORT}/api/v2/global/health" 2>/dev/null || echo "(unreachable)")
            echo "  Health:   ${health}"
        else
            echo -e "  Status:   ${RED}stale PID (${pid} not running)${NC}"
            rm -f "${PID_FILE}"
        fi
    else
        echo -e "  Status:   ${RED}stopped${NC}"
        echo "  Run: ./docker/webctl.sh start"
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# logs — follow PTY debug log
# ---------------------------------------------------------------------------
do_logs() {
    local logfile="/tmp/pty-debug.log"
    if [ ! -f "${logfile}" ]; then
        log_warn "No PTY debug log yet at ${logfile}"
        log_info "Start the server and open a terminal tab to generate logs."
        exit 0
    fi
    log_info "Following ${logfile} (Ctrl+C to exit)..."
    tail -f "${logfile}"
}

# ---------------------------------------------------------------------------
# build-frontend
# ---------------------------------------------------------------------------
do_build_frontend() {
    log_info "Building frontend..."

    local BUN_BIN
    BUN_BIN="$(find_bun)"

    cd "${PROJECT_ROOT}/packages/app"

    if [ ! -d "node_modules" ]; then
        log_info "Installing frontend dependencies..."
        "${BUN_BIN}" install
    fi

    "${BUN_BIN}" run build

    log_success "Frontend built: ${FRONTEND_DIST}"
}

# ---------------------------------------------------------------------------
# build-binary  (native standalone binary, for distribution)
# ---------------------------------------------------------------------------
do_build_binary() {
    log_info "Building opencode binary (current platform)..."

    local BUN_BIN
    BUN_BIN="$(find_bun)"

    cd "${PROJECT_ROOT}"

    if [ ! -d "node_modules" ]; then
        log_info "Installing dependencies..."
        "${BUN_BIN}" install
    fi

    "${BUN_BIN}" run build --single

    log_success "Binary built: ${PROJECT_ROOT}/dist/opencode-linux-x64/bin/opencode"
}

# ---------------------------------------------------------------------------
# help
# ---------------------------------------------------------------------------
do_help() {
    echo ""
    echo "Opencode Web Service Control  (source-based, no Docker)"
    echo ""
    echo "Usage: ./docker/webctl.sh <command>"
    echo ""
    echo "Commands:"
    echo "  start, up         Start the server from source"
    echo "  stop, down        Stop the server"
    echo "  restart           Restart the server"
    echo "  status            Show server status and health"
    echo "  logs              Follow PTY debug log (/tmp/pty-debug.log)"
    echo "  build-frontend    Build packages/app/dist/ (run after frontend changes)"
    echo "  build-binary      Build native binary for current platform"
    echo "  help              Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  OPENCODE_PORT              Port to listen on (default: 1080)"
    echo "  OPENCODE_SERVER_HTPASSWD   Path to htpasswd file (recommended)"
    echo "  OPENCODE_SERVER_PASSWORD   Password env fallback"
    echo "  OPENCODE_SERVER_USERNAME   Username for password fallback"
    echo ""
    echo "Typical workflow:"
    echo "  # First time or after frontend source changes:"
    echo "  ./docker/webctl.sh build-frontend"
    echo ""
    echo "  # Start / restart after backend source changes:"
    echo "  ./docker/webctl.sh start"
    echo "  ./docker/webctl.sh restart"
    echo ""
    echo "  # Debug PTY:"
    echo "  ./docker/webctl.sh logs"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
case "${1:-}" in
    start|up)       do_start          ;;
    stop|down)      do_stop           ;;
    restart)        do_restart        ;;
    status)         do_status         ;;
    logs)           do_logs           ;;
    build-frontend) do_build_frontend ;;
    build-binary)   do_build_binary   ;;
    help|--help|-h|"") do_help        ;;
    *)
        log_error "Unknown command: $1"
        do_help
        exit 1
        ;;
esac
