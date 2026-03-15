import { formatServerError } from "./server-errors"

type RestartErrorPayload = {
  code?: string
  message?: string
  hint?: string
  txid?: string
  errorLogPath?: string
}

export function formatRestartErrorResponse(raw: string, status?: number) {
  const text = raw.trim()
  if (!text) return status ? `Restart failed (${status})` : "Restart failed"
  try {
    const parsed = JSON.parse(text) as RestartErrorPayload
    const head = parsed.message?.trim() || formatServerError(parsed)
    const hint = parsed.hint?.trim()
    const txid = parsed.txid?.trim()
    const errorLogPath = parsed.errorLogPath?.trim()
    return [head, hint, txid ? `Restart TX: ${txid}` : "", errorLogPath ? `Error log: ${errorLogPath}` : ""]
      .filter(Boolean)
      .join("\n\n")
  } catch {
    return text
  }
}
