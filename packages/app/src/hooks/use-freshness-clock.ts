import { createSignal, type Accessor } from "solid-js"

// session-ui-freshness DD-2: a single module-level signal ticks every second
// and is shared by every freshness-aware memo. This avoids per-component
// setInterval, which would drift across renders and multiply timer count with
// UI entry count. First import of this module starts the interval; subsequent
// imports observe the same signal.

const TICK_INTERVAL_MS = 1000

const [freshnessNow, setFreshnessNow] = createSignal(Date.now())

let tickHandle: ReturnType<typeof setInterval> | null = null

function ensureTickStarted(): void {
  if (tickHandle !== null) return
  if (typeof setInterval !== "function") return // SSR guard
  tickHandle = setInterval(() => {
    setFreshnessNow(Date.now())
  }, TICK_INTERVAL_MS)
}

ensureTickStarted()

// observability.md §Dev console helper — expose current tick value under
// window.__opencodeDebug for manual inspection. Dev-only; no-op in production
// and in non-browser environments.
if (typeof window !== "undefined") {
  const meta = import.meta as unknown as { env?: { DEV?: boolean } }
  if (meta.env?.DEV) {
    const anyWindow = window as unknown as { __opencodeDebug?: Record<string, unknown> }
    anyWindow.__opencodeDebug = {
      ...(anyWindow.__opencodeDebug ?? {}),
      freshnessNow: () => freshnessNow(),
    }
  }
}

/**
 * Subscribe to the shared freshness clock. Calling this hook does NOT start
 * a new timer — it reuses the module-level singleton. The returned accessor
 * is a Solid signal that reactively updates every 1s.
 */
export function useFreshnessClock(): { freshnessNow: Accessor<number> } {
  return { freshnessNow }
}

export { freshnessNow }

// Test helpers — stop the tick or inject a deterministic value. Not for
// production use; consumers that need to freeze the clock in unit tests should
// import these directly.
export function __stopFreshnessClockForTest(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle)
    tickHandle = null
  }
}

export function __setFreshnessNowForTest(value: number): void {
  setFreshnessNow(value)
}
