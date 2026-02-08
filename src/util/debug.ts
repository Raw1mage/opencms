import crypto from "crypto"
import fs from "fs"
import path from "path"
// @event_2026-02-07_install
import { Global } from "../global"

const root = Global.Path.log
const file = path.join(root, "debug.log")
export const DEBUG_LOG_PATH = file
let initialized = false
let seq = 0
const keytraceEnabled = process.env.OPENCODE_DEBUG_KEYTRACE === "1"
let last = 0
let normalizing = false
let queued = false
let watching = false
let hooked = false
const originalAppend = fs.appendFileSync
const originalWrite = fs.writeFileSync
const originalStream = fs.createWriteStream
const sniffEnabled = true
let sniffing = false
const flowKeys = [
  "sessionID",
  "messageID",
  "callID",
  "providerId",
  "modelID",
  "agent",
  "tool",
  "accountId",
  "accountID",
  "projectId",
]

function getTimestamp() {
  const d = new Date()
  const utc = d.getTime() + d.getTimezoneOffset() * 60000
  const offset = 8 * 3600000 // UTC+8 for Asia/Taipei
  const nd = new Date(utc + offset)
  return nd.toISOString().replace("Z", "+08:00")
}

function safe(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_, val) => {
    if (val instanceof Error) return val.stack || val.message
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]"
      seen.add(val)
    }
    return val
  })
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

function appendRaw(text: string) {
  originalAppend(file, text)
}

function sniffAppend(target: unknown, data: unknown) {
  if (!sniffEnabled) return
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
  if (!sniffEnabled) return
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

function watch() {
  if (watching) return
  watching = true
  try {
    const watcher = fs.watch(file, { persistent: false }, () => normalizeMaybe())
    if (typeof watcher.unref === "function") watcher.unref()
  } catch {}
}

function hook() {
  if (hooked) return
  hooked = true
  process.on("exit", () => normalizeFile())
}

function ensure() {
  if (initialized) return
  initialized = true
  if (sniffEnabled) {
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
  }
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(file, "")
  normalizeSoon()
  watch()
  hook()
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

export function debugInit() {
  ensure()
}

export function debugCheckpoint(scope: string, message: string, data?: Record<string, unknown>) {
  if (scope === "admin.keytrace" && !keytraceEnabled) return
  ensure()
  seq = seq + 1
  const time = getTimestamp()
  const payload = safe({
    seq,
    trace: typeof data?.trace === "string" ? data.trace : undefined,
    span: typeof data?.span === "string" ? data.span : undefined,
    flow: flow(data),
    data: data ?? {},
  })
  const line = `[opencode] [${time}] [${scope}] ${message} ${payload}\n`
  fs.appendFileSync(file, line)
  normalizeMaybe()
  normalizeSoon()
}

export function debugSpan<T>(
  scope: string,
  message: string,
  data: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const span = crypto.randomUUID()
  const trace = typeof data?.trace === "string" ? data.trace : crypto.randomUUID()
  const extra = { ...data, trace, span }
  debugCheckpoint(scope, `${message}:start`, extra)
  const start = Date.now()
  return Promise.resolve()
    .then(fn)
    .then((result) => {
      debugCheckpoint(scope, `${message}:end`, { ...extra, ms: Date.now() - start, ok: true })
      return result
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.stack || err.message : String(err)
      debugCheckpoint(scope, `${message}:error`, { ...extra, ms: Date.now() - start, ok: false, error: msg })
      throw err
    })
}
