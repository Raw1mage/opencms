#!/bin/bash
# =============================================================================
# Opencode Development Controller
# Runs the backend directly from source for development purposes.
# =============================================================================
#
# Usage:
#   ./webctl.sh <command>
#
# Commands:
#   install           Bootstrap install (default prod: includes systemd service)
#   dev-start, dev-up Start the development server from source
#   dev-stop, dev-down Stop the development server
#   restart           Restart the server (dev)
#   dev-refresh       Build frontend + restart dev server
#   web-start         Start production systemd service
#   web-stop          Stop production systemd service
#   web-restart       Restart production systemd service
#   web-refresh       Rebuild/deploy and restart production service
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
DISPLAY_URL="${OPENCODE_PUBLIC_URL:-http://localhost:${WEB_PORT}}"
PROFILE_SAFE="$(printf '%s' "${OPENCODE_PROFILE}" | tr -c 'A-Za-z0-9._-' '_')"
RUNTIME_TMP_BASE="${XDG_RUNTIME_DIR:-/tmp}"
PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-${PROFILE_SAFE}.pid"
BACKEND_PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-backend-${PROFILE_SAFE}.pid"
FRONTEND_PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-frontend-${PROFILE_SAFE}.pid"
SERVER_LOG_FILE="${RUNTIME_TMP_BASE}/opencode-web-${PROFILE_SAFE}.log"
RESTART_LOCK_FILE="${RUNTIME_TMP_BASE}/opencode-web-restart-${PROFILE_SAFE}.lock"
RESTART_EVENT_LOG="${RUNTIME_TMP_BASE}/opencode-web-restart-${PROFILE_SAFE}.jsonl"
SYSTEM_SERVICE_NAME="${OPENCODE_SYSTEM_SERVICE_NAME:-opencode-web}"

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
        install|dev-start|dev-up|dev-stop|dev-down|restart|dev-refresh|web-refresh|_restart-worker|status|logs|build-frontend|build-binary)
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

    # Prefer non-interactive direct switch only.
    # Do NOT hop through root; keep caller identity model explicit.
    if sudo -n -u "${REPO_OWNER}" -H true >/dev/null 2>&1; then
        exec sudo -n -u "${REPO_OWNER}" -H env "${passthrough_env[@]}" "${PROJECT_ROOT}/webctl.sh" "${cmd}" "$@"
    fi

    log_error "Auto-switch requires direct sudo rights to ${REPO_OWNER}."
    log_error "Current sudo policy/shell restrictions do not allow non-interactive switch in this shell."
    exit 1
}

requires_privileged_command() {
    case "${1:-}" in
        install|web-start|web-stop|web-restart|web-refresh)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

ensure_non_interactive_sudo() {
    local cmd="${1:-}"
    shift || true

    if [ "${cmd}" = "install" ]; then
        case "${1:-}" in
            --help|-h)
                return
                ;;
        esac
    fi

    if ! requires_privileged_command "${cmd}"; then
        return
    fi

    if [ "${EUID}" -eq 0 ]; then
        return
    fi

    if ! command -v sudo >/dev/null 2>&1; then
        log_error "Command '${cmd}' requires sudo, but sudo is not available."
        exit 1
    fi

    if sudo -n true >/dev/null 2>&1; then
        return
    fi

    log_error "Command '${cmd}' requires non-interactive sudo, but current shell cannot escalate privileges."
    log_error "Likely cause: restricted environment (e.g. no_new_privileges) or missing NOPASSWD policy in this context."
    log_info "Run this command from your normal host shell (not restricted sandbox), then retry:"
    log_info "  ./webctl.sh ${cmd}"
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
    echo "  Restart lock: ${RESTART_LOCK_FILE}"
    echo "  Restart log: ${RESTART_EVENT_LOG}"
}

json_escape() {
    local s="${1:-}"
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/}
    printf '%s' "${s}"
}

append_restart_event() {
    local txid="${1:-unknown}"
    local stage="${2:-unknown}"
    local result="${3:-unknown}"
    local detail="${4:-}"
    local mode="${5:-detached}"
    local graceful="${6:-0}"
    local ts
    ts="$(date -Iseconds)"

    printf '{"ts":"%s","txid":"%s","profile":"%s","mode":"%s","graceful":%s,"stage":"%s","result":"%s","pid":%s,"detail":"%s"}\n' \
        "$(json_escape "${ts}")" \
        "$(json_escape "${txid}")" \
        "$(json_escape "${OPENCODE_PROFILE}")" \
        "$(json_escape "${mode}")" \
        "${graceful}" \
        "$(json_escape "${stage}")" \
        "$(json_escape "${result}")" \
        "$$" \
        "$(json_escape "${detail}")" \
        >>"${RESTART_EVENT_LOG}"
}

