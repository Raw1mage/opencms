import crypto from "crypto"
import path from "path"
import { Global } from "../global"
import { emitDebug } from "../bus/sink"
import { getLogLevel } from "../bus/log-level"

// DEBUG_LOG_PATH defined here (no Bus dependency) — debug-writer imports from here
export const DEBUG_LOG_PATH = path.join(Global.Path.log, "debug.log")

const keytraceEnabled = process.env.OPENCODE_DEBUG_KEYTRACE === "1"

/** No-op — file init is now handled by debug-writer subscriber. */
export function debugInit() {}

export function debugCheckpoint(scope: string, message: string, data?: Record<string, unknown>) {
  if (getLogLevel() === 0) return
  if (scope === "admin.keytrace" && !keytraceEnabled) return
  emitDebug(scope, message, data)
}

export function debugSpan<T>(
  scope: string,
  message: string,
  data: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (getLogLevel() === 0) return Promise.resolve().then(fn)
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
