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

const file = DEBUG_LOG_PATH
const root = path.dirname(file)

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
let last = 0
let normalizing = false
let queued = false

const originalAppend = fs.appendFileSync
const originalWrite = fs.writeFileSync
const originalStream = fs.createWriteStream
let sniffing = false

function appendRaw(text: string) {
  originalAppend(file, text)
}

function normalizeLine(line: string): string {
  if (line.trim().length === 0) return line
  if (line.startsWith("[opencode]")) return line
  if (!line.startsWith("{")) return line
  let data: Record<string, unknown> | undefined
  try {
    data = JSON.parse(line)
  } catch {
    return line
  }
  if (!data) return line
  const time = typeof data.time === "string" ? data.time : getTimestamp()
  const scope = typeof data.scope === "string" ? data.scope : "unknown"
  const message = typeof data.message === "string" ? data.message : "log"
  const payload = safe({
    seq: data.seq,
    trace: typeof data.trace === "string" ? data.trace : undefined,
    span: typeof data.span === "string" ? data.span : undefined,
    flow: typeof data.flow === "object" && data.flow ? data.flow : undefined,
    data: typeof data.data === "object" && data.data ? data.data : {},
  })
  return `[opencode] [${time}] [${scope}] ${message} ${payload}`
}

function normalizeFile() {
  if (normalizing) return
  normalizing = true
  let text = ""
  try {
    text = fs.readFileSync(file, "utf-8")
  } catch {
    normalizing = false
    return
  }
  const next = text
    .split("\n")
    .map((line) => normalizeLine(line))
    .join("\n")
  if (next === text) {
    normalizing = false
    return
  }
  try {
    fs.writeFileSync(file, next)
  } catch {}
  normalizing = false
}

function normalizeMaybe() {
  const now = Date.now()
  if (now - last < 500) return
  last = now
  normalizeFile()
}

function schedule(fn: () => void, ms: number) {
  const timer = setTimeout(fn, ms)
  if (typeof timer.unref === "function") timer.unref()
}

function normalizeSoon() {
  if (queued) return
  queued = true
  schedule(() => {
    normalizeFile()
    queued = false
  }, 0)
  schedule(() => normalizeFile(), 50)
  schedule(() => normalizeFile(), 200)
}

function sniffAppend(target: unknown, data: unknown) {
  if (sniffing) return
  if (target !== file) return
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf-8")
        : typeof data === "object" && data instanceof Uint8Array
          ? Buffer.from(data).toString("utf-8")
          : ""
  if (!text) return
  if (text.startsWith("[opencode]")) return
  sniffing = true
  const payload = safe({
    note: "non-opencode append detected",
    sample: text.slice(0, 500),
    stack: new Error("debug.sniff").stack,
  })
  appendRaw(`[opencode] [${getTimestamp()}] [debug.sniff] ${payload}\n`)
  sniffing = false
}

function sniffWrite(target: unknown, data: unknown) {
  if (sniffing) return
  if (target !== file) return
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf-8")
        : typeof data === "object" && data instanceof Uint8Array
          ? Buffer.from(data).toString("utf-8")
          : ""
  if (!text) return
  if (text.startsWith("[opencode]")) return
  sniffing = true
  const payload = safe({
    note: "non-opencode write detected",
    sample: text.slice(0, 500),
    stack: new Error("debug.sniff").stack,
  })
  appendRaw(`[opencode] [${getTimestamp()}] [debug.sniff] ${payload}\n`)
  sniffing = false
}

function ensure() {
  if (initialized) return
  initialized = true
  // Monkey-patch fs to detect non-opencode writes to debug.log
  fs.appendFileSync = ((target, data, options) => {
    sniffAppend(target, data)
    return originalAppend(target as string, data as string, options as never)
  }) as typeof fs.appendFileSync
  fs.writeFileSync = ((target, data, options) => {
    sniffWrite(target, data)
    return originalWrite(target as string, data as string, options as never)
  }) as typeof fs.writeFileSync
  fs.createWriteStream = ((target, options) => {
    const stream = originalStream(target as string, options as never)
    if (target === file) {
      const write = stream.write.bind(stream)
      stream.write = ((chunk, encoding, cb) => {
        sniffAppend(file, chunk)
        return write(chunk as never, encoding as never, cb as never)
      }) as typeof stream.write
    }
    return stream
  }) as typeof fs.createWriteStream
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(file, "")
  normalizeSoon()
  // Watch for external writes
  try {
    const watcher = fs.watch(file, { persistent: false }, () => normalizeMaybe())
    if (typeof watcher.unref === "function") watcher.unref()
  } catch {}
  // Final normalize on exit
  process.on("exit", () => normalizeFile())
}

// --- File enable gate ---
// File writing requires explicit opt-in: OPENCODE_DEBUG_LOG=1 or OPENCODE_LOG_LEVEL set.
// Without this gate, all users would get a debug.log by default (logLevel defaults to 2).
function isFileEnabled() {
  return process.env.OPENCODE_DEBUG_LOG === "1" || process.env.OPENCODE_LOG_LEVEL !== undefined
}

// --- Event handler ---

function handleEvent(event: { type: string; properties?: unknown }) {
  if (!isFileEnabled()) return
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
  normalizeMaybe()
  normalizeSoon()
}

// --- Registration ---

let registered = false

export function registerDebugWriter() {
  if (registered) return
  registered = true
  Bus.subscribeGlobal("*", 1, handleEvent)
}