acquire_restart_lock() {
    local txid="${1:-unknown}"
    local mode="${2:-detached}"
    local graceful="${3:-0}"
    local payload="$$:${txid}:$(date +%s)"

    if ( set -o noclobber; echo "${payload}" > "${RESTART_LOCK_FILE}" ) 2>/dev/null; then
        append_restart_event "${txid}" "lock" "acquired" "restart lock acquired" "${mode}" "${graceful}"
        return 0
    fi

    local holder="unknown"
    if [ -f "${RESTART_LOCK_FILE}" ]; then
        holder="$(tr -d '\n' < "${RESTART_LOCK_FILE}" 2>/dev/null || echo unknown)"
    fi
    append_restart_event "${txid}" "lock" "busy" "restart lock held by ${holder}" "${mode}" "${graceful}"
    log_error "Another restart is already in progress (${holder})."
    return 1
}

release_restart_lock() {
    [ -f "${RESTART_LOCK_FILE}" ] || return 0
    local holder
    holder="$(tr -d '\n' < "${RESTART_LOCK_FILE}" 2>/dev/null || true)"
    case "${holder}" in
        "$$:"*)
            rm -f "${RESTART_LOCK_FILE}"
            ;;
    esac
}

health_is_ready() {
    curl -s "http://localhost:${WEB_PORT}/api/v2/global/health" 2>/dev/null | grep -q '"healthy":true'
}

wait_for_health() {
    local max_attempts="${1:-20}"
    local attempt=0
    while [ "${attempt}" -lt "${max_attempts}" ]; do
        if health_is_ready; then
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    return 1
}

restart_preflight() {
    if [ ! -f "${FRONTEND_DIST}/index.html" ]; then
        return 1
    fi
    if [ "${IS_SOURCE_REPO}" -eq 1 ]; then
        find_bun >/dev/null
        return 0
    fi
    [ -n "${OPENCODE_BIN}" ] && [ -x "${OPENCODE_BIN}" ]
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

run_systemctl() {
    if [ "${EUID}" -eq 0 ]; then
        systemctl "$@"
        return
    fi

    if ! command -v sudo >/dev/null 2>&1; then
        log_error "sudo not found; cannot control system service ${SYSTEM_SERVICE_NAME}."
        exit 1
    fi

    sudo systemctl "$@"
}

# ---------------------------------------------------------------------------
# install (delegates to install.sh)
# ---------------------------------------------------------------------------
do_install() {
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        log_error "install is only available when running from source repo."
        exit 1
    fi

    local installer="${PROJECT_ROOT}/install.sh"
    if [ ! -f "${installer}" ]; then
        log_error "Installer not found: ${installer}"
        exit 1
    fi

    local mode="prod"
    local -a install_args

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --dev)
                mode="dev"
                ;;
            --prod)
                mode="prod"
                ;;
            --with-desktop|--skip-system|--yes|-y)
                install_args+=("$1")
                ;;
            --service-user|--service-name)
                if [ -z "${2:-}" ]; then
                    log_error "$1 requires a value"
                    exit 1
                fi
                install_args+=("$1" "$2")
                shift
                ;;
            --help|-h)
                echo ""
                echo "Usage: ./webctl.sh install [--prod|--dev] [install.sh options]"
                echo ""
                echo "Modes:"
                echo "  --prod   Production bootstrap (default). Adds --system-init automatically."
                echo "  --dev    Development bootstrap. Does not add --system-init."
                echo ""
                echo "Pass-through options: --with-desktop --skip-system --yes/-y --service-user --service-name"
                echo "Examples:"
                echo "  ./webctl.sh install"
                echo "  ./webctl.sh install --dev --skip-system"
                echo "  ./webctl.sh install --prod --service-name opencode-web --yes"
                echo ""
                return 0
                ;;
            *)
                log_error "Unknown install option: $1"
                log_info "Try: ./webctl.sh install --help"
                exit 1
                ;;
        esac
        shift
    done

    log_info "Running bootstrap installer via ${installer} (mode=${mode})"
    if [ "${mode}" = "prod" ]; then
        bash "${installer}" --system-init "${install_args[@]}"
    else
        bash "${installer}" "${install_args[@]}"
    fi
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
# dev-start
# ---------------------------------------------------------------------------
do_dev_start() {
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

        nohup env OPENCODE_ALLOW_GLOBAL_FS_BROWSE="1" OPENCODE_FRONTEND_PATH="${FRONTEND_DIST}" OPENCODE_WEB_NO_OPEN="1" \
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
        nohup env OPENCODE_ALLOW_GLOBAL_FS_BROWSE="1" OPENCODE_FRONTEND_PATH="${FRONTEND_DIST}" OPENCODE_WEB_NO_OPEN="1" \
            "${OPENCODE_BIN}" \
            web --port "${WEB_PORT}" --hostname 0.0.0.0 \
            >"${SERVER_LOG_FILE}" 2>&1 < /dev/null &
    fi

    local pid=$!
    echo "${pid}" > "${PID_FILE}"
    echo "${pid}" > "${BACKEND_PID_FILE}"

    # Wait for health check
    log_info "Waiting for server to be ready..."
    local max_attempts=20

    if ! wait_for_health "${max_attempts}"; then
        log_warn "Server may not be ready yet. Check: ./webctl.sh status"
    else
        log_success "Server started (pid ${pid})"
    fi

    echo ""
    echo "  URL:      ${DISPLAY_URL}"
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
    echo "To stop:       ./webctl.sh dev-stop"
    echo ""
}

