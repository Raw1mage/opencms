import type { MiddlewareHandler } from "hono"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { Tweaks } from "../config/tweaks"
import { RequestUser } from "@/runtime/request-user"
import { registerRateLimitStatsProvider } from "./routes/cache-health"

const log = Log.create({ service: "rate-limit" })

/**
 * Per-(username, method, routePattern) token bucket rate limiter.
 *
 * Middleware behavior:
 *   - Compute bucket key from username + HTTP method + normalized route.
 *   - Exempt any request matching the EXEMPT_PATH_PREFIXES list or originating
 *     from the internal worker hostname (opencode.internal).
 *   - If tokens are available → consume one, proceed.
 *   - If bucket empty → emit 429 with Retry-After header and JSON code body.
 *
 * Tunables (/etc/opencode/tweaks.cfg via config/tweaks.ts):
 *   - ratelimit_enabled=0 disables the middleware entirely (daemon startup
 *     logs the bypass once).
 *   - ratelimit_qps_per_user_per_path controls the token refill rate.
 *   - ratelimit_burst controls bucket capacity.
 */
export namespace RateLimit {
  export interface BucketState {
    tokens: number
    lastRefillAt: number
  }

  const AllowedSchema = z.object({
    username: z.string(),
    method: z.string(),
    routePattern: z.string(),
    tokensRemaining: z.number(),
  })
  const ThrottledSchema = z.object({
    username: z.string(),
    method: z.string(),
    routePattern: z.string(),
    retryAfterSec: z.number().int().min(1),
  })

  export const Event = {
    Allowed: BusEvent.define("rate-limit.allowed", AllowedSchema),
    Throttled: BusEvent.define("rate-limit.throttled", ThrottledSchema),
  }

  /**
   * Paths or path prefixes that bypass the rate limiter entirely.
   * Ordered for readability; matching is linear but the list is small.
   */
  const EXEMPT_PATH_PREFIXES: ReadonlyArray<string> = [
    "/log",
    "/api/v2/global/health",
    "/api/v2/global/log",
    "/api/v2/server/cache/health",
    "/api/v2/server/",
  ]

  /**
   * Known opencode ID prefixes (see src/id/id.ts). Segments matching
   * `<prefix>_<20+ alnum>` are collapsed to `:id` so per-session paths
   * share a single bucket key rather than fragmenting the limiter.
   */
  const ID_PREFIXES = ["ses", "msg", "per", "que", "usr", "prt", "pty", "tool"]
  const ID_SEGMENT_RE = new RegExp(`^(${ID_PREFIXES.join("|")})_[A-Za-z0-9]{20,}$`)

  export function normalizeRoutePattern(path: string): string {
    const segments = path.split("/")
    const normalized = segments.map((seg) => (ID_SEGMENT_RE.test(seg) ? ":id" : seg))
    return normalized.join("/")
  }

  function isExempt(path: string, hostname: string): boolean {
    if (hostname === "opencode.internal") return true
    for (const prefix of EXEMPT_PATH_PREFIXES) {
      if (path === prefix || path.startsWith(prefix)) return true
    }
    return false
  }

  const buckets = new Map<string, BucketState>()
  let allowed = 0
  let throttled = 0
  let statsRegistered = false

  function stats() {
    return {
      allowedCount: allowed,
      throttledCount: throttled,
      activeBuckets: buckets.size,
    }
  }

  function refill(bucket: BucketState, now: number, refillPerSec: number, capacity: number): void {
    const elapsed = (now - bucket.lastRefillAt) / 1000
    if (elapsed <= 0) return
    const add = elapsed * refillPerSec
    bucket.tokens = Math.min(capacity, bucket.tokens + add)
    bucket.lastRefillAt = now
  }

  function take(key: string, refillPerSec: number, capacity: number): { ok: true; remaining: number } | { ok: false; retryAfterSec: number } {
    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillAt: now }
      buckets.set(key, bucket)
    } else {
      refill(bucket, now, refillPerSec, capacity)
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { ok: true, remaining: bucket.tokens }
    }
    const missing = 1 - bucket.tokens
    const retryAfterSec = Math.max(1, Math.ceil(missing / refillPerSec))
    return { ok: false, retryAfterSec }
  }

  /**
   * For daemon startup: emit a single log line reflecting the configured
   * behavior. Silent "off" state is a violation of AGENTS.md rule 1.
   */
  export async function logStartup(): Promise<void> {
    const cfg = await Tweaks.rateLimit()
    if (!cfg.enabled) {
      log.info("rate-limit disabled via tweaks", {
        qps: cfg.qpsPerUserPerPath,
        burst: cfg.burst,
      })
    } else {
      log.info("rate-limit enabled", {
        qps: cfg.qpsPerUserPerPath,
        burst: cfg.burst,
        exempt: EXEMPT_PATH_PREFIXES.length,
      })
    }
    if (!statsRegistered) {
      registerRateLimitStatsProvider(stats)
      statsRegistered = true
    }
  }

  export function middleware(): MiddlewareHandler {
    return async (c, next) => {
      const cfg = await Tweaks.rateLimit()
      if (!cfg.enabled) {
        await next()
        return
      }

      const hostname = (() => {
        try {
          return new URL(c.req.url).hostname
        } catch {
          return ""
        }
      })()
      if (isExempt(c.req.path, hostname)) {
        await next()
        return
      }

      const username = RequestUser.username() ?? ""
      if (!username) {
        // E-RATE-002: cannot attribute request to a user → bypass with warn.
        log.warn("rate-limit bypassed", { path: c.req.path, reason: "no-username" })
        await next()
        return
      }

      const routePattern = normalizeRoutePattern(c.req.path)
      const key = `${username}:${c.req.method}:${routePattern}`
      const result = take(key, cfg.qpsPerUserPerPath, cfg.burst)
      if (result.ok) {
        allowed += 1
        void Bus.publish(Event.Allowed, {
          username,
          method: c.req.method,
          routePattern,
          tokensRemaining: result.remaining,
        })
        await next()
        return
      }

      throttled += 1
      void Bus.publish(Event.Throttled, {
        username,
        method: c.req.method,
        routePattern,
        retryAfterSec: result.retryAfterSec,
      })
      log.warn("rate-limit throttled", {
        username,
        method: c.req.method,
        path: c.req.path,
        routePattern,
        retryAfterSec: result.retryAfterSec,
      })
      c.header("Retry-After", String(result.retryAfterSec))
      return c.json(
        {
          code: "RATE_LIMIT",
          message: "Too many requests",
          path: routePattern,
          retryAfterSec: result.retryAfterSec,
        },
        429,
      )
    }
  }

  export function resetForTesting(): void {
    buckets.clear()
    allowed = 0
    throttled = 0
    statsRegistered = false
  }

  export const __test__ = { take, normalizeRoutePattern, isExempt, stats }
}
