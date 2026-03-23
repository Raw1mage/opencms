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
#   stop              Stop active dev / production server(s)
#   flush             Clean orphaned webctl/opencode bun process trees
#   restart           Refresh active dev / production server(s)
#   dev-refresh       Build frontend + restart dev server
#   web-start         Start production systemd service
#   web-stop          Stop production systemd service
#   web-restart       Restart production systemd service
#   web-refresh       Rebuild/deploy and restart production service
#   status            Show server status and health
#   logs              Follow the PTY debug log (/tmp/pty-debug.log)
#   build-frontend    Build packages/app/dist/ (run after frontend changes)
#   build-binary      Build the native opencode binary (for distribution)
#   compile-mcp       Recompile stale internal MCP server binaries
#   compile-gateway   Compile the C root gateway daemon
#   gateway-start     Compile + start the gateway daemon
#   gateway-stop      Stop the gateway daemon
#   gateway-status    Show gateway daemon status
#   daemon-list       List all per-user daemons (alias: daemons)
#   daemon-kill <user> Stop a specific user's daemon (by username or uid)
#   daemon-killall    Stop all per-user daemons
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

OPENCODE_CFG="${OPENCODE_SERVER_CFG:-/etc/opencode/opencode.cfg}"

WEB_PORT="${OPENCODE_PORT:-1080}"
WEB_HOSTNAME="${OPENCODE_HOSTNAME:-0.0.0.0}"
FRONTEND_PORT="${OPENCODE_FRONTEND_DEV_PORT:-3000}"
AUTH_MODE="${OPENCODE_AUTH_MODE:-pam}"
HTPASSWD_PATH="${OPENCODE_SERVER_HTPASSWD:-}"
OPENCODE_PROFILE="${OPENCODE_PROFILE:-default}"
DISPLAY_URL="${OPENCODE_PUBLIC_URL:-http://localhost:${WEB_PORT}}"
FRONTEND_DIST="${FRONTEND_DIST}"

PROFILE_SAFE="$(printf '%s' "${OPENCODE_PROFILE}" | tr -c 'A-Za-z0-9._-' '_')"
RUNTIME_TMP_BASE="${XDG_RUNTIME_DIR:-/tmp}"
PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-${PROFILE_SAFE}.pid"
BACKEND_PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-backend-${PROFILE_SAFE}.pid"
FRONTEND_PID_FILE="${RUNTIME_TMP_BASE}/opencode-web-frontend-${PROFILE_SAFE}.pid"
SERVER_LOG_FILE="${RUNTIME_TMP_BASE}/opencode-web-${PROFILE_SAFE}.log"
RESTART_LOCK_FILE="${RUNTIME_TMP_BASE}/opencode-web-restart-${PROFILE_SAFE}.lock"
RESTART_EVENT_LOG="${RUNTIME_TMP_BASE}/opencode-web-restart-${PROFILE_SAFE}.jsonl"
RESTART_ERROR_LOG_FILE="${RUNTIME_TMP_BASE}/opencode-web-restart-${PROFILE_SAFE}.error.log"
SYSTEM_SERVICE_NAME="${OPENCODE_SYSTEM_SERVICE_NAME:-opencode-gateway}"

