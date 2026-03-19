/**
 * Subscriber-side log level filter for the unified message bus.
 *
 * Priority:
 *   1. Runtime override via setLogLevel() (called by server API, persisted to state file)
 *   2. OPENCODE_LOG_LEVEL env (0=off, 1=quiet, 2=normal, 3=verbose)
 *   3. OPENCODE_DEBUG_LOG=1 → LOG_LEVEL=1 (backward compat)
 *   4. Default: 2 (normal)
 *
 * Dynamic: MCP tool → server API → setLogLevel() → immediate in-process update.
 * State file ensures persistence across restarts.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs"
import path from "path"

export type LogLevel = 0 | 1 | 2 | 3

export const LOG_LEVELS = {
  0: "off",
  1: "quiet",
  2: "normal",
  3: "verbose",
} as const

const STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "", ".local", "state")
const STATE_FILE = path.join(STATE_HOME, "opencode", "log-level")

let cached: LogLevel | undefined

function readStateFile(): LogLevel | undefined {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8").trim()
    const n = Number(raw)
    if (n >= 0 && n <= 3) return n as LogLevel
  } catch {
    // File doesn't exist or unreadable — not an error
  }
  return undefined
}

function resolveLogLevel(): LogLevel {
  // 1. State file (set by setLogLevel, persisted across restarts)
  const fromFile = readStateFile()
  if (fromFile !== undefined) return fromFile

  // 2. OPENCODE_LOG_LEVEL env
  const raw = process.env.OPENCODE_LOG_LEVEL
  if (raw !== undefined) {
    const n = Number(raw)
    if (n >= 0 && n <= 3) return n as LogLevel
  }

  // 3. Backward compat: OPENCODE_DEBUG_LOG=1 maps to LOG_LEVEL=1
  if (process.env.OPENCODE_DEBUG_LOG === "1") return 1

  // 4. Default: normal
  return 2
}

export function getLogLevel(): LogLevel {
  if (cached !== undefined) return cached
  cached = resolveLogLevel()
  return cached
}

/**
 * Set log level at runtime. Updates in-process cache immediately
 * and persists to state file for cross-restart survival.
 * Called by server API route (triggered by MCP set_log_level tool).
 */
export function setLogLevel(level: LogLevel) {
  cached = level
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, String(level))
  } catch {
    // Best-effort persist; in-memory update is the primary effect
  }
}

/** Reset cached value — forces re-read from file/env on next getLogLevel(). */
export function resetLogLevelCache() {
  cached = undefined
}
