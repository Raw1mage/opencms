/**
 * Debug-writer subscriber: writes all Bus events to debug.log.
 * logLevel gate: >= 1 (quiet).
 *
 * This is the SOLE writer to debug.log — all debug output flows through here.
 * Handles: Bus.debug() checkpoint events + Bus.publish() events.
 *
 * Registered once at process startup via Bus.subscribeGlobal("*", 1, ...).
 */
import fs from "fs"
import path from "path"
import { Bus } from "../index"
import { DEBUG_LOG_PATH } from "../../util/debug"
import { Tweaks } from "../../config/tweaks"

const file = DEBUG_LOG_PATH
const root = path.dirname(file)

// --- Log rotation ---
const ROTATE_MAX_BYTES = 10_000_000 // 10 MB
const ROTATE_KEEP = 10 // → ~100 MB forensic window

// --- Event channel denylist ---
// These high-volume channels dominate debug.log but rarely help RCA:
//   - message.part.updated: per-token streaming deltas (thousands per response)
//   - session.diff: full before/after file bodies on every edit
// Block here; if needed for targeted debugging, comment them out temporarily.
const EVENT_DENYLIST = new Set<string>([
  "message.part.updated", // per-token streaming deltas (thousands per response)
  "session.diff", // full before/after file bodies on every edit
  "session-cache.invalidated", // ~1k events per session (SSE fan-out churn)
  "session-cache.hit",
  "session-cache.miss",
  "session-cache.evicted",
  "rate-limit.allowed", // per-allowed-request ack; metrics live in beacon instead
  "ratelimit.cleared",
])

function rotateIfNeeded() {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return
  }
  if (size < ROTATE_MAX_BYTES) return
  // Shift history: .5 → delete, .4 → .5, ... .1 → .2, current → .1
  for (let i = ROTATE_KEEP; i >= 1; i--) {
    const src = i === 1 ? file : `${file}.${i - 1}`
    const dst = `${file}.${i}`
    try {
      if (i === ROTATE_KEEP) fs.unlinkSync(dst)
      fs.renameSync(src, dst)
    } catch {}
  }
  // Truncate current (renameSync already moved it)
  try {
    fs.writeFileSync(file, "")
  } catch {}
}

// --- Formatting ---

const SENSITIVE_KEYS = new Set([
  "refreshToken",
  "token",
  "apiKey",
  "api_key",
  "apiSecret",
  "api_secret",
  "password",
  "passwd",
  "secret",
  "Authorization",
  "X-API-Key",
  "x-api-key",
])

const flowKeys = [
  "sessionID",
  "messageID",
  "userMessageID",
  "assistantMessageID",
  "callID",
  "providerId",
  "modelID",
  "agent",
  "tool",
  "accountId",
  "accountID",
  "requestPhase",
  "source",
  "projectId",
]

function getTimestamp() {
  const d = new Date()
  const offset = 8 * 3600000 // UTC+8 for Asia/Taipei
  const nd = new Date(d.getTime() + offset)
  return nd.toISOString().replace("Z", "+08:00")
}

function redactSensitiveValue(value: unknown): string {
  if (typeof value === "string") {
    if (value.length <= 10) return "[REDACTED]"
    return `[REDACTED-${value.length}chars]`
  }
  return "[REDACTED]"
}

function safe(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (key, val) => {
    if (key && SENSITIVE_KEYS.has(key)) return redactSensitiveValue(val)
    if (val instanceof Error) return val.stack || val.message
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]"
      seen.add(val)
    }
    return val
  })
}

function flow(data?: Record<string, unknown>) {
  if (!data) return undefined
  const result: Record<string, unknown> = {}
  for (const key of flowKeys) {
    if (data[key] === undefined) continue
    result[key] = data[key]
  }
  if (Object.keys(result).length === 0) return undefined
  return result
}

// --- File management ---

let initialized = false
let seq = 0

function ensure() {
  if (initialized) return
  initialized = true
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(file, "")
}

// --- File enable gate ---
// File writing requires explicit opt-in: OPENCODE_DEBUG_LOG=1 or OPENCODE_LOG_LEVEL set.
// Without this gate, all users would get a debug.log by default (logLevel defaults to 2).
function isFileEnabled() {
  // Tweaks.cfg takes priority, then env vars for backward compat.
  if (Tweaks.debugLogEnabledSync()) return true
  return process.env.OPENCODE_DEBUG_LOG === "1" || process.env.OPENCODE_LOG_LEVEL !== undefined
}

// --- Event handler ---

function handleEvent(event: { type: string; properties?: unknown }) {
  if (!isFileEnabled()) return
  if (EVENT_DENYLIST.has(event.type)) return
  ensure()
  seq++
  const time = getTimestamp()

  let line: string
  if (event.type === "debug.checkpoint") {
    // Format identical to legacy debugCheckpoint output
    const props = event.properties as { scope: string; message: string; data?: Record<string, unknown> }
    const payload = safe({
      seq,
      trace: typeof props.data?.trace === "string" ? props.data.trace : undefined,
      span: typeof props.data?.span === "string" ? props.data.span : undefined,
      flow: flow(props.data),
      data: props.data ?? {},
    })
    line = `[opencode] [${time}] [${props.scope}] ${props.message} ${payload}\n`
  } else {
    // Bus.publish event format
    const payload = safe({ seq, data: event.properties ?? {} })
    line = `[opencode] [${time}] [bus.${event.type}] event ${payload}\n`
  }

  fs.appendFileSync(file, line)
  rotateIfNeeded()
}

// --- Registration ---

let registered = false

export function registerDebugWriter() {
  if (registered) return
  registered = true
  Bus.subscribeGlobal("*", 1, handleEvent)
}
