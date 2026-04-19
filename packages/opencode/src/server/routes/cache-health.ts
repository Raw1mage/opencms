import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
import { Tweaks } from "../../config/tweaks"

const log = Log.create({ service: "cache-health" })

/**
 * Cache + rate-limit health endpoint.
 *
 * Used for ops visibility and for AC-5 (detect silent invalidation failure).
 * Must NOT pass through the rate-limit middleware (that would create a
 * feedback loop when rate-limit pressure makes ops unable to inspect it).
 *
 * Phase 1 ships with placeholder stats; Phase 5 wires real counters from
 * session-cache.ts and rate-limit.ts via bus event subscribers.
 */

const CacheHealthSchema = z.object({
  entries: z.number().int().min(0),
  maxEntries: z.number().int().min(1),
  hitRate: z.number().min(0).max(1),
  missRate: z.number().min(0).max(1),
  invalidationCount: z.number().int().min(0),
  evictionCount: z.number().int().min(0),
  subscriptionAlive: z.boolean(),
  ttlSec: z.number().int().min(0),
  rateLimit: z.object({
    enabled: z.boolean(),
    allowedCount: z.number().int().min(0),
    throttledCount: z.number().int().min(0),
    activeBuckets: z.number().int().min(0),
  }),
  source: z.object({
    path: z.string(),
    present: z.boolean(),
  }),
})

export type CacheHealth = z.infer<typeof CacheHealthSchema>

/**
 * Pluggable stats providers. Phase 5 will register real implementations from
 * session-cache.ts and rate-limit.ts; until then the defaults return empty
 * placeholders so the endpoint still serves a valid response.
 */
export interface CacheStats {
  entries: number
  hitRate: number
  missRate: number
  invalidationCount: number
  evictionCount: number
  subscriptionAlive: boolean
}

export interface RateLimitStats {
  allowedCount: number
  throttledCount: number
  activeBuckets: number
}

type CacheStatsProvider = () => CacheStats
type RateLimitStatsProvider = () => RateLimitStats

const placeholderCache: CacheStatsProvider = () => ({
  entries: 0,
  hitRate: 0,
  missRate: 0,
  invalidationCount: 0,
  evictionCount: 0,
  subscriptionAlive: false,
})

const placeholderRateLimit: RateLimitStatsProvider = () => ({
  allowedCount: 0,
  throttledCount: 0,
  activeBuckets: 0,
})

let cacheProvider: CacheStatsProvider = placeholderCache
let rateLimitProvider: RateLimitStatsProvider = placeholderRateLimit

export function registerCacheStatsProvider(provider: CacheStatsProvider) {
  cacheProvider = provider
}

export function registerRateLimitStatsProvider(provider: RateLimitStatsProvider) {
  rateLimitProvider = provider
}

export const ServerRoutes = lazy(() =>
  new Hono().get(
    "/cache/health",
    describeRoute({
      summary: "Get session cache and rate-limit health",
      description:
        "Returns cache entry count, hit/miss rate over the past 5 minutes, " +
        "invalidation subscription liveness, and rate-limit usage. Used by " +
        "operators and by AC-5 drills to detect silent degradation.",
      operationId: "server.cacheHealth",
      responses: {
        200: {
          description: "Health snapshot",
          content: { "application/json": { schema: resolver(CacheHealthSchema) } },
        },
      },
    }),
    async (c) => {
      try {
        const cfg = await Tweaks.loadEffective()
        const cache = cacheProvider()
        const rl = rateLimitProvider()
        const body: CacheHealth = {
          entries: cache.entries,
          maxEntries: cfg.sessionCache.maxEntries,
          hitRate: cache.hitRate,
          missRate: cache.missRate,
          invalidationCount: cache.invalidationCount,
          evictionCount: cache.evictionCount,
          subscriptionAlive: cache.subscriptionAlive,
          ttlSec: cfg.sessionCache.ttlSec,
          rateLimit: {
            enabled: cfg.rateLimit.enabled,
            allowedCount: rl.allowedCount,
            throttledCount: rl.throttledCount,
            activeBuckets: rl.activeBuckets,
          },
          source: cfg.source,
        }
        return c.json(body)
      } catch (err) {
        log.error("cache-health stats failed", { error: err instanceof Error ? err.message : String(err) })
        return c.json(
          { code: "HEALTH_UNAVAILABLE", message: "cache stats unavailable" },
          503,
        )
      }
    },
  ),
)