# ---------------------------------------------------------------------------
# dev-stop
# ---------------------------------------------------------------------------
do_dev_stop() {
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
# web-start / web-stop / web-restart (production systemd service)
# ---------------------------------------------------------------------------
do_web_start() {
    if ! command -v systemctl >/dev/null 2>&1; then
        log_error "systemctl not found on this system."
        exit 1
    fi

    log_info "Starting production service: ${SYSTEM_SERVICE_NAME}.service"
    run_systemctl start "${SYSTEM_SERVICE_NAME}.service"
    run_systemctl --no-pager status "${SYSTEM_SERVICE_NAME}.service" || true
}

do_web_stop() {
    if ! command -v systemctl >/dev/null 2>&1; then
        log_error "systemctl not found on this system."
        exit 1
    fi

    log_info "Stopping production service: ${SYSTEM_SERVICE_NAME}.service"
    run_systemctl stop "${SYSTEM_SERVICE_NAME}.service"
    run_systemctl --no-pager status "${SYSTEM_SERVICE_NAME}.service" || true
}

do_web_restart() {
    if ! command -v systemctl >/dev/null 2>&1; then
        log_error "systemctl not found on this system."
        exit 1
    fi

    log_info "Restarting production service: ${SYSTEM_SERVICE_NAME}.service"
    run_systemctl restart "${SYSTEM_SERVICE_NAME}.service"
    run_systemctl --no-pager status "${SYSTEM_SERVICE_NAME}.service" || true
}

# ---------------------------------------------------------------------------
# restart
# ---------------------------------------------------------------------------
do_restart() {
    shift || true
    local mode="detached"
    local graceful=1
    local inline_fallback=0

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --inline)
                mode="inline"
                ;;
            --graceful)
                graceful=1
                ;;
            *)
                log_warn "Unknown restart option: $1"
                ;;
        esac
        shift
    done

    local txid
    txid="$(date +%Y%m%dT%H%M%S)-$$"

    if [ "${mode}" = "inline" ] && [ "${OPENCODE_ALLOW_INLINE_RESTART:-0}" != "1" ]; then
        log_warn "Inline restart is disabled by default; falling back to detached graceful restart."
        log_warn "Set OPENCODE_ALLOW_INLINE_RESTART=1 only for explicit maintenance windows."
        mode="detached"
        graceful=1
        inline_fallback=1
    fi

    # Default to detached restart so callers running through the current web
    # session are less likely to be interrupted mid-command when backend stops.
    if [ "${mode}" = "inline" ]; then
        if [ "${graceful}" -eq 1 ]; then
            do_restart_worker --txid "${txid}" --mode "${mode}" --graceful
        else
            do_restart_worker --txid "${txid}" --mode "${mode}"
        fi
        return
    fi

    local restart_log_file="${RUNTIME_TMP_BASE}/opencode-web-restart-${PROFILE_SAFE}.log"
    local worker_pid
    local -a worker_args
    worker_args=("_restart-worker" "--txid" "${txid}" "--mode" "${mode}")
    if [ "${graceful}" -eq 1 ]; then worker_args+=("--graceful"); fi

    if [ "${inline_fallback}" -eq 1 ]; then
        append_restart_event "${txid}" "policy" "fallback" "inline blocked; switched to detached graceful" "${mode}" "${graceful}"
    fi
    append_restart_event "${txid}" "schedule" "started" "restart scheduled in detached worker" "${mode}" "${graceful}"
    nohup "${PROJECT_ROOT}/webctl.sh" "${worker_args[@]}" >"${restart_log_file}" 2>&1 < /dev/null &
    worker_pid=$!

    log_info "Restart scheduled in detached worker (pid ${worker_pid})"
    log_info "Restart TX: ${txid}"
    log_info "Monitor restart log: ${restart_log_file}"
    log_info "Monitor restart events: ${RESTART_EVENT_LOG}"
    log_info "Check result after a few seconds: ./webctl.sh status"
}

