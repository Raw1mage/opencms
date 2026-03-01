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

# Determine if running from source or standalone
if [ -f "${PROJECT_ROOT}/packages/opencode/src/index.ts" ]; then
    IS_SOURCE_REPO=1
    FRONTEND_DIST="${PROJECT_ROOT}/packages/app/dist"
    OPENCODE_BIN=""
    REPO_OWNER="$(stat -c '%U' "${PROJECT_ROOT}" 2>/dev/null || true)"
else
    IS_SOURCE_REPO=0
    # In standalone, expected to be in ~/.local/share/opencode/bin
    XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
    FRONTEND_DIST="${XDG_DATA_HOME}/opencode/frontend"
    OPENCODE_BIN="${PROJECT_ROOT}/opencode"
    if [ ! -x "${OPENCODE_BIN}" ]; then
        OPENCODE_BIN="$(command -v opencode || true)"
    fi
    REPO_OWNER="$(id -un)"
fi

# Load .env file if it exists
ENV_FILE="${PROJECT_ROOT}/.env"
if [ -f "${ENV_FILE}" ]; then
    set -a
    source "${ENV_FILE}"
    set +a
fi

WEB_PORT="${OPENCODE_PORT:-1080}"
FRONTEND_PORT="${OPENCODE_FRONTEND_DEV_PORT:-3000}"
HTPASSWD_PATH="${OPENCODE_SERVER_HTPASSWD:-${HOME}/.config/opencode/.htpasswd}"
OPENCODE_PROFILE="${OPENCODE_PROFILE:-default}"
PROFILE_SAFE="$(printf '%s' "${OPENCODE_PROFILE}" | tr -c 'A-Za-z0-9._-' '_')"
RUNTIME_TMP_BASE="${XDG_RUNTIME_DIR:-/tmp}"
PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-${PROFILE_SAFE}.pid"
BACKEND_PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-backend-${PROFILE_SAFE}.pid"
FRONTEND_PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-frontend-${PROFILE_SAFE}.pid"
SERVER_LOG_FILE="${RUNTIME_TMP_BASE}/opencode-web-${PROFILE_SAFE}.log"

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

is_owner_scoped_command() {
    case "${1:-}" in
        start|up|stop|down|restart|status|logs|build-frontend|build-binary)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

ensure_repo_owner_identity() {
    local cmd="${1:-}"
    shift || true

    if ! is_owner_scoped_command "${cmd}"; then
        return
    fi
    
    if [ "${IS_SOURCE_REPO:-1}" -ne 1 ]; then
        return
    fi

    local current_user
    current_user="$(id -un)"

    if [ -z "${REPO_OWNER}" ] || [ "${REPO_OWNER}" = "${current_user}" ]; then
        return
    fi

    if [ "${OPENCODE_OWNER_SWITCHED:-0}" = "1" ]; then
        log_error "Owner switch loop detected (current=${current_user}, expected=${REPO_OWNER})."
        exit 1
    fi

    if [ "${OPENCODE_AUTO_SWITCH_OWNER:-1}" != "1" ]; then
        log_error "Current user (${current_user}) does not match repo owner (${REPO_OWNER})."
        log_error "Run as repo owner or set OPENCODE_AUTO_SWITCH_OWNER=1 (default) to auto-switch."
        exit 1
    fi

    if ! command -v sudo >/dev/null 2>&1; then
        log_error "sudo not available; cannot auto-switch to repo owner ${REPO_OWNER}."
        exit 1
    fi

    log_warn "Auto-switching execution user: ${current_user} -> ${REPO_OWNER}"

    local -a passthrough_env
    passthrough_env=(
        "OPENCODE_OWNER_SWITCHED=1"
        "OPENCODE_PROFILE=${OPENCODE_PROFILE}"
    )

    if [ -n "${XDG_CONFIG_HOME:-}" ]; then passthrough_env+=("XDG_CONFIG_HOME=${XDG_CONFIG_HOME}"); fi
    if [ -n "${XDG_STATE_HOME:-}" ]; then passthrough_env+=("XDG_STATE_HOME=${XDG_STATE_HOME}"); fi
    if [ -n "${XDG_DATA_HOME:-}" ]; then passthrough_env+=("XDG_DATA_HOME=${XDG_DATA_HOME}"); fi
    if [ -n "${XDG_RUNTIME_DIR:-}" ]; then passthrough_env+=("XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}"); fi

    # Prefer non-interactive direct switch; fall back to root-hop when
    # policy grants NOPASSWD to root but not directly to target user.
    if sudo -n -u "${REPO_OWNER}" -H true >/dev/null 2>&1; then
        exec sudo -n -u "${REPO_OWNER}" -H env "${passthrough_env[@]}" "${PROJECT_ROOT}/webctl.sh" "${cmd}" "$@"
    fi

    if sudo -n -u root true >/dev/null 2>&1; then
        exec sudo -n -u root env "${passthrough_env[@]}" sudo -n -u "${REPO_OWNER}" -H "${PROJECT_ROOT}/webctl.sh" "${cmd}" "$@"
    fi

    log_error "Auto-switch requires sudo rights to ${REPO_OWNER} (directly or via root NOPASSWD)."
    log_error "Current sudo policy does not allow non-interactive switch in this shell."
    exit 1
}

