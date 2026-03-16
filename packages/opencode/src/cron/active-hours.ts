import { Log } from "../util/log"

/**
 * Active hours gating (D.2.3) — suppress triggers outside configured windows.
 *
 * IDEF0 reference: A22 (Gate Active Hours Window)
 * GRAFCET reference: opencode_a2_grafcet.json steps S1, S4
 */
export namespace ActiveHours {
  const log = Log.create({ service: "cron.active-hours" })

  export type Config = {
    start: string // "HH:MM" in 24h format
    end: string // "HH:MM" in 24h format
    tz?: string // IANA timezone (default: system local)
  }

  export type GateResult =
    | { allowed: true }
    | { allowed: false; nextEligibleMs: number }

  /**
   * Check if the current time falls within active hours.
   * Returns the next eligible time if outside the window.
   */
  export function check(
    config: Config | undefined,
    nowMs: number = Date.now(),
  ): GateResult {
    if (!config) return { allowed: true }

    const { startMinutes, endMinutes } = parseWindow(config)
    const currentMinutes = getCurrentMinutes(nowMs, config.tz)

    const isInWindow = startMinutes <= endMinutes
      ? currentMinutes >= startMinutes && currentMinutes < endMinutes
      : currentMinutes >= startMinutes || currentMinutes < endMinutes // overnight wrap

    if (isInWindow) {
      return { allowed: true }
    }

    // Compute next eligible time
    const nextEligibleMs = computeNextWindowOpen(startMinutes, currentMinutes, nowMs, config.tz)
    log.info("outside active hours", {
      current: formatMinutes(currentMinutes),
      window: `${config.start}-${config.end}`,
      nextEligible: new Date(nextEligibleMs).toISOString(),
    })
    return { allowed: false, nextEligibleMs }
  }

  function parseWindow(config: Config): { startMinutes: number; endMinutes: number } {
    return {
      startMinutes: parseHHMM(config.start),
      endMinutes: parseHHMM(config.end),
    }
  }

  function parseHHMM(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number)
    return h * 60 + m
  }

  function formatMinutes(minutes: number): string {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  }

  function getCurrentMinutes(nowMs: number, tz?: string): number {
    if (!tz) {
      const d = new Date(nowMs)
      return d.getHours() * 60 + d.getMinutes()
    }

    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    const parts = formatter.formatToParts(new Date(nowMs))
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0")
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0")
    return hour * 60 + minute
  }

  function computeNextWindowOpen(
    startMinutes: number,
    currentMinutes: number,
    nowMs: number,
    tz?: string,
  ): number {
    // How many minutes until the window opens
    let minutesUntilOpen = startMinutes - currentMinutes
    if (minutesUntilOpen <= 0) minutesUntilOpen += 24 * 60

    return nowMs + minutesUntilOpen * 60 * 1000
  }
}