# Internal command used by detached restart worker.
do_restart_worker() {
    local txid="unknown"
    local mode="detached"
    local graceful=0

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --txid)
                txid="${2:-unknown}"
                shift
                ;;
            --mode)
                mode="${2:-detached}"
                shift
                ;;
            --graceful)
                graceful=1
                ;;
        esac
        shift
    done

    if ! acquire_restart_lock "${txid}" "${mode}" "${graceful}"; then
        return 1
    fi

    trap 'release_restart_lock' EXIT
    append_restart_event "${txid}" "worker" "started" "restart worker started" "${mode}" "${graceful}"

    if [ "${graceful}" -eq 1 ]; then
        if ! restart_preflight; then
            append_restart_event "${txid}" "preflight" "failed" "preflight failed; keep existing process" "${mode}" "${graceful}"
            log_error "Graceful restart preflight failed; existing server left untouched."
            return 1
        fi
        append_restart_event "${txid}" "preflight" "ok" "preflight passed" "${mode}" "${graceful}"
    fi

    append_restart_event "${txid}" "stop" "started" "stopping current server" "${mode}" "${graceful}"
    do_dev_stop
    append_restart_event "${txid}" "stop" "ok" "current server stopped" "${mode}" "${graceful}"
    sleep 1

    append_restart_event "${txid}" "start" "started" "starting server" "${mode}" "${graceful}"
    do_dev_start

    if wait_for_health 20; then
        append_restart_event "${txid}" "health" "ok" "server healthy" "${mode}" "${graceful}"
        append_restart_event "${txid}" "restart" "ok" "restart complete" "${mode}" "${graceful}"
        return 0
    fi

    append_restart_event "${txid}" "health" "failed" "health check failed after restart" "${mode}" "${graceful}"
    append_restart_event "${txid}" "restart" "failed" "restart ended unhealthy" "${mode}" "${graceful}"
    return 1
}

# ---------------------------------------------------------------------------
# refresh helpers
# ---------------------------------------------------------------------------
do_dev_refresh() {
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        log_error "dev-refresh is only available when running from source repo."
        exit 1
    fi

    log_info "Refreshing dev webapp (build frontend + restart)..."
    do_build_frontend
    do_restart restart --graceful
}

