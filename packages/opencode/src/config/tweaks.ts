import { Log } from "../util/log"

const log = Log.create({ service: "tweaks" })

const TWEAKS_PATH_DEFAULT = "/etc/opencode/tweaks.cfg"
const TWEAKS_PATH_ENV = "OPENCODE_TWEAKS_PATH"

/**
 * Operator-facing tunables loaded from /etc/opencode/tweaks.cfg.
 *
 * Format: INI-style `key=value` per line; `#` and `;` introduce comments;
 * blank lines ignored; unknown keys warned and ignored.
 *
 * Contract:
 * - Missing file → defaults + single log.info at startup.
 * - Present key with invalid value → log.warn + per-key default fallback.
 *   (NOT silent — AGENTS.md rule 1.)
 * - Values are read once at module init via loadEffective(); callers must
 *   restart the daemon to re-read (consistent with how opencode.cfg works).
 */
export namespace Tweaks {
  export interface SessionCacheConfig {
    enabled: boolean
    ttlSec: number
    maxEntries: number
  }

  export interface RateLimitConfig {
    enabled: boolean
    qpsPerUserPerPath: number
    burst: number
  }

  export interface Effective {
    sessionCache: SessionCacheConfig
    rateLimit: RateLimitConfig
    source: { path: string; present: boolean }
  }

  const SESSION_CACHE_DEFAULTS: SessionCacheConfig = {
    enabled: true,
    ttlSec: 60,
    maxEntries: 500,
  }

  const RATE_LIMIT_DEFAULTS: RateLimitConfig = {
    enabled: true,
    qpsPerUserPerPath: 10,
    burst: 20,
  }

  function path(): string {
    return process.env[TWEAKS_PATH_ENV] || TWEAKS_PATH_DEFAULT
  }

  function parseBool(raw: string, key: string): boolean | undefined {
    const normalized = raw.trim().toLowerCase()
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false
    log.warn("tweaks.cfg invalid boolean for " + key, { raw })
    return undefined
  }

  function parseInt10(raw: string, key: string, min?: number): number | undefined {
    const value = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      log.warn("tweaks.cfg invalid integer for " + key, { raw })
      return undefined
    }
    if (min !== undefined && value < min) {
      log.warn("tweaks.cfg value below minimum for " + key, { raw, value, min })
      return undefined
    }
    return value
  }

  function parseFloatPositive(raw: string, key: string): number | undefined {
    const value = Number.parseFloat(raw.trim())
    if (!Number.isFinite(value) || value <= 0) {
      log.warn("tweaks.cfg invalid positive number for " + key, { raw })
      return undefined
    }
    return value
  }

  function parseLines(body: string): Map<string, string> {
    const out = new Map<string, string>()
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line === "") continue
      if (line.startsWith("#") || line.startsWith(";")) continue
      const eqIdx = line.indexOf("=")
      if (eqIdx <= 0) {
        log.warn("tweaks.cfg ignoring malformed line", { line })
        continue
      }
      const key = line.slice(0, eqIdx).trim()
      const value = line.slice(eqIdx + 1).trim()
      if (key === "") {
        log.warn("tweaks.cfg ignoring empty key", { line })
        continue
      }
      out.set(key, value)
    }
    return out
  }

  const KNOWN_KEYS = new Set<string>([
    "session_cache_enabled",
    "session_cache_ttl_sec",
    "session_cache_max_entries",
    "ratelimit_enabled",
    "ratelimit_qps_per_user_per_path",
    "ratelimit_burst",
  ])

  async function readRaw(): Promise<{ body?: string; present: boolean }> {
    const file = Bun.file(path())
    if (!(await file.exists())) return { present: false }
    const body = await file.text()
    return { body, present: true }
  }

  let _effective: Effective | undefined
  let _loadPromise: Promise<Effective> | undefined

  async function computeEffective(): Promise<Effective> {
    const { body, present } = await readRaw()
    const cfgPath = path()
    if (!present) {
      log.info("tweaks.cfg not found; using defaults", {
        path: cfgPath,
        defaults: { sessionCache: SESSION_CACHE_DEFAULTS, rateLimit: RATE_LIMIT_DEFAULTS },
      })
      return {
        sessionCache: { ...SESSION_CACHE_DEFAULTS },
        rateLimit: { ...RATE_LIMIT_DEFAULTS },
        source: { path: cfgPath, present: false },
      }
    }

    const parsed = parseLines(body ?? "")
    for (const key of parsed.keys()) {
      if (!KNOWN_KEYS.has(key)) {
        log.warn("tweaks.cfg unknown key", { key, path: cfgPath })
      }
    }

    const sessionCache: SessionCacheConfig = { ...SESSION_CACHE_DEFAULTS }
    const rateLimit: RateLimitConfig = { ...RATE_LIMIT_DEFAULTS }

    const enabledRaw = parsed.get("session_cache_enabled")
    if (enabledRaw !== undefined) {
      const v = parseBool(enabledRaw, "session_cache_enabled")
      if (v !== undefined) sessionCache.enabled = v
    }

    const ttlRaw = parsed.get("session_cache_ttl_sec")
    if (ttlRaw !== undefined) {
      const v = parseInt10(ttlRaw, "session_cache_ttl_sec", 0)
      if (v !== undefined) sessionCache.ttlSec = v
    }

    const maxRaw = parsed.get("session_cache_max_entries")
    if (maxRaw !== undefined) {
      const v = parseInt10(maxRaw, "session_cache_max_entries", 1)
      if (v !== undefined) sessionCache.maxEntries = v
    }

    const rlEnabledRaw = parsed.get("ratelimit_enabled")
    if (rlEnabledRaw !== undefined) {
      const v = parseBool(rlEnabledRaw, "ratelimit_enabled")
      if (v !== undefined) rateLimit.enabled = v
    }

    const qpsRaw = parsed.get("ratelimit_qps_per_user_per_path")
    if (qpsRaw !== undefined) {
      const v = parseFloatPositive(qpsRaw, "ratelimit_qps_per_user_per_path")
      if (v !== undefined) rateLimit.qpsPerUserPerPath = v
    }

    const burstRaw = parsed.get("ratelimit_burst")
    if (burstRaw !== undefined) {
      const v = parseInt10(burstRaw, "ratelimit_burst", 1)
      if (v !== undefined) rateLimit.burst = v
    }

    log.info("tweaks.cfg loaded", { path: cfgPath, effective: { sessionCache, rateLimit } })
    return {
      sessionCache,
      rateLimit,
      source: { path: cfgPath, present: true },
    }
  }

  async function effective(): Promise<Effective> {
    if (_effective) return _effective
    if (!_loadPromise) _loadPromise = computeEffective().then((e) => (_effective = e))
    return _loadPromise
  }

  export async function sessionCache(): Promise<SessionCacheConfig> {
    return (await effective()).sessionCache
  }

  export async function rateLimit(): Promise<RateLimitConfig> {
    return (await effective()).rateLimit
  }

  export async function loadEffective(): Promise<Effective> {
    return effective()
  }

  /**
   * For tests: force reload on next call.
   */
  export function resetForTesting() {
    _effective = undefined
    _loadPromise = undefined
  }
}
