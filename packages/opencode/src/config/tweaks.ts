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

  /**
   * Tunables for the frontend-session-lazyload feature.
   * See specs/frontend-session-lazyload/data-schema.json#TweaksConfigKeys
   * and specs/frontend-session-lazyload/design.md DD-3/DD-7/DD-8.
   * Flag defaults OFF — client behavior is byte-equivalent to pre-plan main
   * until operator opts in (INV-2).
   */
  export interface FrontendLazyloadConfig {
    flag: 0 | 1
    partInlineCapKb: number
    tailWindowKb: number
    foldPreviewLines: number
    initialPageSizeSmall: "all" | number
    initialPageSizeMedium: number
    initialPageSizeLarge: number
    sessionSizeThresholdKb: number
    sessionSizeThresholdParts: number
    // Default `limit` for GET /:sessionID/message when the client omits it.
    // Bounds cold-open payload so long sessions don't full-hydrate on first
    // paint.
    sessionMessagesDefaultTail: number
    // mobile-tail-first-simplification DD-1 / DD-4. Platform-specific
    // tail-first limits + client store caps. The server exposes these
    // via /config/tweaks/frontend so the client picks the right value
    // for its platform at runtime.
    sessionTailMobile: number
    sessionTailDesktop: number
    sessionStoreCapMobile: number
    sessionStoreCapDesktop: number
    sessionPartCapBytes: number
  }

  /**
   * Tunables for the session-ui-freshness feature.
   * See specs/session-ui-freshness/data-schema.json#TweaksFrontendResponse
   * and specs/session-ui-freshness/design.md DD-3 / DD-5.
   * Flag defaults OFF — client UI is byte-equivalent to pre-plan baseline
   * until operator opts in.
   */
  export interface SessionUiFreshnessConfig {
    flag: 0 | 1
    softThresholdSec: number
    hardTimeoutSec: number
  }

  /**
   * Post-turn proactive rotation for codex / openai subscription accounts.
   * When the 5H hourly window drops below `lowQuotaThresholdPercent`
   * at the end of a runloop, mark the account rate-limited so the next
   * turn rotates away from it (QUOTA_EXHAUSTED path in rate-limit-judge).
   * Disabled when threshold <= 0.
   */
  export interface CodexRotationConfig {
    lowQuotaThresholdPercent: number
  }

  /**
   * Streaming part persistence guards. Added 2026-04-23 after codex
   * reasoning-loop wrote ~50 GB of cumulative stringify+disk on a single
   * part (3.7 MB × 13,600 deltas, each delta overwrote the whole file).
   *
   * - debounceMs: during streaming (delta updates), coalesce disk writes
   *   into one flush every N ms. Non-delta updates (text-end, completion)
   *   flush immediately. Crash window = debounceMs worth of streaming
   *   content; acceptable because the TUI already has the live stream.
   * - maxPartBytes: soft cap per part text/reasoning body. When exceeded
   *   we truncate with a marker and drop subsequent deltas for that part,
   *   but the session keeps running (user decides whether to intervene).
   *   Default sized for ~500 pages of plain text — any legitimate single
   *   part is well below this; hitting it is almost always a model loop.
   * - cancelOnCapTrip: if true, also cancel the session's current prompt
   *   with reason="runaway-guard" when the cap is hit. Defaults off so
   *   legitimate long outputs aren't guillotined on an edge case; flip on
   *   for unattended / batch workloads where runaway cost matters more
   *   than losing the turn.
   */
  export interface PartPersistenceConfig {
    debounceMs: number
    maxPartBytes: number
    cancelOnCapTrip: boolean
  }

  /**
   * responsive-orchestrator R3 / R6 — bounded escalation wait and
   * proactive quota-low red line for subagent runloop self-protection.
   * - escalationWaitMs: how long subagent waits for parent's
   *   ModelUpdateSignal after a 429 escalation before giving up and
   *   writing a rate_limited terminal finish.
   * - quotaLowRedLinePercent: post-turn quota threshold; when remaining
   *   ≤ this percent, subagent triggers proactive wrap-up
   *   (one summary turn then quota_low terminal finish). Set to 0 to
   *   disable the proactive path entirely.
   */
  export interface SubagentConfig {
    escalationWaitMs: number
    quotaLowRedLinePercent: number
  }

  export interface Effective {
    sessionCache: SessionCacheConfig
    rateLimit: RateLimitConfig
    frontendLazyload: FrontendLazyloadConfig
    sessionUiFreshness: SessionUiFreshnessConfig
    codexRotation: CodexRotationConfig
    partPersistence: PartPersistenceConfig
    subagent: SubagentConfig
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

  const FRONTEND_LAZYLOAD_DEFAULTS: FrontendLazyloadConfig = {
    flag: 0,
    partInlineCapKb: 64,
    tailWindowKb: 64,
    foldPreviewLines: 20,
    initialPageSizeSmall: "all",
    initialPageSizeMedium: 100,
    initialPageSizeLarge: 50,
    sessionSizeThresholdKb: 512,
    sessionSizeThresholdParts: 80,
    sessionMessagesDefaultTail: 30,
    sessionTailMobile: 20,
    sessionTailDesktop: 100,
    sessionStoreCapMobile: 100,
    sessionStoreCapDesktop: 200,
    sessionPartCapBytes: 512_000,
  }

  const SESSION_UI_FRESHNESS_DEFAULTS: SessionUiFreshnessConfig = {
    flag: 0,
    softThresholdSec: 15,
    hardTimeoutSec: 60,
  }

  const CODEX_ROTATION_DEFAULTS: CodexRotationConfig = {
    lowQuotaThresholdPercent: 10,
  }

  const SUBAGENT_DEFAULTS: SubagentConfig = {
    escalationWaitMs: 30_000,
    quotaLowRedLinePercent: 5,
  }

  const PART_PERSISTENCE_DEFAULTS: PartPersistenceConfig = {
    debounceMs: 500,
    // 8 MB ≈ 500 pages of plain text. Normal answers are tens of KB;
    // even extremely long legitimate dumps (full-file outputs, big
    // markdown reports) rarely exceed 1 MB. 8 MB is a "no human writes
    // that much in one part" ceiling — tripping it means the model is
    // looping, not that the user is working hard.
    maxPartBytes: 8 * 1024 * 1024,
    cancelOnCapTrip: false,
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
    "frontend_session_lazyload",
    "part_inline_cap_kb",
    "tail_window_kb",
    "fold_preview_lines",
    "initial_page_size_small",
    "initial_page_size_medium",
    "initial_page_size_large",
    "session_size_threshold_kb",
    "session_size_threshold_parts",
    "ui_session_freshness_enabled",
    "ui_freshness_threshold_sec",
    "ui_freshness_hard_timeout_sec",
    "codex_rotation_low_quota_percent",
    "session_messages_default_tail",
    "session_tail_mobile",
    "session_tail_desktop",
    "session_store_cap_mobile",
    "session_store_cap_desktop",
    "session_part_cap_bytes",
    "part_persist_debounce_ms",
    "part_max_bytes",
    "part_cancel_on_cap_trip",
    "subagent_escalation_wait_ms",
    "subagent_quota_low_red_line_percent",
  ])

  function parseFlag01(raw: string, key: string): 0 | 1 | undefined {
    const normalized = raw.trim().toLowerCase()
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return 1
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return 0
    log.warn("tweaks.cfg invalid flag for " + key + " (expected 0/1)", { raw })
    return undefined
  }

  function parseIntRange(raw: string, key: string, min: number, max: number): number | undefined {
    const value = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      log.warn("tweaks.cfg invalid integer for " + key, { raw })
      return undefined
    }
    if (value < min || value > max) {
      log.warn("tweaks.cfg value out of range for " + key, { raw, value, min, max })
      return undefined
    }
    return value
  }

  function parseInitialPageSizeSmall(raw: string): "all" | number | undefined {
    const normalized = raw.trim().toLowerCase()
    if (normalized === "all") return "all"
    const value = parseIntRange(raw, "initial_page_size_small", 10, 1000)
    return value
  }

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
        defaults: {
          sessionCache: SESSION_CACHE_DEFAULTS,
          rateLimit: RATE_LIMIT_DEFAULTS,
          frontendLazyload: FRONTEND_LAZYLOAD_DEFAULTS,
          sessionUiFreshness: SESSION_UI_FRESHNESS_DEFAULTS,
          codexRotation: CODEX_ROTATION_DEFAULTS,
          partPersistence: PART_PERSISTENCE_DEFAULTS,
          subagent: SUBAGENT_DEFAULTS,
        },
      })
      return {
        sessionCache: { ...SESSION_CACHE_DEFAULTS },
        rateLimit: { ...RATE_LIMIT_DEFAULTS },
        frontendLazyload: { ...FRONTEND_LAZYLOAD_DEFAULTS },
        sessionUiFreshness: { ...SESSION_UI_FRESHNESS_DEFAULTS },
        codexRotation: { ...CODEX_ROTATION_DEFAULTS },
        partPersistence: { ...PART_PERSISTENCE_DEFAULTS },
        subagent: { ...SUBAGENT_DEFAULTS },
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

    const frontendLazyload: FrontendLazyloadConfig = { ...FRONTEND_LAZYLOAD_DEFAULTS }

    const flagRaw = parsed.get("frontend_session_lazyload")
    if (flagRaw !== undefined) {
      const v = parseFlag01(flagRaw, "frontend_session_lazyload")
      if (v !== undefined) frontendLazyload.flag = v
    }
    const capRaw = parsed.get("part_inline_cap_kb")
    if (capRaw !== undefined) {
      const v = parseIntRange(capRaw, "part_inline_cap_kb", 4, 4096)
      if (v !== undefined) frontendLazyload.partInlineCapKb = v
    }
    const tailRaw = parsed.get("tail_window_kb")
    if (tailRaw !== undefined) {
      const v = parseIntRange(tailRaw, "tail_window_kb", 4, 4096)
      if (v !== undefined) frontendLazyload.tailWindowKb = v
    }
    const foldRaw = parsed.get("fold_preview_lines")
    if (foldRaw !== undefined) {
      const v = parseIntRange(foldRaw, "fold_preview_lines", 1, 200)
      if (v !== undefined) frontendLazyload.foldPreviewLines = v
    }
    const pageSmallRaw = parsed.get("initial_page_size_small")
    if (pageSmallRaw !== undefined) {
      const v = parseInitialPageSizeSmall(pageSmallRaw)
      if (v !== undefined) frontendLazyload.initialPageSizeSmall = v
    }
    const pageMediumRaw = parsed.get("initial_page_size_medium")
    if (pageMediumRaw !== undefined) {
      const v = parseIntRange(pageMediumRaw, "initial_page_size_medium", 10, 1000)
      if (v !== undefined) frontendLazyload.initialPageSizeMedium = v
    }
    const pageLargeRaw = parsed.get("initial_page_size_large")
    if (pageLargeRaw !== undefined) {
      const v = parseIntRange(pageLargeRaw, "initial_page_size_large", 10, 1000)
      if (v !== undefined) frontendLazyload.initialPageSizeLarge = v
    }
    const thresholdKbRaw = parsed.get("session_size_threshold_kb")
    if (thresholdKbRaw !== undefined) {
      const v = parseIntRange(thresholdKbRaw, "session_size_threshold_kb", 64, 1048576)
      if (v !== undefined) frontendLazyload.sessionSizeThresholdKb = v
    }
    const thresholdPartsRaw = parsed.get("session_size_threshold_parts")
    if (thresholdPartsRaw !== undefined) {
      const v = parseIntRange(thresholdPartsRaw, "session_size_threshold_parts", 10, 100000)
      if (v !== undefined) frontendLazyload.sessionSizeThresholdParts = v
    }
    const defaultTailRaw = parsed.get("session_messages_default_tail")
    if (defaultTailRaw !== undefined) {
      const v = parseIntRange(defaultTailRaw, "session_messages_default_tail", 5, 200)
      if (v !== undefined) frontendLazyload.sessionMessagesDefaultTail = v
    }
    const tailMobileRaw = parsed.get("session_tail_mobile")
    if (tailMobileRaw !== undefined) {
      const v = parseIntRange(tailMobileRaw, "session_tail_mobile", 5, 500)
      if (v !== undefined) frontendLazyload.sessionTailMobile = v
    }
    const tailDesktopRaw = parsed.get("session_tail_desktop")
    if (tailDesktopRaw !== undefined) {
      const v = parseIntRange(tailDesktopRaw, "session_tail_desktop", 5, 2000)
      if (v !== undefined) frontendLazyload.sessionTailDesktop = v
    }
    const capMobileRaw = parsed.get("session_store_cap_mobile")
    if (capMobileRaw !== undefined) {
      const v = parseIntRange(capMobileRaw, "session_store_cap_mobile", 30, 2000)
      if (v !== undefined) frontendLazyload.sessionStoreCapMobile = v
    }
    const capDesktopRaw = parsed.get("session_store_cap_desktop")
    if (capDesktopRaw !== undefined) {
      const v = parseIntRange(capDesktopRaw, "session_store_cap_desktop", 50, 5000)
      if (v !== undefined) frontendLazyload.sessionStoreCapDesktop = v
    }
    const partCapRaw = parsed.get("session_part_cap_bytes")
    if (partCapRaw !== undefined) {
      const v = parseIntRange(partCapRaw, "session_part_cap_bytes", 16_000, 16_000_000)
      if (v !== undefined) frontendLazyload.sessionPartCapBytes = v
    }
    // mobile-tail-first-simplification invariant: tail <= cap for each platform.
    if (frontendLazyload.sessionTailMobile > frontendLazyload.sessionStoreCapMobile) {
      log.warn("session_tail_mobile exceeds session_store_cap_mobile, clamping tail to cap", {
        tail: frontendLazyload.sessionTailMobile,
        cap: frontendLazyload.sessionStoreCapMobile,
      })
      frontendLazyload.sessionTailMobile = frontendLazyload.sessionStoreCapMobile
    }
    if (frontendLazyload.sessionTailDesktop > frontendLazyload.sessionStoreCapDesktop) {
      log.warn("session_tail_desktop exceeds session_store_cap_desktop, clamping tail to cap", {
        tail: frontendLazyload.sessionTailDesktop,
        cap: frontendLazyload.sessionStoreCapDesktop,
      })
      frontendLazyload.sessionTailDesktop = frontendLazyload.sessionStoreCapDesktop
    }

    // INV-7: tail_window_kb MUST NOT exceed part_inline_cap_kb.
    if (frontendLazyload.tailWindowKb > frontendLazyload.partInlineCapKb) {
      log.warn("tweaks.cfg tail_window_kb exceeds part_inline_cap_kb, clamping to cap (INV-7)", {
        tailWindowKb: frontendLazyload.tailWindowKb,
        partInlineCapKb: frontendLazyload.partInlineCapKb,
      })
      frontendLazyload.tailWindowKb = frontendLazyload.partInlineCapKb
    }

    const sessionUiFreshness: SessionUiFreshnessConfig = { ...SESSION_UI_FRESHNESS_DEFAULTS }

    const uiFlagRaw = parsed.get("ui_session_freshness_enabled")
    if (uiFlagRaw !== undefined) {
      const v = parseFlag01(uiFlagRaw, "ui_session_freshness_enabled")
      if (v !== undefined) sessionUiFreshness.flag = v
    }
    const softRaw = parsed.get("ui_freshness_threshold_sec")
    if (softRaw !== undefined) {
      const v = parseIntRange(softRaw, "ui_freshness_threshold_sec", 1, 3600)
      if (v !== undefined) sessionUiFreshness.softThresholdSec = v
    }
    const hardRaw = parsed.get("ui_freshness_hard_timeout_sec")
    if (hardRaw !== undefined) {
      const v = parseIntRange(hardRaw, "ui_freshness_hard_timeout_sec", 1, 86400)
      if (v !== undefined) sessionUiFreshness.hardTimeoutSec = v
    }
    // soft must be strictly less than hard; otherwise clamp soft to hard-1.
    if (sessionUiFreshness.softThresholdSec >= sessionUiFreshness.hardTimeoutSec) {
      log.warn(
        "tweaks.cfg ui_freshness_threshold_sec must be < ui_freshness_hard_timeout_sec, clamping",
        {
          softThresholdSec: sessionUiFreshness.softThresholdSec,
          hardTimeoutSec: sessionUiFreshness.hardTimeoutSec,
        },
      )
      sessionUiFreshness.softThresholdSec = Math.max(1, sessionUiFreshness.hardTimeoutSec - 1)
    }

    const codexRotation: CodexRotationConfig = { ...CODEX_ROTATION_DEFAULTS }
    const codexLowRaw = parsed.get("codex_rotation_low_quota_percent")
    if (codexLowRaw !== undefined) {
      const v = parseIntRange(codexLowRaw, "codex_rotation_low_quota_percent", 0, 100)
      if (v !== undefined) codexRotation.lowQuotaThresholdPercent = v
    }

    const partPersistence: PartPersistenceConfig = { ...PART_PERSISTENCE_DEFAULTS }
    const debounceRaw = parsed.get("part_persist_debounce_ms")
    if (debounceRaw !== undefined) {
      const v = parseIntRange(debounceRaw, "part_persist_debounce_ms", 0, 10_000)
      if (v !== undefined) partPersistence.debounceMs = v
    }
    const maxBytesRaw = parsed.get("part_max_bytes")
    if (maxBytesRaw !== undefined) {
      const v = parseIntRange(maxBytesRaw, "part_max_bytes", 64 * 1024, 64 * 1024 * 1024)
      if (v !== undefined) partPersistence.maxPartBytes = v
    }
    const cancelOnTripRaw = parsed.get("part_cancel_on_cap_trip")
    if (cancelOnTripRaw !== undefined) {
      const v = parseBool(cancelOnTripRaw, "part_cancel_on_cap_trip")
      if (v !== undefined) partPersistence.cancelOnCapTrip = v
    }

    const subagent: SubagentConfig = { ...SUBAGENT_DEFAULTS }
    const escalationWaitRaw = parsed.get("subagent_escalation_wait_ms")
    if (escalationWaitRaw !== undefined) {
      const v = parseIntRange(escalationWaitRaw, "subagent_escalation_wait_ms", 5_000, 300_000)
      if (v !== undefined) subagent.escalationWaitMs = v
    }
    const quotaRedLineRaw = parsed.get("subagent_quota_low_red_line_percent")
    if (quotaRedLineRaw !== undefined) {
      const v = parseIntRange(quotaRedLineRaw, "subagent_quota_low_red_line_percent", 0, 50)
      if (v !== undefined) subagent.quotaLowRedLinePercent = v
    }

    log.info("tweaks.cfg loaded", {
      path: cfgPath,
      effective: { sessionCache, rateLimit, frontendLazyload, sessionUiFreshness, codexRotation, partPersistence, subagent },
    })
    return {
      sessionCache,
      rateLimit,
      frontendLazyload,
      sessionUiFreshness,
      codexRotation,
      partPersistence,
      subagent,
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

  export async function frontendLazyload(): Promise<FrontendLazyloadConfig> {
    return (await effective()).frontendLazyload
  }

  export async function sessionUiFreshness(): Promise<SessionUiFreshnessConfig> {
    return (await effective()).sessionUiFreshness
  }

  export async function codexRotation(): Promise<CodexRotationConfig> {
    return (await effective()).codexRotation
  }

  export async function partPersistence(): Promise<PartPersistenceConfig> {
    return (await effective()).partPersistence
  }

  export async function subagent(): Promise<SubagentConfig> {
    return (await effective()).subagent
  }

  /**
   * Synchronous accessor for hot paths (e.g. updatePart). Returns defaults
   * until loadEffective() completes; after that returns the loaded values.
   * Reading from an async source on every delta would defeat the whole
   * point of debouncing.
   */
  export function partPersistenceSync(): PartPersistenceConfig {
    return _effective?.partPersistence ?? PART_PERSISTENCE_DEFAULTS
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