do_web_refresh() {
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        log_info "Standalone mode: running web-restart only."
        do_web_restart
        return
    fi

    log_info "Refreshing production webapp (rebuild/deploy + restart)..."
    if [ "${OPENCODE_WEB_REFRESH_FULL_BOOTSTRAP:-0}" = "1" ]; then
        log_info "Full bootstrap mode enabled (includes system package step)."
        do_install --yes
    else
        log_info "Fast refresh mode: skipping system package step (set OPENCODE_WEB_REFRESH_FULL_BOOTSTRAP=1 to force full bootstrap)."
        do_install --yes --skip-system
    fi
    do_web_restart
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
do_status() {
    echo ""
    echo "=== Opencode Web Server Status ==="
    echo ""

    echo "[Development (webctl PID)]"
    local pid
    local dev_running=0

    if [ -f "${PID_FILE}" ]; then
        pid=$(cat "${PID_FILE}")
        if kill -0 "${pid}" 2>/dev/null; then
            dev_running=1
            echo -e "  Status:   ${GREEN}running${NC} (pid ${pid})"
            echo "  URL:      ${DISPLAY_URL}"
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

    if [ $dev_running -eq 0 ]; then
        echo -e "  Status:   ${RED}stopped${NC}"
        echo "  Run: ./webctl.sh dev-start"
    fi

    echo ""
    echo "[Production (systemd)]"
    if command -v systemctl >/dev/null 2>&1; then
        local prod_status
        prod_status="$(systemctl is-active "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null || true)"
        case "${prod_status}" in
            active)
                echo -e "  Status:   ${GREEN}running${NC} (${SYSTEM_SERVICE_NAME}.service)"
                ;;
            *)
                echo -e "  Status:   ${RED}${prod_status:-unknown}${NC} (${SYSTEM_SERVICE_NAME}.service)"
                echo "  Run: ./webctl.sh web-start"
                ;;
        esac
    else
        echo -e "  Status:   ${YELLOW}systemctl not available${NC}"
    fi

    echo ""
    local health
    health=$(curl -s "http://localhost:${WEB_PORT}/api/v2/global/health" 2>/dev/null || echo "(unreachable)")
    echo "[HTTP Health]"
    echo "  URL:      ${DISPLAY_URL}"
    echo "  Health:   ${health}"
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
    echo "Opencode Development Controller  (source-based, no Docker)"
    echo ""
    echo "Usage: ./webctl.sh <command>"
    echo ""
    echo "Commands:"
    echo "  install           Bootstrap install (prod by default)"
    echo "  dev-start, dev-up Start the development server from source"
    echo "  dev-stop, dev-down Stop the development server"
    echo "  restart           Restart the server (dev)"
    echo "  dev-refresh       Build frontend + restart dev server"
    echo "  web-start         Start production systemd service"
    echo "  web-stop          Stop production systemd service"
    echo "  web-restart       Restart production systemd service"
    echo "  web-refresh       Rebuild/deploy + restart production service"
    echo "  status            Show server status and health"
    echo "  logs              Follow PTY debug log (/tmp/pty-debug.log)"
    echo "  build-frontend    Build packages/app/dist/ (run after frontend changes)"
    echo "  build-binary      Build native binary for current platform"
    echo "  help              Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  OPENCODE_PORT              Port to listen on (default: 1080)"
    echo "  OPENCODE_PUBLIC_URL        Public URL shown in status/start output"
    echo "  OPENCODE_PROFILE           Runtime profile label (default: default)"
    echo "  OPENCODE_ALLOW_INLINE_RESTART  Allow risky inline restart (default: 0)"
    echo "  OPENCODE_AUTO_SWITCH_OWNER Auto-switch to repo owner (default: 1)"
    echo "  OPENCODE_SERVER_HTPASSWD   Path to htpasswd file (recommended)"
    echo "  OPENCODE_SERVER_PASSWORD   Password env fallback"
    echo "  OPENCODE_SERVER_USERNAME   Username for password fallback"
    echo "  OPENCODE_SYSTEM_SERVICE_NAME systemd service basename (default: opencode-web)"
    echo "  OPENCODE_WEB_REFRESH_FULL_BOOTSTRAP 1=web-refresh runs full install incl. system packages"
    echo "  HOME / XDG_*               Set these to isolate runtime state per user/profile"
    echo ""
    echo "Typical workflow:"
    echo "  # First-time bootstrap (production defaults):"
    echo "  ./webctl.sh install --yes"
    echo ""
    echo "  # Development bootstrap (no systemd service init):"
    echo "  ./webctl.sh install --dev --yes"
    echo ""
    echo "  # First time or after frontend source changes:"
    echo "  ./webctl.sh build-frontend"
    echo ""
    echo "  # Start / restart server:"
    echo "  ./webctl.sh dev-start"
    echo "  ./webctl.sh restart              # default: detached + graceful"
    echo "  ./webctl.sh restart --graceful   # explicit (same as default)"
    echo "  ./webctl.sh restart --inline"
    echo "  ./webctl.sh dev-refresh"
    echo ""
    echo "  # Debug PTY:"
    echo "  ./webctl.sh logs"
    echo ""
    echo "  # Production service (systemd):"
    echo "  ./webctl.sh web-start"
    echo "  ./webctl.sh web-stop"
    echo "  ./webctl.sh web-restart"
    echo "  ./webctl.sh web-refresh"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
ensure_repo_owner_identity "$@"
ensure_non_interactive_sudo "$@"

case "${1:-}" in
    install)                do_install "${@:2}" ;;
    dev-start|dev-up)       do_dev_start      ;;
    dev-stop|dev-down)      do_dev_stop       ;;
    dev-refresh)            do_dev_refresh    ;;
    web-start)              do_web_start      ;;
    web-stop)               do_web_stop       ;;
    web-restart)            do_web_restart    ;;
    web-refresh)            do_web_refresh    ;;
    restart)        do_restart "$@"   ;;
    _restart-worker) do_restart_worker "${@:2}" ;;
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
