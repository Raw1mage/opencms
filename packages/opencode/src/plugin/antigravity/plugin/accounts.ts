import { formatRefreshParts, parseRefreshParts } from "./auth"
import type { RateLimitStateV3, ModelFamily, HeaderStyle, CooldownReason, AccountMetadataV3 } from "./storage"
import type { OAuthAuthDetails, RefreshParts } from "./types"
import type { AccountSelectionStrategy } from "./config/schema"
import { getHealthTracker, getTokenTracker, selectHybridAccount, type AccountWithMetrics } from "./rotation"
import { generateFingerprint, type Fingerprint, type FingerprintVersion, MAX_FINGERPRINT_HISTORY } from "./fingerprint"
import { Account } from "../../../account"

export type { ModelFamily, HeaderStyle, CooldownReason } from "./storage"
export type { AccountSelectionStrategy } from "./config/schema"

export type RateLimitReason =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMIT_EXCEEDED"
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "UNKNOWN"

export interface RateLimitBackoffResult {
  backoffMs: number
  reason: RateLimitReason
}

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000] as const
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000
// Increased from 15s to 45s base + jitter to reduce retry pressure on capacity errors
const MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF = 45_000
const MODEL_CAPACITY_EXHAUSTED_JITTER_MAX = 30_000 // ±15s jitter range
const SERVER_ERROR_BACKOFF = 20_000
const UNKNOWN_BACKOFF = 60_000
const MIN_BACKOFF_MS = 2_000

/**
 * Generate a random jitter value for backoff timing.
 * Helps prevent thundering herd problem when multiple clients retry simultaneously.
 */
function generateJitter(maxJitterMs: number): number {
  return Math.random() * maxJitterMs - maxJitterMs / 2
}

export function parseRateLimitReason(
  reason: string | undefined,
  message: string | undefined,
  status?: number,
): RateLimitReason {
  // 1. Status Code Checks (Rust parity)
  // 529 = Site Overloaded, 503 = Service Unavailable -> Capacity issues
  if (status === 529 || status === 503) return "MODEL_CAPACITY_EXHAUSTED"
  // 500 = Internal Server Error -> Treat as Server Error (soft wait)
  if (status === 500) return "SERVER_ERROR"

  // 2. Explicit Reason String
  if (reason) {
    switch (reason.toUpperCase()) {
      case "QUOTA_EXHAUSTED":
        return "QUOTA_EXHAUSTED"
      case "RATE_LIMIT_EXCEEDED":
        return "RATE_LIMIT_EXCEEDED"
      case "MODEL_CAPACITY_EXHAUSTED":
        return "MODEL_CAPACITY_EXHAUSTED"
    }
  }

  // 3. Message Text Scanning (Rust Regex parity)
  if (message) {
    const lower = message.toLowerCase()

    // Capacity / Overloaded (Transient) - Check FIRST before "exhausted"
    if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("resource exhausted")) {
      return "MODEL_CAPACITY_EXHAUSTED"
    }

    // RPM / TPM (Short Wait)
    // "per minute", "rate limit", "too many requests"
    // "presque" (French: almost) - retained for i18n parity with Rust reference
    if (
      lower.includes("per minute") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests") ||
      lower.includes("presque")
    ) {
      return "RATE_LIMIT_EXCEEDED"
    }

    // Quota (Long Wait)
    if (lower.includes("exhausted") || lower.includes("quota")) {
      return "QUOTA_EXHAUSTED"
    }
  }

  // Default fallback for 429 without clearer info
  if (status === 429) {
    return "UNKNOWN"
  }

  return "UNKNOWN"
}

export function calculateBackoffMs(
  reason: RateLimitReason,
  consecutiveFailures: number,
  retryAfterMs?: number | null,
): number {
  // Respect explicit Retry-After header if reasonable
  if (retryAfterMs && retryAfterMs > 0) {
    // Rust uses 2s min buffer, we keep 2s
    return Math.max(retryAfterMs, MIN_BACKOFF_MS)
  }

  switch (reason) {
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1)
      return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF
    }
    case "RATE_LIMIT_EXCEEDED":
      return RATE_LIMIT_EXCEEDED_BACKOFF // 30s
    case "MODEL_CAPACITY_EXHAUSTED":
      // Apply jitter to prevent thundering herd on capacity errors
      return MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF + generateJitter(MODEL_CAPACITY_EXHAUSTED_JITTER_MAX)
    case "SERVER_ERROR":
      return SERVER_ERROR_BACKOFF // 20s
    case "UNKNOWN":
    default:
      return UNKNOWN_BACKOFF // 60s
  }
}

