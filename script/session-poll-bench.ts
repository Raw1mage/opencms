#!/usr/bin/env bun
/**
 * Acceptance bench for specs/session-poll-cache AC-1 / AC-2.
 *
 * What it measures:
 *   - p50 / p95 handler latency (as seen by the client) for
 *     GET /api/v2/session/{id}/message under steady polling.
 *   - 304 response ratio when If-None-Match is honored.
 *   - A CPU-sample helper hooked into `ps` for the daemon PID.
 *
 * What it does NOT do:
 *   - Start or stop a daemon — this is an ops-side runbook. You point
 *     the bench at a daemon you already control.
 *   - Assert AC thresholds automatically — just reports the numbers.
 *     The human runs the bench before (`session_cache_enabled=0`) and
 *     after (`session_cache_enabled=1`) to confirm:
 *       - AC-1: avg daemon CPU under 20 QPS polling drops from ~44%
 *         baseline to <10% with cache on.
 *       - AC-2: with `If-None-Match` round-tripping, >95% of responses
 *         are 304 when the session is idle.
 *
 * Flags:
 *   --base=http://localhost:1080   (or unix-socket URL)
 *   --session=<sessionID>          required
 *   --qps=20                       target steady-state rate
 *   --seconds=300                  total duration
 *   --csrf=<token>                 if the server requires CSRF (mutation routes only)
 *   --username=<u>                 X-Opencode-Username header (optional)
 *   --etag-roundtrip=1             (default) echo If-None-Match on every
 *                                  call after the first 200 response
 *   --daemon-pid=<pid>             enable `ps` CPU sampling for this PID
 *   --cpu-sample-sec=5             how often to sample /proc/<pid>/stat
 *
 * Example:
 *   bun run script/session-poll-bench.ts \
 *     --base=http://localhost:1080 \
 *     --session=ses_25e814667ffeSkfR94oy7kvI3l \
 *     --qps=20 --seconds=300 --daemon-pid=1369291
 */

interface Args {
  base: string
  session: string
  qps: number
  seconds: number
  csrf?: string
  username?: string
  etagRoundtrip: boolean
  daemonPid?: number
  cpuSampleSec: number
}

function parseArgs(): Args {
  const out: Partial<Args> = { etagRoundtrip: true, cpuSampleSec: 5 }
  for (const arg of Bun.argv.slice(2)) {
    const [kRaw, vRaw] = arg.replace(/^--/, "").split("=")
    const k = kRaw
    const v = vRaw ?? ""
    if (k === "base") out.base = v
    else if (k === "session") out.session = v
    else if (k === "qps") out.qps = Number(v)
    else if (k === "seconds") out.seconds = Number(v)
    else if (k === "csrf") out.csrf = v
    else if (k === "username") out.username = v
    else if (k === "etag-roundtrip") out.etagRoundtrip = v !== "0" && v !== "false"
    else if (k === "daemon-pid") out.daemonPid = Number(v)
    else if (k === "cpu-sample-sec") out.cpuSampleSec = Number(v)
  }
  if (!out.base || !out.session || !out.qps || !out.seconds) {
    console.error("usage: session-poll-bench --base=<url> --session=<id> --qps=<n> --seconds=<n>")
    process.exit(2)
  }
  return out as Args
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

async function sampleProcCpu(pid: number): Promise<{ utimeTicks: number; stimeTicks: number } | null> {
  try {
    const body = await Bun.file(`/proc/${pid}/stat`).text()
    const fields = body.split(" ")
    // stat format: pid (comm) state ppid ... utime=14 stime=15 (1-indexed)
    const utime = Number(fields[13])
    const stime = Number(fields[14])
    if (Number.isFinite(utime) && Number.isFinite(stime)) {
      return { utimeTicks: utime, stimeTicks: stime }
    }
  } catch {
    // ignore
  }
  return null
}

async function main() {
  const args = parseArgs()
  const url = `${args.base.replace(/\/$/, "")}/api/v2/session/${args.session}/message?limit=400`
  const headers: Record<string, string> = {}
  if (args.csrf) headers["x-opencode-csrf"] = args.csrf
  if (args.username) headers["x-opencode-username"] = args.username

  let lastEtag: string | null = null
  const statuses = new Map<number, number>()
  const latenciesMs: number[] = []
  let requestsSent = 0

  const startMs = Date.now()
  const endMs = startMs + args.seconds * 1000

  const cpuHistory: Array<{ elapsedSec: number; utime: number; stime: number; total: number }> = []
  let cpuLast: { utimeTicks: number; stimeTicks: number } | null = null
  if (args.daemonPid) {
    cpuLast = await sampleProcCpu(args.daemonPid)
  }

  const perTickIntervalMs = Math.max(1, Math.floor(1000 / args.qps))

  // Drive requests at ~args.qps using a setInterval-equivalent loop.
  async function oneRequest() {
    const h: Record<string, string> = { ...headers }
    if (args.etagRoundtrip && lastEtag) h["if-none-match"] = lastEtag
    const t0 = performance.now()
    let status = 0
    let etagHeader: string | null = null
    try {
      const res = await fetch(url, { headers: h })
      status = res.status
      etagHeader = res.headers.get("etag")
      // Drain body to keep accounting fair.
      if (res.status === 200) await res.arrayBuffer()
    } catch (err) {
      status = -1
    }
    const dt = performance.now() - t0
    latenciesMs.push(dt)
    statuses.set(status, (statuses.get(status) ?? 0) + 1)
    if (status === 200 && etagHeader) lastEtag = etagHeader
    requestsSent += 1
  }

  const cpuSamplerStarted = Date.now()
  const cpuSamplerHandle = args.daemonPid
    ? setInterval(async () => {
        const now = await sampleProcCpu(args.daemonPid!)
        if (now && cpuLast) {
          const dU = now.utimeTicks - cpuLast.utimeTicks
          const dS = now.stimeTicks - cpuLast.stimeTicks
          cpuHistory.push({
            elapsedSec: (Date.now() - cpuSamplerStarted) / 1000,
            utime: dU,
            stime: dS,
            total: dU + dS,
          })
          cpuLast = now
        }
      }, args.cpuSampleSec * 1000)
    : null

  // Simple pacer — one inflight at a time; that keeps the bench honest about
  // per-request latency (parallelism is a different knob).
  while (Date.now() < endMs) {
    const tickStart = Date.now()
    await oneRequest()
    const spent = Date.now() - tickStart
    const remaining = perTickIntervalMs - spent
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining))
  }
  if (cpuSamplerHandle) clearInterval(cpuSamplerHandle)

  const sorted = [...latenciesMs].sort((a, b) => a - b)
  const total = sorted.length
  const total304 = statuses.get(304) ?? 0
  const total200 = statuses.get(200) ?? 0

  const report = {
    bench: {
      url,
      qps_target: args.qps,
      seconds: args.seconds,
      etag_roundtrip: args.etagRoundtrip,
    },
    requests: { sent: requestsSent, total_timed: total, by_status: Object.fromEntries(statuses) },
    latency_ms: {
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1) ?? 0,
    },
    ratios: {
      status_304: total > 0 ? total304 / total : 0,
      status_200: total > 0 ? total200 / total : 0,
    },
    cpu_samples: cpuHistory,
    cpu_summary: cpuHistory.length
      ? {
          samples: cpuHistory.length,
          sum_total_ticks: cpuHistory.reduce((a, b) => a + b.total, 0),
          avg_ticks_per_sample: cpuHistory.reduce((a, b) => a + b.total, 0) / cpuHistory.length,
        }
      : null,
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