load_server_cfg() {
    if [ ! -f "${OPENCODE_CFG}" ]; then
        log_error "Missing server config: ${OPENCODE_CFG}"
        log_info "Run once: ./webctl.sh install --yes"
        exit 1
    fi

    set -a
    source "${OPENCODE_CFG}"
    set +a

    WEB_PORT="${OPENCODE_PORT:-1080}"
    WEB_HOSTNAME="${OPENCODE_HOSTNAME:-0.0.0.0}"
    FRONTEND_PORT="${OPENCODE_FRONTEND_DEV_PORT:-3000}"
    AUTH_MODE="${OPENCODE_AUTH_MODE:-pam}"
    HTPASSWD_PATH="${OPENCODE_SERVER_HTPASSWD:-}"
    DISPLAY_URL="${OPENCODE_PUBLIC_URL:-http://localhost:${WEB_PORT}}"

    if [ -z "${OPENCODE_FRONTEND_PATH:-}" ]; then
        log_error "OPENCODE_FRONTEND_PATH is required in ${OPENCODE_CFG}"
        exit 1
    fi
    FRONTEND_DIST="${OPENCODE_FRONTEND_PATH}"

    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ] && [ -f "${FRONTEND_DIST}/index.html" ]; then
        case "${FRONTEND_DIST}" in
            */projects/*/packages/app/dist)
                local candidate_root
                candidate_root="${FRONTEND_DIST%/packages/app/dist}"
                if [ -f "${candidate_root}/packages/opencode/src/index.ts" ]; then
                    IS_SOURCE_REPO=1
                    PROJECT_ROOT="${candidate_root}"
                    OPENCODE_BIN=""
                    REPO_OWNER="$(stat -c '%U' "${PROJECT_ROOT}" 2>/dev/null || id -un)"
                fi
                ;;
        esac
    fi
}

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

is_restart_logging_command() {
    case "${1:-}" in
        restart|dev-refresh|web-refresh|_restart-worker)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

setup_restart_error_capture() {
    local cmd="${1:-}"

    if ! is_restart_logging_command "${cmd}"; then
        return
    fi

    local log_file="${OPENCODE_RESTART_ERROR_LOG_FILE:-${RESTART_ERROR_LOG_FILE}}"
    mkdir -p "$(dirname "${log_file}")"
    {
        printf '=== %s restart trace ===\n' "$(date -Iseconds)"
        printf 'command: %s\n' "$*"
        printf 'profile: %s\n' "${OPENCODE_PROFILE}"
        printf 'user: %s\n\n' "$(id -un 2>/dev/null || echo unknown)"
    } > "${log_file}"
    exec > >(tee -a "${log_file}") 2>&1
    trap "status=\$?; printf '\n[EXIT] %s\n' \"\${status}\" >> \"${log_file}\"" EXIT
}

ensure_clean_repo_deploy_source() {
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        return
    fi

    if ! command -v git >/dev/null 2>&1; then
        log_error "git not found; cannot verify deploy source cleanliness."
        exit 1
    fi

    local status
    status="$(git -C "${PROJECT_ROOT}" status --short --untracked-files=normal)"
    if [ -n "${status}" ]; then
        log_error "Dirty repo detected; refusing deploy-from-repo operation."
        log_error "Commit/stash/revert changes before running install or web-refresh."
        printf '%s\n' "${status}"
        exit 1
    fi
}

is_owner_scoped_command() {
    case "${1:-}" in
        install|dev-start|dev-up|dev-stop|dev-down|stop|flush|restart|dev-refresh|web-refresh|_restart-worker|status|logs|build-frontend|build-binary|compile-mcp)
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
    local mode="${AUTH_MODE:-pam}"
    case "${mode}" in
        pam)
            echo "  Auth: PAM (${USER})"
            ;;
        htpasswd)
            if [ -n "${HTPASSWD_PATH}" ] && [ -f "${HTPASSWD_PATH}" ]; then
                echo "  Auth: htpasswd (${HTPASSWD_PATH})"
            else
                log_warn "Auth mode=htpasswd but OPENCODE_SERVER_HTPASSWD is missing or file not found."
            fi
            ;;
        legacy)
            if [ -n "${OPENCODE_SERVER_PASSWORD}" ]; then
                echo "  Auth: ${OPENCODE_SERVER_USERNAME:-opencode}:**** (env legacy)"
            else
                log_warn "Auth mode=legacy but OPENCODE_SERVER_PASSWORD is not set."
            fi
            ;;
        auto)
            if [ -n "${HTPASSWD_PATH}" ] && [ -f "${HTPASSWD_PATH}" ]; then
                echo "  Auth: auto -> htpasswd (${HTPASSWD_PATH})"
            elif [ -n "${OPENCODE_SERVER_PASSWORD}" ]; then
                echo "  Auth: auto -> ${OPENCODE_SERVER_USERNAME:-opencode}:**** (env legacy)"
            else
                echo "  Auth: auto -> PAM (${USER})"
            fi
            ;;
        *)
            log_warn "Unknown OPENCODE_AUTH_MODE='${mode}'. Expected: pam|htpasswd|legacy|auto"
            ;;
    esac
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

dev_pid_is_running() {
    local pid=""

    if [ -f "${BACKEND_PID_FILE}" ]; then
        pid="$(cat "${BACKEND_PID_FILE}" 2>/dev/null || true)"
    elif [ -f "${PID_FILE}" ]; then
        pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    fi

    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
        return 0
    fi

    return 1
}

list_orphan_candidates() {
    ps -eo pid=,ppid=,args= 2>/dev/null | awk '
        $2 != 1 { next }
        {
            pid = $1
            $1 = ""
            $2 = ""
            sub(/^[[:space:]]+/, "", $0)
            cmd = $0

            is_webctl = index(cmd, "OPENCODE_LAUNCH_MODE=\"webctl\"") > 0
            is_repo_beta_server = cmd ~ /bun -e / &&
                cmd ~ /\/projects\/opencode[^ ]*\/packages\/opencode\/src\/server\/server\.ts/ &&
                cmd ~ /Server\.listen/
            is_direct_web = cmd ~ /\/packages\/opencode\/src\/index\.ts web/

            if (is_webctl || is_repo_beta_server || is_direct_web) {
                printf "%s\t%s\n", pid, cmd
            }
        }
    '
}

list_orphan_mcp_candidates() {
    ps -eo pid=,ppid=,args= 2>/dev/null | awk '
        $2 != 1 { next }
        {
            pid = $1
            $1 = ""
            $2 = ""
            sub(/^[[:space:]]+/, "", $0)
            cmd = $0

            is_internal_mcp_binary = (cmd ~ /\/usr\/local\/lib\/opencode\/mcp\/(system-manager|refacting-merger|gcp-grounding)( |$)/)
            is_internal_mcp_source = (cmd ~ /\/packages\/mcp\/(system-manager\/src\/index\.ts|refacting-merger\/src\/index\.ts|gcp-grounding\/index\.ts)( |$)/)
            is_memory_mcp = ((cmd ~ /@modelcontextprotocol\/server-memory/) || (cmd ~ /server-memory( |$)/))
            is_filesystem_mcp = ((cmd ~ /@modelcontextprotocol\/server-filesystem/) || (cmd ~ /server-filesystem( |$)/))
            is_fetch_mcp = ((cmd ~ /@modelcontextprotocol\/server-fetch/) || (cmd ~ /server-fetch( |$)/))
            is_sequential_thinking_mcp = ((cmd ~ /@modelcontextprotocol\/server-sequential-thinking/) || (cmd ~ /server-sequential-thinking( |$)/))

            if (is_internal_mcp_binary || is_internal_mcp_source || is_memory_mcp || is_filesystem_mcp || is_fetch_mcp || is_sequential_thinking_mcp) {
                printf "%s\t%s\t%s\n", "mcp", pid, cmd
            }
        }
    '
}

# List ALL MCP processes regardless of ppid (used during restart to ensure
# fresh MCP instances after code changes).
list_all_mcp_processes() {
    ps -eo pid=,args= 2>/dev/null | awk '
        {
            pid = $1
            $1 = ""
            sub(/^[[:space:]]+/, "", $0)
            cmd = $0

            is_internal_mcp_binary = (cmd ~ /\/usr\/local\/lib\/opencode\/mcp\/(system-manager|refacting-merger|gcp-grounding)( |$)/)
            is_internal_mcp_source = (cmd ~ /\/packages\/mcp\/(system-manager\/src\/index\.ts|refacting-merger\/src\/index\.ts|gcp-grounding\/index\.ts)( |$)/)
            is_memory_mcp = ((cmd ~ /@modelcontextprotocol\/server-memory/) || (cmd ~ /server-memory( |$)/))
            is_filesystem_mcp = ((cmd ~ /@modelcontextprotocol\/server-filesystem/) || (cmd ~ /server-filesystem( |$)/))
            is_fetch_mcp = ((cmd ~ /@modelcontextprotocol\/server-fetch/) || (cmd ~ /server-fetch( |$)/))
            is_sequential_thinking_mcp = ((cmd ~ /@modelcontextprotocol\/server-sequential-thinking/) || (cmd ~ /server-sequential-thinking( |$)/))

            if (is_internal_mcp_binary || is_internal_mcp_source || is_memory_mcp || is_filesystem_mcp || is_fetch_mcp || is_sequential_thinking_mcp) {
                printf "%s\t%s\n", pid, cmd
            }
        }
    '
}

# Kill all MCP server processes so the new server spawns fresh instances.
flush_mcp() {
    local candidates
    candidates="$(list_all_mcp_processes || true)"

    if [ -z "${candidates}" ]; then
        log_success "No MCP server processes to flush"
        return 0
    fi

    local count=0
    while IFS=$'\t' read -r pid cmd; do
        [ -n "${pid}" ] || continue
        terminate_process_tree "${pid}" "mcp pid ${pid}"
        count=$((count + 1))
    done <<< "${candidates}"

    log_success "Flushed ${count} MCP server process(es)"
}

# ---------------------------------------------------------------------------
# Internal MCP binary management
# ---------------------------------------------------------------------------
INTERNAL_MCP_INSTALL_DIR="/usr/local/lib/opencode/mcp"

# Registry: name → source entry point (relative to PROJECT_ROOT)
declare -A INTERNAL_MCP_ENTRIES=(
    [system-manager]="packages/mcp/system-manager/src/index.ts"
    [refacting-merger]="packages/mcp/refacting-merger/src/index.ts"
    [gcp-grounding]="packages/mcp/gcp-grounding/index.ts"
)

# Check if any internal MCP binary is stale (source newer than binary)
# and recompile + install as needed.
# Only meaningful in source repo; skipped in standalone mode.
compile_internal_mcp_if_stale() {
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        return 0
    fi

    local BUN_BIN
    BUN_BIN="$(find_bun)"
    local recompiled=0

    for name in "${!INTERNAL_MCP_ENTRIES[@]}"; do
        local src_entry="${PROJECT_ROOT}/${INTERNAL_MCP_ENTRIES[$name]}"
        local bin_path="${INTERNAL_MCP_INSTALL_DIR}/${name}"

        if [ ! -f "${src_entry}" ]; then
            continue
        fi

        local needs_compile=0

        if [ ! -f "${bin_path}" ]; then
            needs_compile=1
            log_info "MCP binary missing: ${name} — will compile"
        else
            # Compare mtime: any source file in the MCP package dir newer than the binary?
            local src_dir
            src_dir="$(dirname "${src_entry}")"
            # Walk up to package root (parent of src/)
            if [ "$(basename "${src_dir}")" = "src" ]; then
                src_dir="$(dirname "${src_dir}")"
            fi

            local newest_src
            newest_src="$(find "${src_dir}" -name '*.ts' -newer "${bin_path}" -print -quit 2>/dev/null || true)"
            if [ -n "${newest_src}" ]; then
                needs_compile=1
                log_info "MCP binary stale: ${name} — source updated (${newest_src})"
            fi
        fi

        if [ "${needs_compile}" -eq 1 ]; then
            local tmp_bin="/tmp/opencode-mcp-${name}-$$"
            log_info "Compiling MCP: ${name}..."
            # Build from /tmp so bun won't pick up project-level bunfig.toml preload
            # (e.g. @opentui/solid/preload is for the main app, not MCP servers)
            if (cd /tmp && "${BUN_BIN}" build --compile --outfile "${tmp_bin}" "${src_entry}") >/dev/null 2>&1; then
                sudo cp "${tmp_bin}" "${bin_path}" && sudo chmod 755 "${bin_path}"
                rm -f "${tmp_bin}"
                log_success "MCP binary installed: ${name} → ${bin_path}"
                recompiled=$((recompiled + 1))
            else
                log_error "MCP compile failed: ${name}"
                rm -f "${tmp_bin}"
            fi
        fi
    done

    if [ "${recompiled}" -gt 0 ]; then
        log_success "Recompiled ${recompiled} MCP binary(ies)"
    fi
}

tracked_dev_pids() {
    local pid_file
    for pid_file in "${BACKEND_PID_FILE}" "${PID_FILE}" "${FRONTEND_PID_FILE}"; do
        if [ -f "${pid_file}" ]; then
            local pid
            pid="$(cat "${pid_file}" 2>/dev/null || true)"
            if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
                printf '%s\n' "${pid}"
            fi
        fi
    done | awk '!seen[$0]++'
}

candidate_tree_contains_tracked_pid() {
    local root_pid="${1:-}"
    [ -n "${root_pid}" ] || return 1

    local tracked
    tracked="$(tracked_dev_pids)"
    [ -n "${tracked}" ] || return 1

    local tree
    tree="$(collect_process_tree_pids "${root_pid}")"
    [ -n "${tree}" ] || return 1

    local pid
    for pid in ${tracked}; do
        if printf '%s\n' "${tree}" | grep -Fxq "${pid}"; then
            return 0
        fi
    done

    return 1
}

list_flushable_orphan_candidates() {
    local raw
    raw="$(list_orphan_candidates || true)"
    [ -n "${raw}" ] || return 0

    while IFS=$'\t' read -r pid cmd; do
        [ -n "${pid}" ] || continue
        if candidate_tree_contains_tracked_pid "${pid}"; then
            continue
        fi
        printf '%s\t%s\n' "${pid}" "${cmd}"
    done <<< "${raw}"
}

list_flushable_orphan_mcp_candidates() {
    list_orphan_mcp_candidates || true
}

list_flushable_orphan_all_candidates() {
    local runtime_lines
    runtime_lines="$(list_flushable_orphan_candidates || true)"
    if [ -n "${runtime_lines}" ]; then
        while IFS=$'\t' read -r pid cmd; do
            [ -n "${pid}" ] || continue
            printf '%s\t%s\t%s\n' "runtime" "${pid}" "${cmd}"
        done <<< "${runtime_lines}"
    fi

    list_flushable_orphan_mcp_candidates
}

count_orphan_candidates() {
    local lines
    lines="$(list_flushable_orphan_candidates || true)"
    if [ -z "${lines}" ]; then
        echo 0
        return
    fi
    printf '%s\n' "${lines}" | wc -l | tr -d ' '
}

count_orphan_mcp_candidates() {
    local lines
    lines="$(list_flushable_orphan_mcp_candidates || true)"
    if [ -z "${lines}" ]; then
        echo 0
        return
    fi
    printf '%s\n' "${lines}" | wc -l | tr -d ' '
}

collect_process_tree_pids() {
    local root_pid="${1:-}"
    [ -n "${root_pid}" ] || return 0

    local all_pids="${root_pid}"
    local frontier="${root_pid}"

    while [ -n "${frontier}" ]; do
        local next=""
        local parent
        for parent in ${frontier}; do
            local children
            children="$(ps -eo pid=,ppid= 2>/dev/null | awk -v p="${parent}" '$2 == p { print $1 }')"
            if [ -n "${children}" ]; then
                local child
                for child in ${children}; do
                    case " ${all_pids} " in
                        *" ${child} "*) ;;
                        *)
                            all_pids="${all_pids} ${child}"
                            next="${next} ${child}"
                            ;;
                    esac
                done
            fi
        done
        frontier="$(printf '%s' "${next}" | xargs 2>/dev/null || true)"
    done

    printf '%s\n' "${all_pids}" | tr ' ' '\n' | awk 'NF' | tac
}

terminate_process_tree() {
    local root_pid="${1:-}"
    local label="${2:-process}"
    [ -n "${root_pid}" ] || return 0

    local -a tree_pids=()
    while IFS= read -r pid; do
        [ -n "${pid}" ] || continue
        tree_pids+=("${pid}")
    done < <(collect_process_tree_pids "${root_pid}")

    if [ "${#tree_pids[@]}" -eq 0 ]; then
        return 0
    fi

    log_info "Stopping ${label} process tree: ${tree_pids[*]}"
    kill -TERM "${tree_pids[@]}" 2>/dev/null || true

    local attempt
    for attempt in 1 2 3; do
        local alive=0
        local pid
        for pid in "${tree_pids[@]}"; do
            if kill -0 "${pid}" 2>/dev/null; then
                alive=1
                break
            fi
        done
        if [ "${alive}" -eq 0 ]; then
            return 0
        fi
        sleep 1
    done

    local -a survivors=()
    local pid
    for pid in "${tree_pids[@]}"; do
        if kill -0 "${pid}" 2>/dev/null; then
            survivors+=("${pid}")
        fi
    done

    if [ "${#survivors[@]}" -gt 0 ]; then
        log_warn "${label} still alive after TERM, escalating to KILL: ${survivors[*]}"
        kill -KILL "${survivors[@]}" 2>/dev/null || true
    fi
}

system_service_is_active() {
    if ! command -v systemctl >/dev/null 2>&1; then
        return 1
    fi

    [ "$(systemctl is-active "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null || true)" = "active" ]
}

system_service_main_pid() {
    if ! system_service_is_active; then
        return 0
    fi

    if ! command -v systemctl >/dev/null 2>&1; then
        return 0
    fi

    local main_pid
    main_pid="$(systemctl show -p MainPID --value "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null || true)"
    if [ -n "${main_pid}" ] && [ "${main_pid}" != "0" ]; then
        printf '%s\n' "${main_pid}"
    fi
}

tree_contains_pid() {
    local root_pid="${1:-}"
    local target_pid="${2:-}"
    [ -n "${root_pid}" ] || return 1
    [ -n "${target_pid}" ] || return 1

    local tree
    tree="$(collect_process_tree_pids "${root_pid}")"
    [ -n "${tree}" ] || return 1
    printf '%s\n' "${tree}" | grep -Fxq "${target_pid}"
}

list_interactive_process_candidates() {
    ps -eo pid=,ppid=,tty=,args= 2>/dev/null | awk '
        {
            pid = $1
            ppid = $2
            tty = $3
            $1 = ""
            $2 = ""
            $3 = ""
            sub(/^[[:space:]]+/, "", $0)
            cmd = $0

            is_runtime = index(cmd, "OPENCODE_LAUNCH_MODE=\"webctl\"") > 0 ||
                cmd ~ /\/packages\/opencode\/src\/index\.ts web( |$)/ ||
                cmd ~ /(^|[[:space:]])([^[:space:]]*\/)?opencode([[:space:]]|$)/

            is_internal_mcp_binary = (cmd ~ /\/usr\/local\/lib\/opencode\/mcp\/(system-manager|refacting-merger|gcp-grounding)( |$)/)
            is_internal_mcp_source = (cmd ~ /\/packages\/mcp\/(system-manager\/src\/index\.ts|refacting-merger\/src\/index\.ts|gcp-grounding\/index\.ts)( |$)/)
            is_memory_mcp = ((cmd ~ /@modelcontextprotocol\/server-memory/) || (cmd ~ /server-memory( |$)/))
            is_filesystem_mcp = ((cmd ~ /@modelcontextprotocol\/server-filesystem/) || (cmd ~ /server-filesystem( |$)/))
            is_fetch_mcp = ((cmd ~ /@modelcontextprotocol\/server-fetch/) || (cmd ~ /server-fetch( |$)/))
            is_sequential_thinking_mcp = ((cmd ~ /@modelcontextprotocol\/server-sequential-thinking/) || (cmd ~ /server-sequential-thinking( |$)/))
            is_mcp = is_internal_mcp_binary || is_internal_mcp_source || is_memory_mcp || is_filesystem_mcp || is_fetch_mcp || is_sequential_thinking_mcp

            if (is_runtime || is_mcp) {
                kind = is_runtime ? "runtime" : "mcp"
                printf "%s\t%s\t%s\t%s\t%s\n", kind, pid, ppid, tty, cmd
            }
        }
    '
}

list_stale_interactive_candidates() {
    local service_main_pid
    service_main_pid="$(system_service_main_pid || true)"

    local raw
    raw="$(list_interactive_process_candidates || true)"
    [ -n "${raw}" ] || return 0

    declare -A kind_map=()
    declare -A ppid_map=()
    declare -A tty_map=()
    declare -A cmd_map=()
    declare -A roots=()

    while IFS=$'\t' read -r kind pid ppid tty cmd; do
        [ -n "${pid}" ] || continue
        kind_map["${pid}"]="${kind}"
        ppid_map["${pid}"]="${ppid}"
        tty_map["${pid}"]="${tty}"
        cmd_map["${pid}"]="${cmd}"
    done <<< "${raw}"

    local pid
    for pid in "${!kind_map[@]}"; do
        local root="${pid}"
        local parent="${ppid_map[$root]:-}"
        while [ -n "${parent}" ] && [ -n "${kind_map[$parent]:-}" ]; do
            root="${parent}"
            parent="${ppid_map[$root]:-}"
        done
        roots["${root}"]=1
    done

    local root
    for root in "${!roots[@]}"; do
        [ -n "${root}" ] || continue

        local root_cmd="${cmd_map[$root]:-}"
        local root_tty="${tty_map[$root]:-?}"
        local root_ppid="${ppid_map[$root]:-}"
        local reasons=()

        if [ -z "${root_cmd}" ]; then
            continue
        fi

        if candidate_tree_contains_tracked_pid "${root}"; then
            continue
        fi

        if [ -n "${service_main_pid}" ] && tree_contains_pid "${root}" "${service_main_pid}"; then
            continue
        fi

        if [[ "${root_cmd}" == *"_restart-worker"* ]]; then
            continue
        fi

        if [ "${root_tty}" != "?" ] && [ "${root_tty}" != "-" ]; then
            continue
        fi

        reasons+=("untracked")
        reasons+=("no-tty")

        if [ "${root_ppid}" = "1" ]; then
            reasons+=("ppid=1")
        else
            reasons+=("detached-from-active-ledger")
        fi

        local reason_csv
        reason_csv="$(IFS=,; printf '%s' "${reasons[*]}")"
        printf '%s\t%s\t%s\t%s\n' "stale-interactive" "${root}" "${reason_csv}" "${root_cmd}"
    done | sort -u
}

count_stale_interactive_candidates() {
    local lines
    lines="$(list_stale_interactive_candidates || true)"
    if [ -z "${lines}" ]; then
        echo 0
        return
    fi
    printf '%s\n' "${lines}" | wc -l | tr -d ' '
}

# ---------------------------------------------------------------------------
# install (delegates to install.sh)
# ---------------------------------------------------------------------------
do_install() {
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        log_error "install is only available when running from source repo."
        exit 1
    fi

    ensure_clean_repo_deploy_source

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
# Set OPENCODE_NO_GATEWAY=1 to bypass the C root gateway and run opencode
# web directly. Useful for single-machine development where PAM auth and
# per-user daemon multiplexing are not needed.
# ---------------------------------------------------------------------------
do_dev_start() {
    load_server_cfg

    if [ ! -f "${FRONTEND_DIST}/index.html" ]; then
        log_error "Frontend dist not found at ${FRONTEND_DIST}"
        if [ "${IS_SOURCE_REPO}" -eq 1 ]; then
            log_info "Run first: ./webctl.sh build-frontend"
        else
            log_info "Frontend should be installed by opencode install script in ${FRONTEND_DIST}"
        fi
        exit 1
    fi

    # Direct mode: skip gateway, run opencode web process directly
    if [ "${OPENCODE_NO_GATEWAY:-0}" = "1" ]; then
        kill_existing
        _dev_start_direct
        return
    fi

    # Gateway mode: switch to dev binary via systemd service
    switch_gateway_mode dev

    echo ""
    echo "  Mode:     dev (from source)"
    echo "  URL:      ${DISPLAY_URL}"
    echo "  Ingress:  C root gateway → per-user daemon (bun)"
    echo "  Source:   ${PROJECT_ROOT}/packages/opencode/src/"
    echo "  Frontend: ${FRONTEND_DIST}"
    echo "  Service:  ${SYSTEM_SERVICE_NAME}.service"
    echo "  Logs:     journalctl -u ${SYSTEM_SERVICE_NAME} -f"
    print_runtime_context
    print_auth_mode
    echo ""
}

# ---------------------------------------------------------------------------
# _dev_start_direct — launch opencode web without the C root gateway
# ---------------------------------------------------------------------------
_dev_start_direct() {
    local BUN_BIN
    BUN_BIN="$(find_bun)"

    local dev_port="${WEB_PORT:-1080}"
    local dev_host="${WEB_HOSTNAME:-0.0.0.0}"

    log_info "Starting opencode web directly on ${dev_host}:${dev_port} (no gateway)..."

    OPENCODE_LAUNCH_MODE=webctl \
    OPENCODE_FRONTEND_PATH="${FRONTEND_DIST}" \
    OPENCODE_WEB_NO_OPEN="${OPENCODE_WEB_NO_OPEN:-1}" \
    OPENCODE_AUTH_MODE="${AUTH_MODE}" \
    nohup "${BUN_BIN}" --conditions=browser \
        "${PROJECT_ROOT}/packages/opencode/src/index.ts" \
        web --port "${dev_port}" --hostname "${dev_host}" \
        >"${GATEWAY_LOG_FILE}" 2>&1 < /dev/null &

    local pid=$!
    echo "${pid}" > "${PID_FILE}"
    echo "${pid}" > "${BACKEND_PID_FILE}"

    # Wait for health check
    log_info "Waiting for server to be ready..."
    local max_attempts=20

    if ! wait_for_health "${max_attempts}"; then
        log_warn "Server may not be ready yet. Check: ./webctl.sh status"
    else
        log_success "Direct opencode web started (pid ${pid})"
    fi

    echo ""
    echo "  URL:      http://${dev_host}:${dev_port}"
    echo "  PID:      ${pid}"
    echo "  Ingress:  direct (no gateway)"
    if [ "${IS_SOURCE_REPO:-0}" -eq 1 ]; then
        echo "  Source:   ${PROJECT_ROOT}/packages/opencode/src/"
    else
        echo "  Source:   ${OPENCODE_BIN}"
    fi
    echo "  Frontend: ${FRONTEND_DIST}"
    echo "  Log:      ${GATEWAY_LOG_FILE}"
    print_runtime_context
    print_auth_mode
    echo ""
    echo "PTY debug log: ./webctl.sh logs"
    echo "To stop:       ./webctl.sh stop"
    echo ""
}

# ---------------------------------------------------------------------------
# dev-stop
# ---------------------------------------------------------------------------
do_dev_stop() {
    load_server_cfg

    local stopped_any=0

    if [ -f "${GATEWAY_PID_FILE}" ]; then
        local gateway_pid
        gateway_pid=$(cat "${GATEWAY_PID_FILE}")
        if kill -0 "${gateway_pid}" 2>/dev/null; then
            stop_gateway
            stopped_any=1
        else
            rm -f "${GATEWAY_PID_FILE}"
        fi
    fi

    if [ -f "${BACKEND_PID_FILE}" ]; then
        local backend_pid
        backend_pid=$(cat "${BACKEND_PID_FILE}")
        if ! kill -0 "${backend_pid}" 2>/dev/null; then
            log_warn "Backend PID ${backend_pid} is not running"
        fi
        rm -f "${BACKEND_PID_FILE}"
    fi

    rm -f "${PID_FILE}"

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

    do_daemon_killall >/dev/null 2>&1 || true

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
    load_server_cfg

    # Production mode: switch to installed binary via systemd service
    switch_gateway_mode prod

    echo ""
    echo "  Mode:     prod (installed binary)"
    echo "  URL:      ${DISPLAY_URL}"
    echo "  Ingress:  C root gateway → per-user daemon (/usr/local/bin/opencode)"
    echo "  Frontend: ${FRONTEND_DIST}"
    echo "  Service:  ${SYSTEM_SERVICE_NAME}.service"
    echo "  Logs:     journalctl -u ${SYSTEM_SERVICE_NAME} -f"
    print_runtime_context
    print_auth_mode
    echo ""
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
# stop / restart
# ---------------------------------------------------------------------------
do_stop() {
    load_server_cfg

    local dev_running=0
    local prod_running=0
    local handled=0

    if dev_pid_is_running; then
        dev_running=1
    fi

    if system_service_is_active; then
        prod_running=1
    fi

    if [ "${dev_running}" -eq 1 ]; then
        do_dev_stop
        handled=1
    fi

    if [ "${prod_running}" -eq 1 ]; then
        ensure_non_interactive_sudo web-stop
        do_web_stop
        handled=1
    fi

    # Also kill daemons and flush orphan processes
    do_daemon_killall
    do_flush

    if [ "${handled}" -eq 0 ]; then
        log_warn "No active dev or production server found (daemons/orphans still cleaned)"
    fi
}

do_flush() {
    local dry_run=0

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --dry-run|--list)
                dry_run=1
                ;;
            *)
                log_warn "Unknown flush option: $1"
                ;;
        esac
        shift
    done

    local candidates
    candidates="$(list_stale_interactive_candidates || true)"

    echo ""
    echo "=== webctl stale interactive runtime flush ==="
    echo ""

    if [ -z "${candidates}" ]; then
        log_success "No stale interactive opencode/MCP candidates found"
        return 0
    fi

    echo "${candidates}" | while IFS=$'\t' read -r class pid reasons cmd; do
        printf '  class=%s pid=%s reasons=%s cmd=%s\n' "${class}" "${pid}" "${reasons}" "${cmd}"
    done

    if [ "${dry_run}" -eq 1 ]; then
        echo ""
        log_info "Dry run only. Re-run without --dry-run to terminate the stale process trees above."
        return 0
    fi

    local count=0
    while IFS=$'\t' read -r class pid reasons cmd; do
        [ -n "${pid}" ] || continue
        terminate_process_tree "${pid}" "${class} pid ${pid} (${reasons})"
        count=$((count + 1))
    done <<< "${candidates}"

    rm -f "${PID_FILE}" "${BACKEND_PID_FILE}"

    echo ""
    log_success "Flushed ${count} stale interactive process tree(s)"
}

do_dev_restart() {
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
    txid="${OPENCODE_RESTART_TXID:-$(date +%Y%m%dT%H%M%S)-$$}"

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

    local restart_log_file="${RUNTIME_TMP_BASE}/opencode-web-restart-${PROFILE_SAFE}-${txid}.log"
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
    log_info "Monitor restart error log: ${OPENCODE_RESTART_ERROR_LOG_FILE:-${RESTART_ERROR_LOG_FILE}}"
    log_info "Monitor restart events: ${RESTART_EVENT_LOG}"
    log_info "Check result after a few seconds: ./webctl.sh status"
}

do_restart() {
    load_server_cfg

    # Detect current mode from cfg
    local current_bin
    current_bin="$(grep '^OPENCODE_BIN=' "${OPENCODE_CFG}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
    local mode="prod"
    if echo "${current_bin}" | grep -q 'bun\|index\.ts'; then
        mode="dev"
    fi

    log_info "Restarting in ${mode} mode..."

    # 1. Rebuild frontend if source repo available
    if [ "${IS_SOURCE_REPO:-0}" -eq 1 ]; then
        log_info "Building frontend..."
        do_build_frontend
        sync_frontend_dist_if_needed
    fi

    # 2. Recompile gateway if source changed
    local gateway_changed=0
    if [ "${IS_SOURCE_REPO:-0}" -eq 1 ] && [ -f "${GATEWAY_SRC}" ]; then
        if [ ! -f "${GATEWAY_INSTALL_BIN}" ] || [ "${GATEWAY_SRC}" -nt "${GATEWAY_INSTALL_BIN}" ]; then
            compile_gateway
            log_info "Installing gateway binary to ${GATEWAY_INSTALL_BIN}..."
            sudo cp "${GATEWAY_BIN}" "${GATEWAY_INSTALL_BIN}"
            gateway_changed=1
        else
            log_info "Gateway binary up-to-date, skipping recompile"
        fi
    fi

    # 3. Prod mode: rebuild opencode binary if source changed
    if [ "${mode}" = "prod" ] && [ "${IS_SOURCE_REPO:-0}" -eq 1 ]; then
        if [ ! -x "/usr/local/bin/opencode" ] || \
           [ "$(find packages/opencode/src -newer /usr/local/bin/opencode -print -quit 2>/dev/null)" ]; then
            log_info "Source changed, rebuilding opencode binary..."
            do_build_binary
            sudo cp "$(ls -t packages/opencode/dist/opencode-* 2>/dev/null | head -1)" /usr/local/bin/opencode 2>/dev/null || \
                log_warn "Binary build/install skipped (no dist output found)"
        else
            log_info "Opencode binary up-to-date, skipping rebuild"
        fi
    fi

    # 4. Compile stale MCP servers
    compile_internal_mcp_if_stale 2>/dev/null || true

    # 5. Restart gateway service if binary changed
    if [ "${gateway_changed}" -eq 1 ]; then
        log_info "Gateway binary updated, restarting service..."
        sudo systemctl restart "${SYSTEM_SERVICE_NAME}.service"
        sleep 1
    fi

    # 6. Kill per-user daemons — they respawn with fresh code on next request
    log_info "Killing per-user daemons..."
    do_daemon_killall

    # Verify gateway is healthy
    if system_service_is_active; then
        log_success "Restart complete (${mode} mode). Per-user daemons will respawn on next request."
    else
        log_warn "Gateway service not active. Starting..."
        sudo systemctl start "${SYSTEM_SERVICE_NAME}.service"
    fi
}

# Internal command used by detached restart worker.
do_restart_worker() {
    local txid="unknown"
    local mode="detached"
    local graceful=0

    load_server_cfg

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

    append_restart_event "${txid}" "mcp-flush" "started" "flushing MCP servers for code reload" "${mode}" "${graceful}"
    flush_mcp
    append_restart_event "${txid}" "mcp-flush" "ok" "MCP servers flushed" "${mode}" "${graceful}"

    append_restart_event "${txid}" "flush" "started" "flushing orphan candidates after stop" "${mode}" "${graceful}"
    if do_flush; then
        append_restart_event "${txid}" "flush" "ok" "flush completed" "${mode}" "${graceful}"
    else
        append_restart_event "${txid}" "flush" "failed" "flush failed; aborting restart" "${mode}" "${graceful}"
        return 1
    fi

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
    # Unified: delegate to do_restart which handles both modes
    do_restart
}

sync_frontend_dist_if_needed() {
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        return 0
    fi

    local source_dist
    source_dist="${PROJECT_ROOT}/packages/app/dist"

    if [ "${FRONTEND_DIST}" = "${source_dist}" ]; then
        return 0
    fi

    if [ ! -f "${source_dist}/index.html" ]; then
        log_error "Source frontend dist missing at ${source_dist}; run ./webctl.sh build-frontend first."
        return 1
    fi

    if ! command -v rsync >/dev/null 2>&1; then
        log_error "rsync is required to sync frontend dist to ${FRONTEND_DIST}."
        return 1
    fi

    log_info "Syncing frontend dist: ${source_dist} -> ${FRONTEND_DIST}"
    mkdir -p "${FRONTEND_DIST}" || {
        log_error "Failed to prepare frontend target directory: ${FRONTEND_DIST}"
        return 1
    }

    if ! rsync -a --delete "${source_dist}/" "${FRONTEND_DIST}/"; then
        log_error "Frontend sync failed: ${source_dist} -> ${FRONTEND_DIST}"
        return 1
    fi

    log_success "Frontend synced to ${FRONTEND_DIST}"
}

do_web_refresh() {
    # Unified: delegate to do_restart which handles both modes
    do_restart
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
do_status() {
    load_server_cfg

    echo ""
    echo "=== Opencode Web Server Status ==="
    echo ""

    echo "[Development (webctl PID)]"
    local pid
    local dev_running=0

    if [ -f "${PID_FILE}" ]; then
        pid=$(cat "${PID_FILE}" 2>/dev/null || true)
        if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
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
            echo -e "  Status:   ${RED}stale PID (${pid:-missing} not running)${NC}"
            rm -f "${PID_FILE}" "${BACKEND_PID_FILE}"
        fi
    fi

    if [ $dev_running -eq 0 ]; then
        echo -e "  Status:   ${RED}stopped${NC}"
        echo "  Run: ./webctl.sh dev-start"
    fi

    local stale_count
    stale_count="$(count_stale_interactive_candidates)"
    if [ "${stale_count}" -gt 0 ]; then
        echo -e "  Stale:    ${YELLOW}${stale_count}${NC} interactive runtime candidate(s)"
        echo "  Flush:    ./webctl.sh flush --dry-run"
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
_frontend_needs_build() {
    # Returns 0 (true) if frontend source is newer than dist, 1 otherwise.
    local app_dir="${PROJECT_ROOT}/packages/app"
    local dist_marker="${app_dir}/dist/index.html"

    # No dist at all → must build
    [ ! -f "${dist_marker}" ] && return 0

    local dist_ts
    dist_ts=$(stat -c '%Y' "${dist_marker}" 2>/dev/null) || return 0

    # Check if any source file is newer than dist
    # Covers: src/, index.html, vite.config, tsconfig, package.json
    local newer
    newer=$(find "${app_dir}/src" "${app_dir}/index.html" \
        "${app_dir}/vite.config"* "${app_dir}/tsconfig"* \
        "${app_dir}/package.json" \
        -newer "${dist_marker}" -print -quit 2>/dev/null)
    [ -n "${newer}" ] && return 0

    # Also check shared packages that feed into the frontend build
    for dep_dir in "${PROJECT_ROOT}/packages/ui/src" "${PROJECT_ROOT}/packages/theme/src"; do
        if [ -d "${dep_dir}" ]; then
            newer=$(find "${dep_dir}" -newer "${dist_marker}" -print -quit 2>/dev/null)
            [ -n "${newer}" ] && return 0
        fi
    done

    return 1
}

do_build_frontend() {
    if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
        log_error "build-frontend is only available when running from source repo."
        exit 1
    fi

    # Skip build if source unchanged (unless --force)
    if [ "${1:-}" != "--force" ] && ! _frontend_needs_build; then
        log_info "Frontend source unchanged since last build — skipping. (Use build-frontend --force to override)"
        return 0
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
# Gateway (C root daemon) — Phase ω
# ---------------------------------------------------------------------------
GATEWAY_SRC="${PROJECT_ROOT}/daemon/opencode-gateway.c"
GATEWAY_BIN="${PROJECT_ROOT}/daemon/opencode-gateway"
GATEWAY_INSTALL_BIN="/usr/local/bin/opencode-gateway"
GATEWAY_SERVICE_NAME="opencode-gateway"
GATEWAY_PID_FILE="${RUNTIME_TMP_BASE}/opencode-gateway-${PROFILE_SAFE}.pid"
GATEWAY_LOG_FILE="${RUNTIME_TMP_BASE}/opencode-gateway-${PROFILE_SAFE}.log"

compile_gateway() {
    if [ ! -f "${GATEWAY_SRC}" ]; then
        log_error "Gateway source not found: ${GATEWAY_SRC}"
        exit 1
    fi

    log_info "Compiling gateway daemon..."
    if ! command -v gcc >/dev/null 2>&1; then
        log_error "gcc not found. Install build-essential (apt) or gcc."
        exit 1
    fi

    gcc -O2 -Wall -D_GNU_SOURCE \
        -o "${GATEWAY_BIN}" "${GATEWAY_SRC}" \
        -lpam -lpam_misc -lcrypto -lpthread

    log_success "Gateway compiled: ${GATEWAY_BIN}"
}

start_gateway() {
    local mode="${1:-prod}"

    if [ ! -x "${GATEWAY_BIN}" ] && [ ! -x "${GATEWAY_INSTALL_BIN}" ]; then
        log_error "Gateway binary not found. Run: ./webctl.sh compile-gateway"
        exit 1
    fi

    local gw_bin="${GATEWAY_BIN}"
    [ ! -x "${gw_bin}" ] && gw_bin="${GATEWAY_INSTALL_BIN}"

    # Resolve opencode binary for per-user daemon spawning
    local oc_bin=""
    if [ "${IS_SOURCE_REPO:-0}" -eq 1 ]; then
        local BUN_BIN
        BUN_BIN="$(find_bun)"
        oc_bin="${BUN_BIN} --conditions=browser ${PROJECT_ROOT}/packages/opencode/src/index.ts"
    elif [ -n "${OPENCODE_BIN}" ] && [ -x "${OPENCODE_BIN}" ]; then
        oc_bin="${OPENCODE_BIN}"
    else
        oc_bin="$(command -v opencode || echo '/usr/local/bin/opencode')"
    fi

    local gw_port="${OPENCODE_GATEWAY_PORT:-${WEB_PORT:-1080}}"
    local login_html="${PROJECT_ROOT}/daemon/login.html"
    [ ! -f "${login_html}" ] && login_html="/usr/local/share/opencode/login.html"

    log_info "Starting gateway daemon on port ${gw_port} (mode=${mode})..."

    if [ -f "${GATEWAY_PID_FILE}" ]; then
        local old_pid
        old_pid=$(cat "${GATEWAY_PID_FILE}")
        if kill -0 "${old_pid}" 2>/dev/null; then
            log_warn "Gateway already running (pid ${old_pid}). Stopping first..."
            if [ "${EUID}" -eq 0 ]; then
                kill "${old_pid}" 2>/dev/null || true
            else
                sudo -n kill "${old_pid}" 2>/dev/null || true
            fi
            sleep 1
        fi
        rm -f "${GATEWAY_PID_FILE}"
    fi

    local -a gateway_env
    gateway_env=(
        "OPENCODE_BIN=${oc_bin}"
        "OPENCODE_LOGIN_HTML=${login_html}"
        "OPENCODE_GATEWAY_PORT=${gw_port}"
        "OPENCODE_LAUNCH_MODE=webctl"
        "OPENCODE_REPO_ROOT=${PROJECT_ROOT}"
        "OPENCODE_ALLOW_GLOBAL_FS_BROWSE=${OPENCODE_ALLOW_GLOBAL_FS_BROWSE:-1}"
        "OPENCODE_FRONTEND_PATH=${FRONTEND_DIST}"
        "OPENCODE_WEB_NO_OPEN=${OPENCODE_WEB_NO_OPEN:-1}"
        "OPENCODE_AUTH_MODE=${AUTH_MODE}"
    )

    if [ "${EUID}" -eq 0 ]; then
        nohup env "${gateway_env[@]}" \
            "${gw_bin}" \
            >"${GATEWAY_LOG_FILE}" 2>&1 < /dev/null &
    else
        if ! command -v sudo >/dev/null 2>&1; then
            log_error "sudo not found; cannot start root gateway daemon."
            return 1
        fi
        nohup sudo -n env "${gateway_env[@]}" \
            "${gw_bin}" \
            >"${GATEWAY_LOG_FILE}" 2>&1 < /dev/null &
    fi

    local pid=$!
    echo "${pid}" > "${GATEWAY_PID_FILE}"
    sleep 1

    if kill -0 "${pid}" 2>/dev/null; then
        log_success "Gateway started (pid ${pid})"
    else
        log_error "Gateway failed to start. Check: ${GATEWAY_LOG_FILE}"
        rm -f "${GATEWAY_PID_FILE}"
        return 1
    fi
}

stop_gateway() {
    if [ -f "${GATEWAY_PID_FILE}" ]; then
        local gw_pid
        gw_pid=$(cat "${GATEWAY_PID_FILE}")
        if kill -0 "${gw_pid}" 2>/dev/null; then
            log_info "Stopping gateway (pid ${gw_pid})..."
            if [ "${EUID}" -eq 0 ]; then
                kill "${gw_pid}" 2>/dev/null || true
            else
                sudo -n kill "${gw_pid}" 2>/dev/null || true
            fi
            local i=0
            while kill -0 "${gw_pid}" 2>/dev/null && [ "${i}" -lt 10 ]; do
                sleep 0.5
                i=$((i+1))
            done
            if kill -0 "${gw_pid}" 2>/dev/null; then
                log_warn "Gateway still alive, sending SIGKILL..."
                if [ "${EUID}" -eq 0 ]; then
                    kill -9 "${gw_pid}" 2>/dev/null || true
                else
                    sudo -n kill -9 "${gw_pid}" 2>/dev/null || true
                fi
            fi
            log_success "Gateway stopped"
        else
            log_info "Gateway (pid ${gw_pid}) not running"
        fi
        rm -f "${GATEWAY_PID_FILE}"
    else
        log_info "No gateway PID file found"
    fi
}

do_compile_gateway() {
    compile_gateway
}

do_gateway_start() {
    load_server_cfg
    compile_gateway
    start_gateway "${1:-prod}"
}

do_gateway_stop() {
    stop_gateway
}

do_gateway_status() {
    if command -v systemctl >/dev/null 2>&1; then
        local status
        status="$(systemctl is-active "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null || true)"
        if [ "${status}" = "active" ]; then
            local main_pid
            main_pid="$(systemctl show -p MainPID --value "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null || true)"
            log_success "Gateway running (pid ${main_pid}, systemd service)"
            # Show current mode
            local current_bin
            current_bin="$(grep '^OPENCODE_BIN=' "${OPENCODE_CFG}" 2>/dev/null | cut -d= -f2- | tr -d '"')"
            if echo "${current_bin}" | grep -q 'bun\|index\.ts'; then
                echo "  Mode: dev (from source)"
            else
                echo "  Mode: prod (${current_bin})"
            fi
        else
            log_warn "Gateway service: ${status:-unknown}"
        fi
    elif [ -f "${GATEWAY_PID_FILE}" ]; then
        local gw_pid
        gw_pid=$(cat "${GATEWAY_PID_FILE}")
        if kill -0 "${gw_pid}" 2>/dev/null; then
            log_success "Gateway running (pid ${gw_pid})"
        else
            log_warn "Gateway PID file exists but process ${gw_pid} not running"
        fi
    else
        log_info "Gateway not running"
    fi
}

# ---------------------------------------------------------------------------
# switch_gateway_mode — unified dev/prod mode switching
#
# Updates OPENCODE_BIN in /etc/opencode/opencode.cfg, then restarts the
# gateway systemd service. Existing per-user daemons are killed so they
# respawn with the new binary on next request.
#
# Usage: switch_gateway_mode dev|prod
# ---------------------------------------------------------------------------
switch_gateway_mode() {
    local mode="${1:?usage: switch_gateway_mode dev|prod}"
    local new_bin=""

    case "${mode}" in
        dev)
            if [ "${IS_SOURCE_REPO:-0}" -ne 1 ]; then
                log_error "dev mode requires a source repo checkout"
                exit 1
            fi
            local BUN_BIN
            BUN_BIN="$(find_bun)"
            new_bin="${BUN_BIN} --conditions=browser ${PROJECT_ROOT}/packages/opencode/src/index.ts"
            ;;
        prod)
            new_bin="${OPENCODE_BIN:-/usr/local/bin/opencode}"
            # If cfg already has a non-bun path, prefer it; otherwise use installed binary
            if echo "${new_bin}" | grep -q 'bun\|index\.ts'; then
                new_bin="/usr/local/bin/opencode"
            fi
            ;;
        *)
            log_error "Unknown mode: ${mode}. Use 'dev' or 'prod'."
            exit 1
            ;;
    esac

    log_info "Switching to ${mode} mode: OPENCODE_BIN=${new_bin}"

    # Update OPENCODE_BIN in cfg (in-place)
    if grep -q '^OPENCODE_BIN=' "${OPENCODE_CFG}" 2>/dev/null; then
        sudo sed -i "s|^OPENCODE_BIN=.*|OPENCODE_BIN=\"${new_bin}\"|" "${OPENCODE_CFG}"
    else
        echo "OPENCODE_BIN=\"${new_bin}\"" | sudo tee -a "${OPENCODE_CFG}" >/dev/null
    fi

    # Ensure gateway binary is installed
    if [ ! -x "${GATEWAY_INSTALL_BIN}" ]; then
        compile_gateway
        log_info "Installing gateway binary to ${GATEWAY_INSTALL_BIN}..."
        sudo cp "${GATEWAY_BIN}" "${GATEWAY_INSTALL_BIN}"
    fi

    # Ensure systemd service is installed and enabled
    local svc_file="/etc/systemd/system/${SYSTEM_SERVICE_NAME}.service"
    local svc_src="${PROJECT_ROOT}/daemon/opencode-gateway.service"
    if [ ! -f "${svc_file}" ] || ! diff -q "${svc_src}" "${svc_file}" >/dev/null 2>&1; then
        log_info "Installing systemd service: ${svc_file}"
        sudo cp "${svc_src}" "${svc_file}"
        sudo systemctl daemon-reload
        sudo systemctl enable "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null || true
    fi

    # Restart gateway service
    log_info "Restarting gateway service..."
    sudo systemctl restart "${SYSTEM_SERVICE_NAME}.service"
    sleep 1

    if systemctl is-active --quiet "${SYSTEM_SERVICE_NAME}.service" 2>/dev/null; then
        log_success "Gateway service running (${mode} mode)"
    else
        log_error "Gateway service failed to start. Check: journalctl -u ${SYSTEM_SERVICE_NAME}"
        sudo systemctl status "${SYSTEM_SERVICE_NAME}.service" --no-pager || true
        return 1
    fi

    # Kill existing per-user daemons so they respawn with new binary
    local killed=0
    for sock in /run/user/*/opencode/daemon.sock; do
        [ -S "${sock}" ] || continue
        local uid_dir
        uid_dir="$(dirname "$(dirname "${sock}")")"
        local target_uid="${uid_dir##*/}"
        local daemon_pid
        daemon_pid="$(sudo fuser "${sock}" 2>/dev/null | tr -d ' ' || true)"
        if [ -n "${daemon_pid}" ]; then
            log_info "Killing per-user daemon pid=${daemon_pid} (uid=${target_uid})"
            sudo kill "${daemon_pid}" 2>/dev/null || true
            killed=$((killed + 1))
        fi
    done
    if [ "${killed}" -gt 0 ]; then
        log_info "Killed ${killed} per-user daemon(s). They will respawn on next request."
    fi
}