export type BaseQuotaKey = "claude" | "gemini-antigravity" | "gemini-cli"
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`

export interface ManagedAccount {
  index: number
  email?: string
  addedAt: number
  lastUsed: number
  parts: RefreshParts
  access?: string
  expires?: number
  enabled: boolean
  rateLimitResetTimes: RateLimitStateV3
  lastSwitchReason?: CooldownReason
  coolingDownUntil?: number
  cooldownReason?: CooldownReason
  touchedForQuota: Record<string, number>
  consecutiveFailures?: number
  /** Timestamp of last failure for TTL-based reset of consecutiveFailures */
  lastFailureTime?: number
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: import("./fingerprint").Fingerprint
  /** History of previous fingerprints for this account */
  fingerprintHistory?: FingerprintVersion[]
  /** Core Account module ID for syncing back to accounts.json */
  _coreAccountId?: string
}

/** Internal storage format for constructor compatibility */
interface AccountStorageInternal {
  version: 3
  accounts: Array<{
    refreshToken: string
    email?: string
    projectId?: string
    managedProjectId?: string
    accessToken?: string
    expiresAt?: number
    addedAt: number
    lastUsed: number
    enabled?: boolean
    rateLimitResetTimes?: RateLimitStateV3
    lastSwitchReason?: CooldownReason
    coolingDownUntil?: number
    cooldownReason?: CooldownReason
    fingerprint?: Record<string, unknown>
    fingerprintHistory?: Array<{ version: number; fingerprint: Record<string, unknown>; timestamp: number }>
    _coreAccountId?: string
  }>
  activeIndex: number
  activeIndexByFamily?: {
    claude: number
    gemini: number
  }
}

function nowMs(): number {
  return Date.now()
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }
  return value < 0 ? 0 : Math.floor(value)
}

function getQuotaKey(family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): QuotaKey {
  if (family === "claude") {
    return "claude"
  }
  const base = headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity"
  if (model) {
    return `${base}:${model}`
  }
  return base
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
  const resetTime = account.rateLimitResetTimes[key]
  return resetTime !== undefined && nowMs() < resetTime
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily, model?: string | null): boolean {
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude")
  }

  const antigravityIsLimited = isRateLimitedForHeaderStyle(account, family, "antigravity", model)
  const cliIsLimited = isRateLimitedForHeaderStyle(account, family, "gemini-cli", model)

  return antigravityIsLimited && cliIsLimited
}

function isRateLimitedForHeaderStyle(
  account: ManagedAccount,
  family: ModelFamily,
  headerStyle: HeaderStyle,
  model?: string | null,
): boolean {
  clearExpiredRateLimits(account)

  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude")
  }

  // Check model-specific quota first if provided
  if (model) {
    const modelKey = getQuotaKey(family, headerStyle, model)
    if (isRateLimitedForQuotaKey(account, modelKey)) {
      return true
    }
  }

  // Then check base family quota
  const baseKey = getQuotaKey(family, headerStyle)
  return isRateLimitedForQuotaKey(account, baseKey)
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs()
  const keys = Object.keys(account.rateLimitResetTimes) as QuotaKey[]
  for (const key of keys) {
    const resetTime = account.rateLimitResetTimes[key]
    if (resetTime !== undefined && now >= resetTime) {
      delete account.rateLimitResetTimes[key]
    }
  }
}

/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = []
  private cursor = 0
  private currentAccountIndexByFamily: Record<ModelFamily, number> = {
    claude: -1,
    gemini: -1,
  }
  private sessionOffsetApplied: Record<ModelFamily, boolean> = {
    claude: false,
    gemini: false,
  }
  private lastToastAccountIndex = -1
  private lastToastTime = 0

  private savePending = false
  private saveTimeout: ReturnType<typeof setTimeout> | null = null
  private savePromiseResolvers: Array<() => void> = []

  /**
   * Load accounts from the unified Account module (accounts.json).
   * This is the single source of truth for all account data.
   */
  static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
    const accounts = await Account.list("antigravity")
    const activeAccountId = await Account.getActive("antigravity")

    // Convert Account module format to internal ManagedAccount format
    const managedAccounts: ManagedAccount[] = []
    const entries = Object.entries(accounts)
    let activeIndex = 0

    for (let i = 0; i < entries.length; i++) {
      const [id, info] = entries[i]
      if (info.type !== "subscription") continue

      const parts: RefreshParts = {
        refreshToken: info.refreshToken,
        projectId: info.projectId,
        managedProjectId: info.managedProjectId,
      }

      managedAccounts.push({
        index: managedAccounts.length,
        email: info.email,
        addedAt: info.addedAt || Date.now(),
        lastUsed: 0,
        parts,
        access: info.accessToken,
        expires: info.expiresAt,
        enabled: true,
        rateLimitResetTimes: (info.rateLimitResetTimes || {}) as RateLimitStateV3,
        coolingDownUntil: info.coolingDownUntil,
        cooldownReason: info.cooldownReason as CooldownReason | undefined,
        touchedForQuota: {},
        fingerprint: info.fingerprint as Fingerprint | undefined,
        _coreAccountId: id, // Store the core account ID for syncing back
      })

      // Match active account
      if (id === activeAccountId) {
        activeIndex = managedAccounts.length - 1
      }
    }

    // Build the storage-like structure for backward compatibility with constructor
    const stored = {
      version: 3 as const,
      accounts: managedAccounts.map((a) => ({
        refreshToken: a.parts.refreshToken,
        email: a.email,
        projectId: a.parts.projectId,
        managedProjectId: a.parts.managedProjectId,
        accessToken: a.access,
        expiresAt: a.expires,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        enabled: a.enabled,
        rateLimitResetTimes: a.rateLimitResetTimes,
        coolingDownUntil: a.coolingDownUntil,
        cooldownReason: a.cooldownReason,
        fingerprint: a.fingerprint as Record<string, unknown> | undefined,
        _coreAccountId: (a as any)._coreAccountId,
      })),
      activeIndex,
      activeIndexByFamily: {
        claude: activeIndex,
        gemini: activeIndex,
      },
    }

    const manager = new AccountManager(authFallback, stored)
    // Attach core account IDs to managed accounts
    for (let i = 0; i < manager.accounts.length && i < entries.length; i++) {
      ;(manager.accounts[i] as any)._coreAccountId = entries[i][0]
    }
    return manager
  }

  replaceFrom(other: AccountManager): void {
    this.accounts = other.accounts.map((acc) => ({
      ...acc,
      parts: { ...acc.parts },
      rateLimitResetTimes: { ...acc.rateLimitResetTimes },
      touchedForQuota: { ...acc.touchedForQuota },
      fingerprint: acc.fingerprint,
      fingerprintHistory: acc.fingerprintHistory,
    }))
    this.cursor = other.cursor
    this.currentAccountIndexByFamily = { ...other.currentAccountIndexByFamily }
    this.sessionOffsetApplied = { ...other.sessionOffsetApplied }
    this.lastToastAccountIndex = other.lastToastAccountIndex
    this.lastToastTime = other.lastToastTime
  }

  /**
   * Reload accounts from the Account module.
   * Use this after external changes (e.g., from /admin).
   */
  async reloadFromAccountModule(): Promise<void> {
    await Account.refresh()
    const fresh = await AccountManager.loadFromDisk()
    this.replaceFrom(fresh)
  }

  constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageInternal | null) {
    const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null

    if (stored && stored.accounts.length === 0) {
      this.accounts = []
      this.cursor = 0
      return
    }

    if (stored && stored.accounts.length > 0) {
      const baseNow = nowMs()
      this.accounts = stored.accounts
        .map((acc, index): ManagedAccount | null => {
          if (!acc.refreshToken || typeof acc.refreshToken !== "string") {
            return null
          }
          const matchesFallback = !!(
            authFallback &&
            authParts &&
            authParts.refreshToken &&
            acc.refreshToken === authParts.refreshToken
          )

          return {
            index,
            email: acc.email,
            addedAt: clampNonNegativeInt(acc.addedAt, baseNow),
            lastUsed: clampNonNegativeInt(acc.lastUsed, 0),
            parts: {
              refreshToken: acc.refreshToken,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
            },
            access: matchesFallback ? authFallback?.access : acc.accessToken,
            expires: matchesFallback ? authFallback?.expires : acc.expiresAt,
            enabled: acc.enabled !== false,
            rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
            lastSwitchReason: acc.lastSwitchReason,
            coolingDownUntil: acc.coolingDownUntil,
            cooldownReason: acc.cooldownReason,
            touchedForQuota: {},
            // Use stored fingerprint or generate new one for rate limit mitigation
            fingerprint: (acc.fingerprint as Fingerprint | undefined) ?? generateFingerprint(),
            // Preserve core account ID for syncing back to Account module
            _coreAccountId: acc._coreAccountId,
          }
        })
        .filter((a): a is ManagedAccount => a !== null)

      this.cursor = clampNonNegativeInt(stored.activeIndex, 0)
      if (this.accounts.length > 0) {
        this.cursor = this.cursor % this.accounts.length
        const defaultIndex = this.cursor
        this.currentAccountIndexByFamily.claude =
          clampNonNegativeInt(stored.activeIndexByFamily?.claude, defaultIndex) % this.accounts.length
        this.currentAccountIndexByFamily.gemini =
          clampNonNegativeInt(stored.activeIndexByFamily?.gemini, defaultIndex) % this.accounts.length
      }

      return
    }

    // If we have stored accounts, check if we need to add the current auth
    if (authFallback && this.accounts.length > 0) {
      const authParts = parseRefreshParts(authFallback.refresh)
      const hasMatching = this.accounts.some((acc) => acc.parts.refreshToken === authParts.refreshToken)
      if (!hasMatching && authParts.refreshToken) {
        const now = nowMs()
        const newAccount: ManagedAccount = {
          index: this.accounts.length,
          email: undefined,
          addedAt: now,
          lastUsed: 0,
          parts: authParts,
          access: authFallback.access,
          expires: authFallback.expires,
          enabled: true,
          rateLimitResetTimes: {},
          touchedForQuota: {},
        }
        this.accounts.push(newAccount)
        // Update indices to include the new account
        this.currentAccountIndexByFamily.claude = Math.min(
          this.currentAccountIndexByFamily.claude,
          this.accounts.length - 1,
        )
        this.currentAccountIndexByFamily.gemini = Math.min(
          this.currentAccountIndexByFamily.gemini,
          this.accounts.length - 1,
        )
      }
    }

    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh)
      if (parts.refreshToken) {
        const now = nowMs()
        this.accounts = [
          {
            index: 0,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts,
            access: authFallback.access,
            expires: authFallback.expires,
            enabled: true,
            rateLimitResetTimes: {},
            touchedForQuota: {},
          },
        ]
        this.cursor = 0
        this.currentAccountIndexByFamily.claude = 0
        this.currentAccountIndexByFamily.gemini = 0
      }
    }
  }

  getAccountCount(): number {
    return this.getEnabledAccounts().length
  }

  getTotalAccountCount(): number {
    return this.accounts.length
  }

  getEnabledAccounts(): ManagedAccount[] {
    return this.accounts.filter((account) => account.enabled !== false)
  }

  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({
      ...a,
      parts: { ...a.parts },
      rateLimitResetTimes: { ...a.rateLimitResetTimes },
    }))
  }

  getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
    const currentIndex = this.currentAccountIndexByFamily[family]
    if (currentIndex >= 0 && currentIndex < this.accounts.length) {
      return this.accounts[currentIndex] ?? null
    }
    return null
  }

  /**
   * Synchronize internal family indexes with the Account module's active account.
   * This ensures changes made via /admin are respected.
   */
  async syncActiveFromAccountModule(): Promise<void> {
    const activeAccountId = await Account.getActive("antigravity")
    if (!activeAccountId) return

    // Find the account with matching core ID
    const matchingAccount = this.accounts.find((acc) => (acc as any)._coreAccountId === activeAccountId)

    if (matchingAccount) {
      // Update both family indexes to match
      this.currentAccountIndexByFamily.claude = matchingAccount.index
      this.currentAccountIndexByFamily.gemini = matchingAccount.index
      this.cursor = matchingAccount.index
    }
  }

  getPinnedForFamily(family: ModelFamily): ManagedAccount | null {
    const current = this.getCurrentAccountForFamily(family)
    if (current && current.enabled !== false) {
      return current
    }
    const enabled = this.getEnabledAccounts()
    if (enabled.length === 0) {
      return null
    }
    const fallback = enabled[0] ?? null
    if (!fallback) return null
    this.currentAccountIndexByFamily[family] = fallback.index
    return fallback
  }

  async markSwitched(
    account: ManagedAccount,
    reason: "rate-limit" | "initial" | "rotation",
    family: ModelFamily,
  ): Promise<void> {
    account.lastSwitchReason = reason
    this.currentAccountIndexByFamily[family] = account.index

    try {
      // Notify UI of the switch
      const { Bus } = await import("../../../bus")
      const { BusEvent } = await import("../../../bus/bus-event")
      const { z } = await import("zod")

      const AntigravityAccountSwitched = BusEvent.define(
        "antigravity.account.switched",
        z.object({
          family: z.string(),
          index: z.number(),
          oldIndex: z.number().optional(),
          reason: z.string(),
          email: z.string().optional(),
        }),
      )

      await Bus.publish(AntigravityAccountSwitched, {
        family,
        index: account.index,
        reason,
        email: account.email,
      })
    } catch (error) {
      // Ignore bus errors if running in isolated context
      console.error("Failed to publish switch event", error)
    }
  }

  /**
   * Check if we should show an account switch toast.
   * Debounces repeated toasts for the same account.
   */
  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = nowMs()
    if (accountIndex !== this.lastToastAccountIndex) {
      return true
    }
    return now - this.lastToastTime >= debounceMs
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex
    this.lastToastTime = nowMs()
  }

  getCurrentOrNextForFamily(
    family: ModelFamily,
    model?: string | null,
    strategy: AccountSelectionStrategy = "sticky",
    headerStyle: HeaderStyle = "antigravity",
    pidOffsetEnabled: boolean = false,
  ): ManagedAccount | null {
    const quotaKey = getQuotaKey(family, headerStyle, model)

    if (strategy === "round-robin") {
      const next = this.getNextForFamily(family, model, headerStyle)
      if (next) {
        this.markTouchedForQuota(next, quotaKey)
        this.currentAccountIndexByFamily[family] = next.index
      }
      return next
    }

    if (strategy === "hybrid") {
      const healthTracker = getHealthTracker()
      const tokenTracker = getTokenTracker()

      const accountsWithMetrics: AccountWithMetrics[] = this.accounts
        .filter((acc) => acc.enabled !== false)
        .map((acc) => {
          clearExpiredRateLimits(acc)
          return {
            index: acc.index,
            lastUsed: acc.lastUsed,
            healthScore: healthTracker.getScore(acc.index),
            isRateLimited: isRateLimitedForFamily(acc, family, model),
            isCoolingDown: this.isAccountCoolingDown(acc),
          }
        })

      // Get current account index for stickiness
      const currentIndex = this.currentAccountIndexByFamily[family] ?? null

      const selectedIndex = selectHybridAccount(accountsWithMetrics, tokenTracker, currentIndex)
      if (selectedIndex !== null) {
        const selected = this.accounts[selectedIndex]
        if (selected) {
          selected.lastUsed = nowMs()
          this.markTouchedForQuota(selected, quotaKey)
          this.currentAccountIndexByFamily[family] = selected.index
          return selected
        }
      }
    }

    // Fallback: sticky selection (used when hybrid finds no candidates)
    // PID-based offset for multi-session distribution (opt-in)
    // Different sessions (PIDs) will prefer different starting accounts
    if (pidOffsetEnabled && !this.sessionOffsetApplied[family] && this.accounts.length > 1) {
      const pidOffset = process.pid % this.accounts.length
      const baseIndex = this.currentAccountIndexByFamily[family] ?? 0
      this.currentAccountIndexByFamily[family] = (baseIndex + pidOffset) % this.accounts.length
      this.sessionOffsetApplied[family] = true
    }

    const current = this.getCurrentAccountForFamily(family)
    if (current) {
      clearExpiredRateLimits(current)
      const isLimitedForRequestedStyle = isRateLimitedForHeaderStyle(current, family, headerStyle, model)
      if (!isLimitedForRequestedStyle && !this.isAccountCoolingDown(current)) {
        this.markTouchedForQuota(current, quotaKey)
        return current
      }
    }

    const next = this.getNextForFamily(family, model, headerStyle)
    if (next) {
      this.markTouchedForQuota(next, quotaKey)
      this.currentAccountIndexByFamily[family] = next.index
    }
    return next
  }

  getNextForFamily(
    family: ModelFamily,
    model?: string | null,
    headerStyle: HeaderStyle = "antigravity",
  ): ManagedAccount | null {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a)
      return (
        a.enabled !== false &&
        !isRateLimitedForHeaderStyle(a, family, headerStyle, model) &&
        !this.isAccountCoolingDown(a)
      )
    })

    if (available.length === 0) {
      return null
    }

    const account = available[this.cursor % available.length]
    if (!account) {
      return null
    }

    this.cursor++
    // Note: lastUsed is now updated after successful request via markAccountUsed()
    return account
  }

  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = "antigravity",
    model?: string | null,
  ): void {
    const key = getQuotaKey(family, headerStyle, model)
    account.rateLimitResetTimes[key] = nowMs() + retryAfterMs
  }

  /**
   * Mark an account as used after a successful API request.
   * This updates the lastUsed timestamp for freshness calculations.
   * Should be called AFTER request completion, not during account selection.
   */
  markAccountUsed(accountIndex: number): void {
    const account = this.accounts.find((a) => a.index === accountIndex)
    if (account) {
      account.lastUsed = nowMs()
    }
  }

  markRateLimitedWithReason(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model: string | null | undefined,
    reason: RateLimitReason,
    retryAfterMs?: number | null,
    failureTtlMs: number = 3600_000, // Default 1 hour TTL
  ): number {
    const now = nowMs()

    // TTL-based reset: if last failure was more than failureTtlMs ago, reset count
    if (account.lastFailureTime !== undefined && now - account.lastFailureTime > failureTtlMs) {
      account.consecutiveFailures = 0
    }

    const failures = (account.consecutiveFailures ?? 0) + 1
    account.consecutiveFailures = failures
    account.lastFailureTime = now

    const backoffMs = calculateBackoffMs(reason, failures - 1, retryAfterMs)
    const key = getQuotaKey(family, headerStyle, model)
    account.rateLimitResetTimes[key] = now + backoffMs

    return backoffMs
  }

  markRequestSuccess(account: ManagedAccount): void {
    if (account.consecutiveFailures) {
      account.consecutiveFailures = 0
    }
  }

  clearAllRateLimitsForFamily(family: ModelFamily, model?: string | null): void {
    for (const account of this.accounts) {
      if (family === "claude") {
        delete account.rateLimitResetTimes.claude
      } else {
        const antigravityKey = getQuotaKey(family, "antigravity", model)
        const cliKey = getQuotaKey(family, "gemini-cli", model)
        delete account.rateLimitResetTimes[antigravityKey]
        delete account.rateLimitResetTimes[cliKey]
      }
      account.consecutiveFailures = 0
    }
  }

  shouldTryOptimisticReset(family: ModelFamily, model?: string | null): boolean {
    const minWaitMs = this.getMinWaitTimeForFamily(family, model)
    return minWaitMs > 0 && minWaitMs <= 2_000
  }

  markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void {
    account.coolingDownUntil = nowMs() + cooldownMs
    account.cooldownReason = reason
  }

  isAccountCoolingDown(account: ManagedAccount): boolean {
    if (account.coolingDownUntil === undefined) {
      return false
    }
    if (nowMs() >= account.coolingDownUntil) {
      this.clearAccountCooldown(account)
      return false
    }
    return true
  }

  clearAccountCooldown(account: ManagedAccount): void {
    delete account.coolingDownUntil
    delete account.cooldownReason
  }

  getAccountCooldownReason(account: ManagedAccount): CooldownReason | undefined {
    return this.isAccountCoolingDown(account) ? account.cooldownReason : undefined
  }

  markTouchedForQuota(account: ManagedAccount, quotaKey: string): void {
    account.touchedForQuota[quotaKey] = nowMs()
  }

  isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean {
    const touchedAt = account.touchedForQuota[quotaKey]
    if (!touchedAt) return true

    const resetTime = account.rateLimitResetTimes[quotaKey as QuotaKey]
    if (resetTime && touchedAt < resetTime) return true

    return false
  }

  getFreshAccountsForQuota(quotaKey: string, family: ModelFamily, model?: string | null): ManagedAccount[] {
    return this.accounts.filter((acc) => {
      clearExpiredRateLimits(acc)
      return (
        acc.enabled !== false &&
        this.isFreshForQuota(acc, quotaKey) &&
        !isRateLimitedForFamily(acc, family, model) &&
        !this.isAccountCoolingDown(acc)
      )
    })
  }

  isRateLimitedForHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model?: string | null,
  ): boolean {
    return isRateLimitedForHeaderStyle(account, family, headerStyle, model)
  }

  getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily, model?: string | null): HeaderStyle | null {
    clearExpiredRateLimits(account)
    if (family === "claude") {
      return isRateLimitedForHeaderStyle(account, family, "antigravity") ? null : "antigravity"
    }
    if (!isRateLimitedForHeaderStyle(account, family, "antigravity", model)) {
      return "antigravity"
    }
    if (!isRateLimitedForHeaderStyle(account, family, "gemini-cli", model)) {
      return "gemini-cli"
    }
    return null
  }

  removeAccount(account: ManagedAccount): boolean {
    const idx = this.accounts.indexOf(account)
    if (idx < 0) {
      return false
    }

    this.accounts.splice(idx, 1)
    this.accounts.forEach((acc, index) => {
      acc.index = index
    })

    if (this.accounts.length === 0) {
      this.cursor = 0
      this.currentAccountIndexByFamily.claude = -1
      this.currentAccountIndexByFamily.gemini = -1
      return true
    }

    if (this.cursor > idx) {
      this.cursor -= 1
    }
    this.cursor = this.cursor % this.accounts.length

    for (const family of ["claude", "gemini"] as ModelFamily[]) {
      if (this.currentAccountIndexByFamily[family] > idx) {
        this.currentAccountIndexByFamily[family] -= 1
      }
      if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
        this.currentAccountIndexByFamily[family] = -1
      }
    }

    return true
  }

  removeAccountByIndex(index: number): boolean {
    const account = this.accounts.find((a) => a.index === index)
    if (!account) return false
    return this.removeAccount(account)
  }

  getActiveIndex(): number {
    return this.cursor
  }

  getActiveIndexByFamily(): Record<ModelFamily, number> {
    return { ...this.currentAccountIndexByFamily }
  }

  setActiveIndex(index: number): void {
    if (index >= 0 && index < this.accounts.length) {
      this.cursor = index
    }
  }

  getAccount(index: number): ManagedAccount | null {
    return this.accounts.find((a) => a.index === index) || null
  }

  updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
    const parts = parseRefreshParts(auth.refresh)
    // Preserve existing projectId/managedProjectId if not in the new parts
    account.parts = {
      ...parts,
      projectId: parts.projectId ?? account.parts.projectId,
      managedProjectId: parts.managedProjectId ?? account.parts.managedProjectId,
    }
    account.access = auth.access
    account.expires = auth.expires
  }

  toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    }
  }

  getMinWaitTimeForFamily(
    family: ModelFamily,
    model?: string | null,
    headerStyle?: HeaderStyle,
    strict?: boolean,
  ): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a)
      return (
        a.enabled !== false &&
        (strict && headerStyle
          ? !isRateLimitedForHeaderStyle(a, family, headerStyle, model)
          : !isRateLimitedForFamily(a, family, model))
      )
    })
    if (available.length > 0) {
      return 0
    }

    const waitTimes: number[] = []
    for (const a of this.accounts) {
      if (family === "claude") {
        const t = a.rateLimitResetTimes.claude
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()))
      } else if (strict && headerStyle) {
        const key = getQuotaKey(family, headerStyle, model)
        const t = a.rateLimitResetTimes[key]
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()))
      } else {
        // For Gemini, account becomes available when EITHER pool expires for this model/family
        const antigravityKey = getQuotaKey(family, "antigravity", model)
        const cliKey = getQuotaKey(family, "gemini-cli", model)

        const t1 = a.rateLimitResetTimes[antigravityKey]
        const t2 = a.rateLimitResetTimes[cliKey]

        const accountWait = Math.min(
          t1 !== undefined ? Math.max(0, t1 - nowMs()) : Infinity,
          t2 !== undefined ? Math.max(0, t2 - nowMs()) : Infinity,
        )
        if (accountWait !== Infinity) waitTimes.push(accountWait)
      }
    }

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts]
  }

  /**
   * Save account data back to the unified Account module (accounts.json).
   * Only saves rate limit and fingerprint data since those are managed by AccountManager.
   */
  async saveToDisk(): Promise<void> {
    for (const acc of this.accounts) {
      const coreId = acc._coreAccountId
      if (!coreId) continue

      try {
        // Update the account with runtime data that AccountManager tracks
        await Account.update("antigravity", coreId, {
          rateLimitResetTimes: Object.keys(acc.rateLimitResetTimes).length > 0 ? acc.rateLimitResetTimes : undefined,
          coolingDownUntil: acc.coolingDownUntil,
          cooldownReason: acc.cooldownReason,
          fingerprint: acc.fingerprint as Record<string, unknown> | undefined,
        })
      } catch (e) {
        // Account may have been deleted externally, skip
      }
    }

    // Update active account if changed
    const activeAcc = this.getCurrentAccountForFamily("claude")
    if (activeAcc?._coreAccountId) {
      const currentActive = await Account.getActive("antigravity")
      if (currentActive !== activeAcc._coreAccountId) {
        try {
          await Account.setActive("antigravity", activeAcc._coreAccountId)
        } catch (e) {
          // Ignore if account doesn't exist
        }
      }
    }
  }

  requestSaveToDisk(): void {
    if (this.savePending) {
      return
    }
    this.savePending = true
    this.saveTimeout = setTimeout(() => {
      void this.executeSave()
    }, 1000)
  }

  async flushSaveToDisk(): Promise<void> {
    if (!this.savePending) {
      return
    }
    return new Promise<void>((resolve) => {
      this.savePromiseResolvers.push(resolve)
    })
  }

  private async executeSave(): Promise<void> {
    this.savePending = false
    this.saveTimeout = null

    try {
      await this.saveToDisk()
    } catch {
      // best-effort persistence; avoid unhandled rejection from timer-driven saves
    } finally {
      const resolvers = this.savePromiseResolvers
      this.savePromiseResolvers = []
      for (const resolve of resolvers) {
        resolve()
      }
    }
  }

  // ========== Fingerprint Management ==========

  /**
   * Regenerate fingerprint for an account, saving the old one to history.
   * @param accountIndex - Index of the account to regenerate fingerprint for
   * @returns The new fingerprint, or null if account not found
   */
  regenerateAccountFingerprint(accountIndex: number): Fingerprint | null {
    const account = this.accounts[accountIndex]
    if (!account) return null

    // Save current fingerprint to history if it exists
    if (account.fingerprint) {
      const historyEntry: FingerprintVersion = {
        fingerprint: account.fingerprint,
        timestamp: nowMs(),
        reason: "regenerated",
      }

      if (!account.fingerprintHistory) {
        account.fingerprintHistory = []
      }

      // Add to beginning of history (most recent first)
      account.fingerprintHistory.unshift(historyEntry)

      // Trim to max history size
      if (account.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory.slice(0, MAX_FINGERPRINT_HISTORY)
      }
    }

    // Generate and assign new fingerprint
    account.fingerprint = generateFingerprint()
    this.requestSaveToDisk()

    return account.fingerprint
  }

  /**
   * Restore a fingerprint from history for an account.
   * @param accountIndex - Index of the account
   * @param historyIndex - Index in the fingerprint history to restore from (0 = most recent)
   * @returns The restored fingerprint, or null if account/history not found
   */
  restoreAccountFingerprint(accountIndex: number, historyIndex: number): Fingerprint | null {
    const account = this.accounts[accountIndex]
    if (!account) return null

    const history = account.fingerprintHistory
    if (!history || historyIndex < 0 || historyIndex >= history.length) {
      return null
    }

    // Capture the fingerprint to restore BEFORE modifying history
    const fingerprintToRestore = history[historyIndex]!.fingerprint

    // Save current fingerprint to history before restoring (if it exists)
    if (account.fingerprint) {
      const historyEntry: FingerprintVersion = {
        fingerprint: account.fingerprint,
        timestamp: nowMs(),
        reason: "restored",
      }

      account.fingerprintHistory!.unshift(historyEntry)

      // Trim to max history size
      if (account.fingerprintHistory!.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory!.slice(0, MAX_FINGERPRINT_HISTORY)
      }
    }

    // Restore the fingerprint
    account.fingerprint = { ...fingerprintToRestore, createdAt: nowMs() }

    this.requestSaveToDisk()

    return account.fingerprint
  }

  /**
   * Get fingerprint history for an account.
   * @param accountIndex - Index of the account
   * @returns Array of fingerprint versions, or empty array if not found
   */
  getAccountFingerprintHistory(accountIndex: number): FingerprintVersion[] {
    const account = this.accounts[accountIndex]
    if (!account || !account.fingerprintHistory) {
      return []
    }
    return [...account.fingerprintHistory]
  }
}
