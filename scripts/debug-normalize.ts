import fs from "fs"
import path from "path"

const root = "/home/pkcs12/opencode/logs"
const file = path.join(root, "debug.log")
let running = false
let pending = false
let timer: ReturnType<typeof setTimeout> | undefined

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
  const time = typeof data.time === "string" ? data.time : new Date().toISOString()
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

function normalize() {
  if (running) {
    pending = true
    return
  }
  running = true
  let text = ""
  try {
    text = fs.readFileSync(file, "utf-8")
  } catch {
    running = false
    return
  }
  const next = text
    .split("\n")
    .map((line) => normalizeLine(line))
    .join("\n")
  if (next !== text) {
    try {
      fs.writeFileSync(file, next)
    } catch {}
  }
  running = false
  if (!pending) return
  pending = false
  normalize()
}

function schedule() {
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    normalize()
  }, 50)
  if (timer && typeof timer.unref === "function") timer.unref()
}

function ensure() {
  fs.mkdirSync(root, { recursive: true })
  if (fs.existsSync(file)) return
  fs.writeFileSync(file, "")
}

ensure()
normalize()

try {
  fs.watch(file, { persistent: true }, () => schedule())
} catch {}

setInterval(() => normalize(), 500)