# ---------------------------------------------------------------------------
# Per-user daemon management
# ---------------------------------------------------------------------------

# Resolve discovery dir for a given user (by username or uid)
_daemon_discovery_dir() {
    local user="$1"
    local uid=""

    # Resolve uid from username
    if [[ "${user}" =~ ^[0-9]+$ ]]; then
        uid="${user}"
    else
        uid="$(id -u "${user}" 2>/dev/null)" || { log_error "User not found: ${user}"; return 1; }
    fi

    # XDG_RUNTIME_DIR standard path, then fallback
    local xdg_dir="/run/user/${uid}/opencode"
    local tmp_dir="/tmp/opencode-${uid}"

    if [ -d "${xdg_dir}" ]; then
        echo "${xdg_dir}"
    elif [ -d "${tmp_dir}" ]; then
        echo "${tmp_dir}"
    else
        echo "${xdg_dir}"  # return canonical even if missing
    fi
}

# Read daemon.json and return "pid socketPath" or empty
_daemon_read_discovery() {
    local dir="$1"
    local json="${dir}/daemon.json"
    [ -f "${json}" ] || return 1

    local pid sock
    pid="$(grep -o '"pid"[[:space:]]*:[[:space:]]*[0-9]*' "${json}" | grep -o '[0-9]*$')"
    sock="$(grep -o '"socketPath"[[:space:]]*:[[:space:]]*"[^"]*"' "${json}" | sed 's/.*"\([^"]*\)"$/\1/')"

    [ -n "${pid}" ] && [ -n "${sock}" ] && echo "${pid} ${sock}"
}

