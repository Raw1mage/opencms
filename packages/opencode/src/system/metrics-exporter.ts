import { Bus } from "@/bus/index"
import { Log } from "@/util/log"

/**
 * MetricsExporter — in-process Prometheus exporter for opencode runtime
 * telemetry. Mirrors the Bus subscription pattern of telemetry-runtime.ts: it
 * subscribes globally to the telemetry events and projects them into bounded
 * in-memory counters / gauges, then renders Prometheus text format on demand.
 *
 * Cardinality discipline (spec DD-6): only low-cardinality labels
 * (provider/model/kind/finish_reason/result) are emitted. sessionID / accountId
 * / prompt content are NEVER label values.
 *
 * Counters are process-lifetime; on daemon restart they reset to zero, which
 * Prometheus rate()/increase() tolerate (spec DD-11 / R2).
 */
export namespace MetricsExporter {
  const log = Log.create({ service: "metrics-exporter" })

  // metricKey = `${name}\u0000${sortedLabelString}` → value
  const counters = new Map<string, number>()
  const gauges = new Map<string, number>()

  // sessionID → last-seen epoch ms, for the active-sessions gauge (computed at
  // render time over a sliding window; sessionID stays internal, never a label).
  const sessionLastSeen = new Map<string, number>()
  const ACTIVE_WINDOW_MS = 15 * 60 * 1000

  // Label metadata used at render time (name → {help, type}).
  const META: Record<string, { help: string; type: "counter" | "gauge" }> = {
    opencode_tokens_total: { help: "Total LLM tokens by provider/model/kind", type: "counter" },
    opencode_requests_total: { help: "Total LLM round requests by provider/model/finish_reason", type: "counter" },
    opencode_cost_total: { help: "Cumulative LLM cost (USD) by provider/model", type: "counter" },
    opencode_compaction_total: { help: "Total compaction attempts by result", type: "counter" },
    opencode_rounds_total: { help: "Total session rounds observed", type: "counter" },
    opencode_active_sessions: { help: "Sessions with telemetry in the last 15 minutes", type: "gauge" },
    opencode_context_ratio: { help: "Latest observed/context-limit token ratio by provider/model", type: "gauge" },
  }

  function labelKey(labels: Record<string, string>) {
    const keys = Object.keys(labels).sort()
    return keys.map((k) => `${k}=${labels[k]}`).join("\u0001")
  }

  function metricKey(name: string, labels: Record<string, string>) {
    return `${name}\u0000${labelKey(labels)}`
  }

  function inc(name: string, labels: Record<string, string>, by = 1) {
    if (!Number.isFinite(by) || by === 0) return
    const key = metricKey(name, labels)
    counters.set(key, (counters.get(key) ?? 0) + by)
  }

  function setGauge(name: string, labels: Record<string, string>, value: number) {
    if (!Number.isFinite(value)) return
    gauges.set(metricKey(name, labels), value)
  }

  function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0
  }

  function str(v: unknown, fallback = "unknown"): string {
    return typeof v === "string" && v.length > 0 ? v : fallback
  }

  function onEvent(event: { type: string; properties?: unknown }) {
    const p = (event.properties && typeof event.properties === "object" ? event.properties : {}) as Record<
      string,
      unknown
    >

    if (event.type === "session.round.telemetry") {
      const provider = str(p.providerId)
      const model = str(p.modelId)
      const finishReason = str(p.finishReason)
      const sessionID = typeof p.sessionID === "string" ? p.sessionID : undefined

      inc("opencode_requests_total", { provider, model, finish_reason: finishReason })
      inc("opencode_rounds_total", {})
      inc("opencode_tokens_total", { provider, model, kind: "input" }, num(p.inputTokens))
      inc("opencode_tokens_total", { provider, model, kind: "output" }, num(p.outputTokens))
      inc("opencode_tokens_total", { provider, model, kind: "cache_read" }, num(p.cacheReadTokens))
      inc("opencode_tokens_total", { provider, model, kind: "cache_write" }, num(p.cacheWriteTokens))
      inc("opencode_cost_total", { provider, model }, num(p.cost))

      const observed = num(p.observedTokens)
      const limit = num(p.contextLimit)
      if (limit > 0) setGauge("opencode_context_ratio", { provider, model }, observed / limit)

      if (sessionID) sessionLastSeen.set(sessionID, Date.now())
      return
    }

    if (event.type === "session.compaction.telemetry") {
      const result = str(p.compactionResult)
      inc("opencode_compaction_total", { result })
      const sessionID = typeof p.sessionID === "string" ? p.sessionID : undefined
      if (sessionID) sessionLastSeen.set(sessionID, Date.now())
      return
    }
  }

  let registered = false

  export function register() {
    if (registered) return
    registered = true
    Bus.subscribeGlobal("*", 0, onEvent)
    log.info("metrics exporter registered")
  }

  function escapeLabelValue(v: string) {
    return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')
  }

  function renderLine(name: string, labelStr: string, value: number) {
    const labels: string[] = []
    if (labelStr) {
      for (const pair of labelStr.split("\u0001")) {
        const eq = pair.indexOf("=")
        if (eq < 0) continue
        const k = pair.slice(0, eq)
        const v = pair.slice(eq + 1)
        labels.push(`${k}="${escapeLabelValue(v)}"`)
      }
    }
    const labelBlock = labels.length ? `{${labels.join(",")}}` : ""
    return `${name}${labelBlock} ${value}`
  }

  export function render(): string {
    // Recompute the active-sessions gauge over the sliding window.
    const now = Date.now()
    let active = 0
    for (const [sid, ts] of sessionLastSeen) {
      if (now - ts <= ACTIVE_WINDOW_MS) active++
      else sessionLastSeen.delete(sid)
    }
    setGauge("opencode_active_sessions", {}, active)

    // Group emitted series by metric name so we can print HELP/TYPE once.
    const byName = new Map<string, { labelStr: string; value: number }[]>()
    const collect = (store: Map<string, number>) => {
      for (const [key, value] of store) {
        const sep = key.indexOf("\u0000")
        const name = key.slice(0, sep)
        const labelStr = key.slice(sep + 1)
        if (!byName.has(name)) byName.set(name, [])
        byName.get(name)!.push({ labelStr, value })
      }
    }
    collect(counters)
    collect(gauges)

    const out: string[] = []
    for (const name of Object.keys(META)) {
      const series = byName.get(name)
      if (!series || series.length === 0) continue
      out.push(`# HELP ${name} ${META[name].help}`)
      out.push(`# TYPE ${name} ${META[name].type}`)
      for (const s of series) out.push(renderLine(name, s.labelStr, s.value))
    }
    return out.join("\n") + "\n"
  }
}
