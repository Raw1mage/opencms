type GaugeValue = string | number | boolean | null

type ScopeApi = {
  hit(name: string, count?: number): void
  setGauge(name: string, value: GaugeValue): void
}

const enabled = process.env.OPENCODE_ACTIVITY_BEACON === "1"
const intervalMs = (() => {
  const raw = process.env.OPENCODE_ACTIVITY_BEACON_INTERVAL_MS
  if (!raw) return 1000
  const n = Number(raw)
  if (!Number.isFinite(n)) return 1000
  return Math.max(200, Math.min(60_000, Math.floor(n)))
})()

const counters = new Map<string, number>()
const gauges = new Map<string, GaugeValue>()
const previousCounters = new Map<string, number>()

let timer: ReturnType<typeof setInterval> | undefined
let previousCpu = process.cpuUsage()
let previousHrtime = process.hrtime.bigint()

function safeThreadCount() {
  try {
    return readdirSync("/proc/self/task").length
  } catch {
    return undefined
  }
}

function start() {
  if (!enabled || timer) return
  timer = setInterval(() => {
    const nowCpu = process.cpuUsage()
    const nowHr = process.hrtime.bigint()
    const deltaCpuUs = nowCpu.user - previousCpu.user + (nowCpu.system - previousCpu.system)
    const deltaElapsedUs = Number(nowHr - previousHrtime) / 1000
    const cpuPct = deltaElapsedUs > 0 ? Number(((deltaCpuUs / deltaElapsedUs) * 100).toFixed(2)) : 0
    previousCpu = nowCpu
    previousHrtime = nowHr

    const deltaCounters: Record<string, number> = {}
    for (const [key, value] of counters.entries()) {
      const prev = previousCounters.get(key) ?? 0
      const delta = value - prev
      if (delta !== 0) deltaCounters[key] = delta
      previousCounters.set(key, value)
    }

    const payload = {
      type: "activity-beacon",
      pid: process.pid,
      ppid: process.ppid,
      cpuPct,
      threads: safeThreadCount(),
      counters: deltaCounters,
      gauges: Object.fromEntries(gauges.entries()),
      ts: Date.now(),
    }

    process.stderr.write(`__OPENCODE_ACTIVITY__ ${JSON.stringify(payload)}\n`)
  }, intervalMs)
  if (typeof timer.unref === "function") timer.unref()
}

start()

function bump(key: string, count = 1) {
  if (!enabled) return
  counters.set(key, (counters.get(key) ?? 0) + count)
}

function putGauge(key: string, value: GaugeValue) {
  if (!enabled) return
  gauges.set(key, value)
}

export const ActivityBeacon = {
  enabled,
  scope(scope: string): ScopeApi {
    return {
      hit(name: string, count = 1) {
        bump(`${scope}.${name}`, count)
      },
      setGauge(name: string, value: GaugeValue) {
        putGauge(`${scope}.${name}`, value)
      },
    }
  },
}
import { readdirSync } from "node:fs"