# List all per-user daemons
do_daemon_list() {
    local found=0
    local header_printed=0

    # Scan /run/user/*/opencode and /tmp/opencode-*
    for dir in /run/user/*/opencode /tmp/opencode-*; do
        [ -d "${dir}" ] || continue
        local json="${dir}/daemon.json"
        [ -f "${json}" ] || continue

        local info
        info="$(_daemon_read_discovery "${dir}")" || continue
        local pid sock
        pid="${info%% *}"
        sock="${info#* }"

        if [ "${header_printed}" -eq 0 ]; then
            printf "%-12s %-8s %-6s %s\n" "USER" "PID" "ALIVE" "SOCKET"
            printf "%-12s %-8s %-6s %s\n" "----" "---" "-----" "------"
            header_printed=1
        fi

        local alive="no"
        kill -0 "${pid}" 2>/dev/null && alive="yes"

        # Resolve username from dir path
        local username="?"
        local uid_from_path=""
        if [[ "${dir}" =~ /run/user/([0-9]+)/ ]]; then
            uid_from_path="${BASH_REMATCH[1]}"
        elif [[ "${dir}" =~ /tmp/opencode-([0-9]+) ]]; then
            uid_from_path="${BASH_REMATCH[1]}"
        fi
        if [ -n "${uid_from_path}" ]; then
            username="$(getent passwd "${uid_from_path}" 2>/dev/null | cut -d: -f1)" || username="uid:${uid_from_path}"
            [ -z "${username}" ] && username="uid:${uid_from_path}"
        fi

        printf "%-12s %-8s %-6s %s\n" "${username}" "${pid}" "${alive}" "${sock}"
        found=$((found + 1))
    done

    if [ "${found}" -eq 0 ]; then
        log_info "No per-user daemons found"
    else
        echo ""
        log_info "${found} daemon(s) found"
    fi
}

# Kill a specific user's daemon
do_daemon_kill() {
    local user="$1"
    if [ -z "${user}" ]; then
        log_error "Usage: ./webctl.sh daemon-kill <username|uid>"
        exit 1
    fi

    local dir
    dir="$(_daemon_discovery_dir "${user}")" || exit 1

    local info
    info="$(_daemon_read_discovery "${dir}")" || {
        log_info "No daemon found for ${user} (no discovery file in ${dir})"
        return 0
    }

    local pid="${info%% *}"
    local sock="${info#* }"

    if ! kill -0 "${pid}" 2>/dev/null; then
        log_info "Daemon for ${user} (pid ${pid}) already dead. Cleaning up discovery files..."
        rm -f "${dir}/daemon.json" "${dir}/daemon.pid" "${sock}" 2>/dev/null
        return 0
    fi

    log_info "Stopping daemon for ${user} (pid ${pid})..."
    kill "${pid}" 2>/dev/null || true

    # Wait for graceful shutdown
    local i=0
    while kill -0 "${pid}" 2>/dev/null && [ "${i}" -lt 10 ]; do
        sleep 0.5
        i=$((i + 1))
    done

    if kill -0 "${pid}" 2>/dev/null; then
        log_warn "Daemon still alive, sending SIGKILL..."
        kill -9 "${pid}" 2>/dev/null || true
        sleep 0.5
    fi

    # Clean up discovery files (daemon may not have cleaned up if killed)
    rm -f "${dir}/daemon.json" "${dir}/daemon.pid" "${sock}" 2>/dev/null
    log_success "Daemon for ${user} stopped"
}

# Kill all per-user daemons
do_daemon_killall() {
    local killed=0

    for dir in /run/user/*/opencode /tmp/opencode-*; do
        [ -d "${dir}" ] || continue
        local json="${dir}/daemon.json"
        [ -f "${json}" ] || continue

        local info
        info="$(_daemon_read_discovery "${dir}")" || continue
        local pid="${info%% *}"
        local sock="${info#* }"

        # Resolve username for display
        local username="?"
        local uid_from_path=""
        if [[ "${dir}" =~ /run/user/([0-9]+)/ ]]; then
            uid_from_path="${BASH_REMATCH[1]}"
        elif [[ "${dir}" =~ /tmp/opencode-([0-9]+) ]]; then
            uid_from_path="${BASH_REMATCH[1]}"
        fi
        if [ -n "${uid_from_path}" ]; then
            username="$(getent passwd "${uid_from_path}" 2>/dev/null | cut -d: -f1)" || username="uid:${uid_from_path}"
            [ -z "${username}" ] && username="uid:${uid_from_path}"
        fi

        if kill -0 "${pid}" 2>/dev/null; then
            log_info "Stopping daemon for ${username} (pid ${pid})..."
            kill "${pid}" 2>/dev/null || true
            killed=$((killed + 1))
        fi

        # Clean up regardless
        rm -f "${dir}/daemon.json" "${dir}/daemon.pid" "${sock}" 2>/dev/null
    done

    if [ "${killed}" -gt 0 ]; then
        # Brief wait for graceful shutdown
        sleep 1
        log_success "Sent SIGTERM to ${killed} daemon(s)"
    else
        log_info "No running daemons found"
    fi
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
    echo "  stop              Stop active dev / production server(s)"
    echo "  flush             Clean stale interactive opencode/MCP process trees"
    echo "  restart           Refresh active dev / production server(s)"
    echo "  dev-refresh       Build frontend + restart dev server"
    echo "  web-start         Start production systemd service"
    echo "  web-stop          Stop production systemd service"
    echo "  web-restart       Restart production systemd service"
    echo "  web-refresh       Restart installed production service (no repo rebuild/deploy)"
    echo "  status            Show server status and health"
    echo "  logs              Follow PTY debug log (/tmp/pty-debug.log)"
    echo "  build-frontend    Build packages/app/dist/ (run after frontend changes)"
    echo "  build-binary      Build native binary for current platform"
    echo "  compile-mcp       Recompile stale internal MCP server binaries"
    echo "  compile-gateway   Compile the C root gateway daemon"
    echo "  gateway-start     Compile + start the gateway daemon"
    echo "  gateway-stop      Stop the gateway daemon"
    echo "  gateway-status    Show gateway daemon status"
    echo "  daemon-list       List all per-user daemons (alias: daemons)"
    echo "  daemon-kill <user> Stop a specific user's daemon"
    echo "  daemon-killall    Stop all per-user daemons"
    echo "  help              Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  OPENCODE_SERVER_CFG        Server config path (default: /etc/opencode/opencode.cfg)"
    echo "  OPENCODE_PORT              Port to listen on (default: 1080)"
    echo "  OPENCODE_PUBLIC_URL        Public URL shown in status/start output"
    echo "  OPENCODE_PROFILE           Runtime profile label (default: default)"
    echo "  OPENCODE_AUTH_MODE         Auth mode: pam|htpasswd|legacy|auto (default: pam)"
    echo "  OPENCODE_ALLOW_INLINE_RESTART  Allow risky inline restart (default: 0)"
    echo "  OPENCODE_AUTO_SWITCH_OWNER Auto-switch to repo owner (default: 1)"
    echo "  OPENCODE_SERVER_HTPASSWD   Path to htpasswd file (required when mode=htpasswd)"
    echo "  OPENCODE_SERVER_PASSWORD   Password env (legacy mode only)"
    echo "  OPENCODE_SERVER_USERNAME   Username for legacy mode"
    echo "  OPENCODE_SYSTEM_SERVICE_NAME systemd service basename (default: opencode-web)"
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
    echo "  ./webctl.sh stop"
    echo "  ./webctl.sh flush --dry-run"
    echo "  ./webctl.sh flush"
    echo "  ./webctl.sh restart              # dev=build+stop+flush+start, prod=web-refresh(restart only)"
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
setup_restart_error_capture "${1:-}"
ensure_repo_owner_identity "$@"
ensure_non_interactive_sudo "$@"

case "${1:-}" in
    install)                do_install "${@:2}" ;;
    dev-start|dev-up)       do_dev_start      ;;
    dev-stop|dev-down)      do_dev_stop       ;;
    stop)                   do_stop           ;;
    flush)                  do_flush "${@:2}" ;;
    dev-refresh)            do_dev_refresh    ;;
    web-start)              do_web_start      ;;
    web-stop)               do_web_stop       ;;
    web-restart)            do_web_restart    ;;
    web-refresh)            do_web_refresh    ;;
    restart)        do_restart "${@:2}"   ;;
    _restart-worker) do_restart_worker "${@:2}" ;;
    status)         do_status         ;;
    logs)           do_logs           ;;
    build-frontend) do_build_frontend ;;
    build-binary)   do_build_binary   ;;
    compile-mcp)    compile_internal_mcp_if_stale ;;
    compile-gateway) do_compile_gateway ;;
    gateway-start)  do_gateway_start "${@:2}" ;;
    gateway-stop)   do_gateway_stop   ;;
    gateway-status) do_gateway_status ;;
    daemon-list|daemons) do_daemon_list ;;
    daemon-kill)    do_daemon_kill "${2:-}" ;;
    daemon-killall) do_daemon_killall ;;
    help|--help|-h|"") do_help        ;;
    *)
        log_error "Unknown command: $1"
        do_help
        exit 1
        ;;
esac
