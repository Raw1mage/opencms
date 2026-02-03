/**
 * Centralized debug logging to file.
 * All debug output goes to ~/.local/share/opencode/log/debug.log
 * File is cleared on each startup.
 */

import fs from "fs"
import path from "path"
const DEBUG_LOG_PATH = path.join(process.cwd(), "logs", "debug.log")

// Format timestamp in local time (e.g., 2026-02-01 12:34:56.789)
function localTimestamp(): string {
  const now = new Date()
  const pad = (n: number, len = 2) => String(n).padStart(len, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

// Clear log file immediately on module load
try {
  fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true })
  fs.writeFileSync(DEBUG_LOG_PATH, `=== Debug Log Started: ${localTimestamp()} ===\n`)
} catch (e) {
  // Ignore if can't write
}

function ensureInit() {
  // No-op now, kept for compatibility
}

export function debugLog(tag: string, message: string, data?: Record<string, unknown>) {
  ensureInit()
  const timestamp = localTimestamp()
  const dataStr = data ? " " + JSON.stringify(data) : ""
  const line = `[${timestamp}] [${tag}] ${message}${dataStr}\n`
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true })
    fs.appendFileSync(DEBUG_LOG_PATH, line)
  } catch (e) {
    // Ignore write errors
  }
}

export function debugLogError(tag: string, message: string, error: unknown) {
  const errorStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  debugLog(tag, `ERROR: ${message}`, { error: errorStr })
}

// Export path for easy access
export const DEBUG_LOG_FILE = DEBUG_LOG_PATH
