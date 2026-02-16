#!/usr/bin/env bash

# opencode.sh - OpenCode Dev Environment Manager
# Created to manage background dev server and execute CLI commands

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PID_FILE="${PROJECT_ROOT}/opencode.pid"
LOG_FILE="${PROJECT_ROOT}/opencode.log"

# Function to get PID
get_pid() {
    if [ -f "$PID_FILE" ]; then
        cat "$PID_FILE"
    fi
}

# Function to check if running
is_running() {
    local pid=$(get_pid)
    if [ -n "$pid" ] && ps -p "$pid" > /dev/null 2>&1; then
        return 0
    fi
    return 1
}

case "$1" in
    start)
        if is_running; then
            echo "OpenCode dev server is already running (PID: $(get_pid))."
        else
            echo "Starting OpenCode dev server in background..."
            cd "$PROJECT_ROOT" || exit 1
            # Run in background and redirect output to log
            nohup ~/.bun/bin/bun run dev > "$LOG_FILE" 2>&1 &
            echo $! > "$PID_FILE"
            echo "Server started. (PID: $(cat "$PID_FILE"))"
            echo "Use '$0 logs' to see output or '$0 stop' to terminate."
        fi
        ;;
    run)
        if is_running; then
            echo "Error: OpenCode dev server is already running in background (PID: $(get_pid))."
            echo "Please run '$0 stop' first."
            exit 1
        fi
        echo "Starting OpenCode dev server in foreground..."
        cd "$PROJECT_ROOT" || exit 1
        ~/.bun/bin/bun run dev
        ;;
    stop)
        if is_running; then
            pid=$(get_pid)
            echo "Stopping OpenCode dev server (PID: $pid)..."
            kill "$pid"
            rm "$PID_FILE"
            echo "Stopped."
        else
            echo "OpenCode dev server is not running."
        fi
        # Also clean up any stray bun processes if needed
        ;;
    status)
        if is_running; then
            echo "Status: RUNNING (PID: $(get_pid))"
            echo "Port: Usually 4096 (internal)"
            echo "Last 5 lines of log:"
            tail -n 5 "$LOG_FILE"
        else
            echo "Status: STOPPED"
        fi
        ;;
    logs)
        if [ -f "$LOG_FILE" ]; then
            echo "--- Showing logs (Ctrl+C to exit) ---"
            tail -f "$LOG_FILE"
        else
            echo "Log file not found."
        fi
        ;;
    health)
        echo "Running Model Health Check..."
        cd "$PROJECT_ROOT" || exit 1
        ~/.bun/bin/bun run --cwd packages/opencode src/index.ts model-check "${@:2}"
        ;;
    allocate)
        echo "Running Model Allocation..."
        cd "$PROJECT_ROOT" || exit 1
        ~/.bun/bin/bun run --cwd packages/opencode src/index.ts allocate-models "${@:2}"
        ;;
    help|*)
        echo "Usage: $0 {start|stop|status|logs|health|allocate}"
        echo ""
        echo "Commands:"
        echo "  start    - Run dev server in the background"
        echo "  stop     - Stop the background dev server"
        echo "  status   - Check if server is running"
        echo "  logs     - Tail the server logs"
        echo "  health   - Run model health check (pass args like --parallel)"
        echo "  allocate - Run model allocation check"
        ;;
esac
