import type { CronSchedule } from "./api"

/**
 * Human-readable display of a cron schedule.
 */
export function CronScheduleDisplay(props: { schedule: CronSchedule }) {
  const label = () => {
    const s = props.schedule
    if (s.kind === "at") return `Once at ${s.at}`
    if (s.kind === "every") return `Every ${formatDuration(s.everyMs)}`
    if (s.kind === "cron") return s.expr + (s.tz ? ` (${s.tz})` : "")
    return "Unknown"
  }

  return (
    <code class="text-12-medium text-accent-base font-mono bg-background-input rounded px-1.5 py-0.5">
      {label()}
    </code>
  )
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

export function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) {
    // Future
    const abs = Math.abs(diff)
    if (abs < 60_000) return `in ${Math.round(abs / 1000)}s`
    if (abs < 3_600_000) return `in ${Math.round(abs / 60_000)}m`
    if (abs < 86_400_000) return `in ${(abs / 3_600_000).toFixed(1)}h`
    return `in ${(abs / 86_400_000).toFixed(1)}d`
  }
  // Past
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${(diff / 3_600_000).toFixed(1)}h ago`
  return `${(diff / 86_400_000).toFixed(1)}d ago`
}

/**
 * Crontab 5-field presets.
 */
export const CRON_PRESETS = [
  { label: "Every minute", expr: "* * * * *" },
  { label: "Every 5 minutes", expr: "*/5 * * * *" },
  { label: "Every 15 minutes", expr: "*/15 * * * *" },
  { label: "Every 30 minutes", expr: "*/30 * * * *" },
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Every 6 hours", expr: "0 */6 * * *" },
  { label: "Daily at midnight", expr: "0 0 * * *" },
  { label: "Daily at 9 AM", expr: "0 9 * * *" },
  { label: "Weekdays at 9 AM", expr: "0 9 * * 1-5" },
  { label: "Weekly (Sunday midnight)", expr: "0 0 * * 0" },
] as const

/**
 * Describe a 5-field cron expression in human-readable text.
 */
export function describeCronExpr(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  const preset = CRON_PRESETS.find((p) => p.expr === expr)
  if (preset) return preset.label

  const [min, hour, dom, mon, dow] = parts
  const segments: string[] = []

  if (min === "*" && hour === "*") segments.push("Every minute")
  else if (min?.startsWith("*/")) segments.push(`Every ${min.slice(2)} minutes`)
  else if (hour === "*") segments.push(`At minute ${min}`)
  else if (hour?.startsWith("*/")) segments.push(`Every ${hour.slice(2)} hours at :${min?.padStart(2, "0")}`)
  else segments.push(`At ${hour}:${min?.padStart(2, "0")}`)

  if (dom !== "*") segments.push(`on day ${dom}`)
  if (mon !== "*") segments.push(`in month ${mon}`)
  if (dow !== "*") segments.push(`on ${dow}`)

  return segments.join(" ")
}
