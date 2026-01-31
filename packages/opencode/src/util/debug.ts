import { appendFile, mkdir, writeFile } from "fs/promises"
import os from "os"
import path from "path"

const root = path.join(os.homedir(), "opencode", "logs")
const file = path.join(root, "debug.log")
let initialized = false
const keytraceEnabled = process.env.OPENCODE_DEBUG_KEYTRACE === "1"

function normalize(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number") return value.toString()
  if (typeof value === "boolean") return value ? "true" : "false"
  if (value instanceof Error) return value.stack || value.message
  return JSON.stringify(value)
}

export function debugInit() {
  if (initialized) return
  initialized = true
  mkdir(root, { recursive: true })
    .then(() => writeFile(file, ""))
    .catch(() => {})
}

export function debugCheckpoint(scope: string, message: string, data?: Record<string, unknown>) {
  if (scope === "admin.keytrace" && !keytraceEnabled) return
  debugInit()
  const time = new Date().toISOString()
  const entry = {
    time,
    scope,
    message,
    data: data ?? {},
  }
  const line = normalize(entry) + "\n"
  mkdir(root, { recursive: true })
    .then(() => appendFile(file, line))
    .catch(() => {})
}

export function debugSpan<T>(
  scope: string,
  message: string,
  data: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  debugCheckpoint(scope, `${message}:start`, data)
  const start = Date.now()
  return Promise.resolve()
    .then(fn)
    .then((result) => {
      debugCheckpoint(scope, `${message}:end`, { ...data, ms: Date.now() - start, ok: true })
      return result
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.stack || err.message : String(err)
      debugCheckpoint(scope, `${message}:error`, { ...data, ms: Date.now() - start, ok: false, error: msg })
      throw err
    })
}
