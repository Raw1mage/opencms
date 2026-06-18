export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: Array<{ message: string; path: string[] }>
  }
}

export type ConfigJsonError = {
  name: "ConfigJsonError"
  data: {
    path?: string
    message?: string
    line?: number
    column?: number
    code?: string
    problemLine?: string
    hint?: string
  }
}

// Guard against older daemon payloads that may still carry a large `message`
// blob (pre-2026-04-17 behaviour). Truncating keeps toast/UI sane even if the
// daemon has not been upgraded yet.
const MAX_INLINE_TEXT = 500

function truncate(text: string | undefined | null): string {
  if (!text) return ""
  const trimmed = text.trim()
  if (trimmed.length <= MAX_INLINE_TEXT) return trimmed
  return `${trimmed.slice(0, MAX_INLINE_TEXT)}\n[truncated]`
}

// Proxies / tunnels / load balancers in front of the daemon (common on mobile,
// where a backgrounded tab resumes onto a momentarily-down upstream) answer with
// a full HTML error page instead of JSON. The SDK throws that body verbatim, so
// without this guard the toast renders a raw <!DOCTYPE html>… dump. Detect it and
// collapse to a clean one-liner.
function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 256).toLowerCase()
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.includes("<head") ||
    head.includes("<body")
  )
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  if (typeof error !== "object" || error === null) return false
  const obj = error as Record<string, unknown>
  return obj.name === "ConfigInvalidError" && typeof obj.data === "object" && obj.data !== null
}

function isConfigJsonErrorLike(error: unknown): error is ConfigJsonError {
  if (typeof error !== "object" || error === null) return false
  const obj = error as Record<string, unknown>
  return obj.name === "ConfigJsonError" && typeof obj.data === "object" && obj.data !== null
}

export function formatReadableConfigInvalidError(error: ConfigInvalidError) {
  const head = "Invalid configuration"
  const file = error.data.path && error.data.path !== "config" ? error.data.path : ""
  const detail = truncate(error.data.message)
  const issues = (error.data.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  if (issues.length) return [head, file, ...issues].filter(Boolean).join("\n")
  return [head, file, detail].filter(Boolean).join("\n")
}

export function formatReadableConfigJsonError(error: ConfigJsonError) {
  const head = "Config file is not valid JSON(C)"
  const file = error.data.path ?? ""
  const hint = error.data.hint ?? error.data.message ?? ""
  const location =
    typeof error.data.line === "number" && typeof error.data.column === "number"
      ? `Line ${error.data.line}, column ${error.data.column}`
      : ""
  const sample = error.data.problemLine ? `    ${error.data.problemLine.slice(0, 200)}` : ""
  return [head, file, location, truncate(hint), sample].filter(Boolean).join("\n")
}

export function formatServerError(error: unknown) {
  if (isConfigJsonErrorLike(error)) return formatReadableConfigJsonError(error)
  if (isConfigInvalidErrorLike(error)) return formatReadableConfigInvalidError(error)
  if (error instanceof Error && error.message) {
    if (looksLikeHtml(error.message)) return "Server returned an unexpected response"
    return truncate(error.message)
  }
  if (typeof error === "string" && error) {
    if (looksLikeHtml(error)) return "Server returned an unexpected response"
    return truncate(error)
  }
  return "Unknown error"
}