print_auth_mode() {
    if [ -f "${HTPASSWD_PATH}" ]; then
        echo "  Auth: htpasswd (${HTPASSWD_PATH})"
    elif [ -n "${OPENCODE_SERVER_PASSWORD}" ]; then
        echo "  Auth: ${OPENCODE_SERVER_USERNAME:-opencode}:**** (env)"
    else
        log_warn "No auth configured. Set OPENCODE_SERVER_HTPASSWD or OPENCODE_SERVER_PASSWORD."
    fi
}

print_runtime_context() {
    echo "  Profile: ${OPENCODE_PROFILE}"
    echo "  User: $(id -un)"
    echo "  Repo owner: ${REPO_OWNER:-unknown}"
    echo "  HOME: ${HOME}"
    echo "  XDG_CONFIG_HOME: ${XDG_CONFIG_HOME:-${HOME}/.config}"
    echo "  XDG_STATE_HOME: ${XDG_STATE_HOME:-${HOME}/.local/state}"
    echo "  XDG_DATA_HOME: ${XDG_DATA_HOME:-${HOME}/.local/share}"
    echo "  PID file: ${PID_FILE}"
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
    if [ -f "${BACKEND_PID_FILE}" ]; then
        local backend_pid
        backend_pid=$(cat "${BACKEND_PID_FILE}")
        if kill -0 "${backend_pid}" 2>/dev/null; then
            log_info "Stopping existing backend (pid ${backend_pid})..."
            kill "${backend_pid}" 2>/dev/null || true
            sleep 1
        fi
        rm -f "${BACKEND_PID_FILE}"
    fi

    rm -f "${PID_FILE}"

    if [ -f "${FRONTEND_PID_FILE}" ]; then
        local frontend_pid
        frontend_pid=$(cat "${FRONTEND_PID_FILE}")
        if kill -0 "${frontend_pid}" 2>/dev/null; then
            log_info "Stopping existing frontend dev server (pid ${frontend_pid})..."
            kill "${frontend_pid}" 2>/dev/null || true
            sleep 1
        fi
        rm -f "${FRONTEND_PID_FILE}"
    fi

    # Fallback: kill by ports
    local backend_port_pid
    backend_port_pid=$(ss -tlnp 2>/dev/null | grep ":${WEB_PORT} " | grep -oP '(?<=pid=)[0-9]+' | head -1)
    if [ -n "${backend_port_pid}" ]; then
        log_warn "Backend port ${WEB_PORT} still occupied by pid ${backend_port_pid}, killing..."
        kill "${backend_port_pid}" 2>/dev/null || true
        sleep 1
    fi

    local frontend_port_pid
    frontend_port_pid=$(ss -tlnp 2>/dev/null | grep ":${FRONTEND_PORT} " | grep -oP '(?<=pid=)[0-9]+' | head -1)
    if [ -n "${frontend_port_pid}" ]; then
        log_warn "Frontend port ${FRONTEND_PORT} still occupied by pid ${frontend_port_pid}, killing..."
        kill "${frontend_port_pid}" 2>/dev/null || true
        sleep 1
    fi
}

# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------
do_start() {
    if [ ! -f "${FRONTEND_DIST}/index.html" ]; then
        log_error "Frontend dist not found at ${FRONTEND_DIST}"
        if [ "${IS_SOURCE_REPO}" -eq 1 ]; then
            log_info "Run first: ./webctl.sh build-frontend"
        else
            log_info "Frontend should be installed by opencode install script in ${FRONTEND_DIST}"
        fi
        exit 1
    fi

    kill_existing

    if [ "${IS_SOURCE_REPO}" -eq 1 ]; then
        local BUN_BIN
        BUN_BIN="$(find_bun)"
        log_info "Starting server from source on port ${WEB_PORT}..."

        nohup env OPENCODE_ALLOW_GLOBAL_FS_BROWSE="1" OPENCODE_FRONTEND_PATH="${FRONTEND_DIST}" \
            "${BUN_BIN}" --conditions=browser \
            "${PROJECT_ROOT}/packages/opencode/src/index.ts" \
            web --port "${WEB_PORT}" --hostname 0.0.0.0 \
            >"${SERVER_LOG_FILE}" 2>&1 < /dev/null &
    else
        if [ -z "${OPENCODE_BIN}" ] || [ ! -x "${OPENCODE_BIN}" ]; then
            log_error "opencode binary not found. Please install opencode."
            exit 1
        fi
        log_info "Starting standalone server on port ${WEB_PORT}..."
        nohup env OPENCODE_ALLOW_GLOBAL_FS_BROWSE="1" OPENCODE_FRONTEND_PATH="${FRONTEND_DIST}" \
            "${OPENCODE_BIN}" \
            web --port "${WEB_PORT}" --hostname 0.0.0.0 \
            >"${SERVER_LOG_FILE}" 2>&1 < /dev/null &
    fi

    local pid=$!
    echo "${pid}" > "${PID_FILE}"
    echo "${pid}" > "${BACKEND_PID_FILE}"

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
        log_warn "Server may not be ready yet. Check: ./webctl.sh status"
    else
        log_success "Server started (pid ${pid})"
    fi

    echo ""
    echo "  URL:      http://localhost:${WEB_PORT}"
    echo "  PID:      ${pid}"
    if [ "${IS_SOURCE_REPO:-0}" -eq 1 ]; then
        echo "  Source:   ${PROJECT_ROOT}/packages/opencode/src/"
    else
        echo "  Source:   ${OPENCODE_BIN}"
    fi
    echo "  Frontend: ${FRONTEND_DIST}"
    echo "  Server log: ${SERVER_LOG_FILE}"
    print_runtime_context
    print_auth_mode
    echo ""
    echo "PTY debug log: ./webctl.sh logs"
    echo "To stop:       ./webctl.sh stop"
    echo ""
}

# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------
do_stop() {
    local stopped_any=0

    if [ -f "${BACKEND_PID_FILE}" ]; then
        local backend_pid
        backend_pid=$(cat "${BACKEND_PID_FILE}")
        if kill -0 "${backend_pid}" 2>/dev/null; then
            log_info "Stopping backend (pid ${backend_pid})..."
            kill "${backend_pid}" 2>/dev/null || true
            stopped_any=1
        else
            log_warn "Backend PID ${backend_pid} is not running"
        fi
        rm -f "${BACKEND_PID_FILE}"
    fi

    if [ -f "${FRONTEND_PID_FILE}" ]; then
        local frontend_pid
        frontend_pid=$(cat "${FRONTEND_PID_FILE}")
        if kill -0 "${frontend_pid}" 2>/dev/null; then
            log_info "Stopping frontend dev server (pid ${frontend_pid})..."
            kill "${frontend_pid}" 2>/dev/null || true
            stopped_any=1
        else
            log_warn "Frontend PID ${frontend_pid} is not running"
        fi
        rm -f "${FRONTEND_PID_FILE}"
    fi

    # Fallback by ports
    local backend_port_pid
    backend_port_pid=$(ss -tlnp 2>/dev/null | grep ":${WEB_PORT} " | grep -oP '(?<=pid=)[0-9]+' | head -1)
    if [ -n "${backend_port_pid}" ]; then
        log_info "Stopping process on backend port ${WEB_PORT} (pid ${backend_port_pid})..."
        kill "${backend_port_pid}" 2>/dev/null || true
        stopped_any=1
    fi

    local frontend_port_pid
    frontend_port_pid=$(ss -tlnp 2>/dev/null | grep ":${FRONTEND_PORT} " | grep -oP '(?<=pid=)[0-9]+' | head -1)
    if [ -n "${frontend_port_pid}" ]; then
        log_info "Stopping process on frontend port ${FRONTEND_PORT} (pid ${frontend_port_pid})..."
        kill "${frontend_port_pid}" 2>/dev/null || true
        stopped_any=1
    fi

    sleep 1
    if [ "${stopped_any}" -eq 1 ]; then
        log_success "Server stopped"
    else
        log_warn "No running server found"
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
    local pid
    local running=0

    if [ -f "${PID_FILE}" ]; then
        pid=$(cat "${PID_FILE}")
        if kill -0 "${pid}" 2>/dev/null; then
            running=1
            echo -e "  Status:   ${GREEN}running${NC} (pid ${pid})"
            echo "  URL:      http://localhost:${WEB_PORT}"
            if [ "${IS_SOURCE_REPO:-0}" -eq 1 ]; then
                echo "  Source:   ${PROJECT_ROOT}/packages/opencode/src/"
            else
                echo "  Source:   ${OPENCODE_BIN}"
            fi
            echo "  Frontend: ${FRONTEND_DIST}"
            echo "  Server log: ${SERVER_LOG_FILE}"
            print_runtime_context
            local health
            health=$(curl -s "http://localhost:${WEB_PORT}/api/v2/global/health" 2>/dev/null || echo "(unreachable)")
            echo "  Health:   ${health}"
        else
            echo -e "  Status:   ${RED}stale PID (${pid} not running)${NC}"
            rm -f "${PID_FILE}" "${BACKEND_PID_FILE}"
        fi
    fi

    if [ $running -eq 0 ]; then
        echo -e "  Status:   ${RED}stopped${NC}"
        echo "  Run: ./webctl.sh start"
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# logs — follow PTY debug log
# ---------------------------------------------------------------------------
do_logs() {
    local logfile="${RUNTIME_TMP_BASE}/pty-debug-${PROFILE_SAFE}.log"
    local fallback_logfile="/tmp/pty-debug.log"
    if [ ! -f "${logfile}" ] && [ -f "${fallback_logfile}" ]; then
        logfile="${fallback_logfile}"
        log_warn "Using legacy PTY log path: ${logfile}"
    fi
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
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        log_error "build-frontend is only available when running from source repo."
        exit 1
    fi
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
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        log_error "build-binary is only available when running from source repo."
        exit 1
    fi
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
    echo "Usage: ./webctl.sh <command>"
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
    echo "  OPENCODE_PROFILE           Runtime profile label (default: default)"
    echo "  OPENCODE_AUTO_SWITCH_OWNER Auto-switch to repo owner (default: 1)"
    echo "  OPENCODE_SERVER_HTPASSWD   Path to htpasswd file (recommended)"
    echo "  OPENCODE_SERVER_PASSWORD   Password env fallback"
    echo "  OPENCODE_SERVER_USERNAME   Username for password fallback"
    echo "  HOME / XDG_*               Set these to isolate runtime state per user/profile"
    echo ""
    echo "Typical workflow:"
    echo "  # First time or after frontend source changes:"
    echo "  ./webctl.sh build-frontend"
    echo ""
    echo "  # Start / restart server:"
    echo "  ./webctl.sh start"
    echo "  ./webctl.sh restart"
    echo ""
    echo "  # Debug PTY:"
    echo "  ./webctl.sh logs"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
ensure_repo_owner_identity "$@"

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
