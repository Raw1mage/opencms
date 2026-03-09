import type { useSDK } from "@/context/sdk"

const SESSION_RELOAD_DEBUG_ENABLED = false
const RECENT_TTL_MS = 2_000
const recent = new Map<string, number>()

type BeaconInput = {
  sdk: ReturnType<typeof useSDK>
  event: string
  sessionID?: string
  messageID?: string
  payload?: Record<string, unknown>
}

function shouldSend(key: string) {
  const now = Date.now()
  for (const [entry, at] of recent.entries()) {
    if (now - at < RECENT_TTL_MS) continue
    recent.delete(entry)
  }
  const last = recent.get(key)
  if (last && now - last < RECENT_TTL_MS) return false
  recent.set(key, now)
  return true
}

export function sendSessionReloadDebugBeacon(input: BeaconInput) {
  if (typeof window === "undefined") return
  // Debug beacon kept for future RCA; disabled during normal operation.
  if (!SESSION_RELOAD_DEBUG_ENABLED) return
  const body = {
    source: "app.session-reload",
    event: input.event,
    directory: input.sdk.directory,
    sessionID: input.sessionID,
    messageID: input.messageID,
    payload: input.payload,
  }
  const key = JSON.stringify(body)
  if (!shouldSend(key)) return
  void input.sdk
    .fetch(`${input.sdk.url}/api/v2/experimental/debug-beacon`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      keepalive: true,
    })
    .catch(() => {})
}
