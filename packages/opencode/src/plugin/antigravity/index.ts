import { spawn } from "node:child_process"
import { tool } from "@opencode-ai/plugin"
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_PROVIDER_ID,
  SEARCH_MODEL,
  type HeaderStyle,
} from "./constants"
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth"
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth"
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from "./plugin/auth"
import { accessTokenExpired as geminiAccessTokenExpired, isOAuthAuth as isGeminiOAuth } from "../gemini-cli/plugin/auth"
import { refreshAccessToken as refreshGeminiAccessToken } from "../gemini-cli/plugin/token"
import { ensureProjectContext as ensureGeminiProjectContext } from "../gemini-cli/plugin/project"
import type {
  OAuthAuthDetails as GeminiOAuthAuthDetails,
  PluginClient as GeminiPluginClient,
} from "../gemini-cli/plugin/types"
import { promptAddAnotherAccount, promptLoginMode, promptProjectId } from "./plugin/cli"
import { ensureProjectContext } from "./plugin/project"
import {
  startAntigravityDebugRequest,
  logAntigravityDebugResponse,
  logAccountContext,
  logRateLimitEvent,
  logRateLimitSnapshot,
  logResponseBody,
  logModelFamily,
  isDebugEnabled,
  getLogFilePath,
  initializeDebug,
} from "./plugin/debug"
import {
  buildThinkingWarmupBody,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./plugin/request"
import { resolveModelWithTier } from "./plugin/transform/model-resolver"
import { isEmptyResponseBody, createSyntheticErrorResponse } from "./plugin/request-helpers"
import { EmptyResponseError } from "./plugin/errors"
import { AntigravityTokenRefreshError, refreshAccessToken } from "./plugin/token"
import { startOAuthListener, type OAuthListener } from "./plugin/server"
import { clearAccounts, loadAccounts, saveAccounts } from "./plugin/storage"
import { AccountManager, type ModelFamily, parseRateLimitReason, calculateBackoffMs } from "./plugin/accounts"
import { Account } from "../../account"
import { Auth } from "../../auth"
// @event_2026-02-06:rotation_unify - Removed ModelHealthRegistry import (use RateLimitTracker only)
import { debugCheckpoint } from "../../util/debug"
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker"
import { loadConfig, initRuntimeConfig, type AntigravityConfig } from "./plugin/config"
import { createSessionRecoveryHook, getRecoverySuccessToast } from "./plugin/recovery"
import { checkAccountsQuota, fetchModelQuotaResetTime, getCockpitBackoffMs } from "./plugin/quota"
import { initDiskSignatureCache } from "./plugin/cache"
import { createProactiveRefreshQueue, type ProactiveRefreshQueue } from "./plugin/refresh-queue"
import { initLogger, createLogger } from "./plugin/logger"
import { getHealthTracker as getGlobalHealthTracker } from "../../account/rotation"
import { executeSearch } from "./plugin/search"
import { initAntigravityVersion } from "./plugin/version"
import type {
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
} from "./plugin/types"

const MAX_OAUTH_ACCOUNTS = 10
const MAX_WARMUP_SESSIONS = 1000
const MAX_WARMUP_RETRIES = 2
const CAPACITY_BACKOFF_TIERS_MS = [5000, 10000, 20000, 30000, 60000]

// @event_2026-02-06:antigravity_v145_integration
// Track if this plugin instance is running in a child session (subagent, background task)
// Used to filter toasts based on toast_scope config
let isChildSession = false
let childSessionParentID: string | undefined = undefined

export let globalAccountManager: AccountManager | null = null
// Module-level cached getAuth function for tool access and refresh
let cachedGetAuth: GetAuth | null = null
export async function refreshGlobalAccountManager(): Promise<boolean> {
  debugCheckpoint("antigravity", "refreshGlobalAccountManager: start", { hasCachedGetAuth: !!cachedGetAuth })
  if (!cachedGetAuth) return false
  const auth = await cachedGetAuth()
  if (!isOAuthAuth(auth)) {
    debugCheckpoint("antigravity", "refreshGlobalAccountManager: non-oauth auth")
    return false
  }
  const next = await AccountManager.loadFromDisk(auth)
  if (!globalAccountManager) {
    globalAccountManager = next
    debugCheckpoint("antigravity", "refreshGlobalAccountManager: initialized global manager", {
      count: next.getAccountCount(),
    })
    return true
  }
  globalAccountManager.replaceFrom(next)
  debugCheckpoint("antigravity", "refreshGlobalAccountManager: replaced global manager", {
    count: next.getAccountCount(),
  })
  return true
}

function getCapacityBackoffDelay(consecutiveFailures: number): number {
  const index = Math.min(consecutiveFailures, CAPACITY_BACKOFF_TIERS_MS.length - 1)
  return CAPACITY_BACKOFF_TIERS_MS[Math.max(0, index)] ?? 5000
}
const warmupAttemptedSessionIds = new Set<string>()
const warmupSucceededSessionIds = new Set<string>()

const log = createLogger("plugin")

// Module-level toast debounce to persist across requests (fixes toast spam)
const rateLimitToastCooldowns = new Map<string, number>()
const RATE_LIMIT_TOAST_COOLDOWN_MS = 5000
const MAX_TOAST_COOLDOWN_ENTRIES = 100

// Track if "all accounts rate-limited" toast was shown to prevent spam in while loop
let allAccountsRateLimitedToastShown = false

function cleanupToastCooldowns(): void {
  if (rateLimitToastCooldowns.size > MAX_TOAST_COOLDOWN_ENTRIES) {
    const now = Date.now()
    for (const [key, time] of rateLimitToastCooldowns) {
      if (now - time > RATE_LIMIT_TOAST_COOLDOWN_MS * 2) {
        rateLimitToastCooldowns.delete(key)
      }
    }
  }
}

function shouldShowRateLimitToast(message: string): boolean {
  cleanupToastCooldowns()
  const toastKey = message.replace(/\d+/g, "X")
  const lastShown = rateLimitToastCooldowns.get(toastKey) ?? 0
  const now = Date.now()
  if (now - lastShown < RATE_LIMIT_TOAST_COOLDOWN_MS) {
    return false
  }
  rateLimitToastCooldowns.set(toastKey, now)
  return true
}

function resetAllAccountsRateLimitedToast(): void {
  allAccountsRateLimitedToastShown = false
}

function trackWarmupAttempt(sessionId: string): boolean {
  if (warmupSucceededSessionIds.has(sessionId)) {
    return false
  }
  if (warmupAttemptedSessionIds.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupAttemptedSessionIds.values().next().value
    if (first) {
      warmupAttemptedSessionIds.delete(first)
      warmupSucceededSessionIds.delete(first)
    }
  }
  const attempts = getWarmupAttemptCount(sessionId)
  if (attempts >= MAX_WARMUP_RETRIES) {
    return false
  }
  warmupAttemptedSessionIds.add(sessionId)
  return true
}

function getWarmupAttemptCount(sessionId: string): number {
  return warmupAttemptedSessionIds.has(sessionId) ? 1 : 0
}

function markWarmupSuccess(sessionId: string): void {
  warmupSucceededSessionIds.add(sessionId)
  if (warmupSucceededSessionIds.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupSucceededSessionIds.values().next().value
    if (first) warmupSucceededSessionIds.delete(first)
  }
}

function clearWarmupAttempt(sessionId: string): void {
  warmupAttemptedSessionIds.delete(sessionId)
}

function isWSL(): boolean {
  if (process.platform !== "linux") return false
  try {
    const { readFileSync } = require("node:fs")
    const release = readFileSync("/proc/version", "utf8").toLowerCase()
    return release.includes("microsoft") || release.includes("wsl")
  } catch {
    // Ignore error on non-Linux platforms or if /proc/version is inaccessible
    return false
  }
}

function isWSL2(): boolean {
  if (!isWSL()) return false
  try {
    const { readFileSync } = require("node:fs")
    const version = readFileSync("/proc/version", "utf8").toLowerCase()
    return version.includes("wsl2") || version.includes("microsoft-standard")
  } catch {
    return false
  }
}

function isRemoteEnvironment(): boolean {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSL()) {
    return true
  }
  return false
}

function shouldSkipLocalServer(): boolean {
  return isWSL2() || isRemoteEnvironment()
}

async function openBrowser(url: string): Promise<boolean> {
  const parsedUrl = (() => {
    try {
      return new URL(url)
    } catch {
      return undefined
    }
  })()
  if (!parsedUrl || (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")) {
    return false
  }

  const safeUrl = parsedUrl.toString()
  const launch = (command: string, args: string[]) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    })
    child.once("error", () => {})
    child.unref()
  }

  try {
    if (process.platform === "darwin") {
      launch("open", [safeUrl])
      return true
    }
    if (process.platform === "win32") {
      launch("explorer.exe", [safeUrl])
      return true
    }
    if (isWSL()) {
      try {
        launch("wslview", [safeUrl])
        return true
      } catch {
        // Fallback to xdg-open if wslview fails
      }
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return false
    }
    launch("xdg-open", [safeUrl])
    return true
  } catch (error) {
    debugCheckpoint("ANTIGRAVITY", "OPEN_BROWSER_FAILED", { error: String(error) })
    return false
  }
}

async function promptOAuthCallbackValue(message: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises")
  const { stdin, stdout } = await import("node:process")
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return (await rl.question(message)).trim()
  } finally {
    rl.close()
  }
}

type OAuthCallbackParams = { code: string; state: string }

function getStateFromAuthorizationUrl(authorizationUrl: string): string {
  try {
    return new URL(authorizationUrl).searchParams.get("state") ?? ""
  } catch {
    return ""
  }
}

function extractOAuthCallbackParams(url: URL): OAuthCallbackParams | null {
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) {
    return null
  }
  return { code, state }
}

function parseOAuthCallbackInput(value: string, fallbackState: string): OAuthCallbackParams | { error: string } {
  const trimmed = value.trim()
  if (!trimmed) {
    return { error: "Missing authorization code" }
  }

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state") ?? fallbackState

    if (!code) {
      return { error: "Missing code in callback URL" }
    }
    if (!state) {
      return { error: "Missing state in callback URL" }
    }

    return { code, state }
  } catch {
    if (!fallbackState) {
      return { error: "Missing state. Paste the full redirect URL instead of only the code." }
    }

    return { code: trimmed, state: fallbackState }
  }
}

async function promptManualOAuthInput(fallbackState: string): Promise<AntigravityTokenExchangeResult> {
  console.log("1. Open the URL above in your browser and complete Google sign-in.")
  console.log("2. After approving, copy the full redirected localhost URL from the address bar.")
  console.log("3. Paste it back here.\n")

  const callbackInput = await promptOAuthCallbackValue("Paste the redirect URL (or just the code) here: ")
  const params = parseOAuthCallbackInput(callbackInput, fallbackState)
  if ("error" in params) {
    return { type: "failed", error: params.error }
  }

  return exchangeAntigravity(params.code, params.state)
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

async function persistAccountPool(
  results: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>>,
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) {
    return
  }

  const now = Date.now()

  // Use Account module as the single source of truth
  const existingAccounts = replaceAll ? {} : await Account.list("antigravity")

  // Build lookup maps for deduplication
  // IMPORTANT: Parse refreshToken to get base token for comparison
  // since stored tokens may be in combined format (token|projectId)
  const accountByEmail = new Map<string, string>()
  const accountByToken = new Map<string, string>()
  for (const [id, info] of Object.entries(existingAccounts)) {
    if (info.type !== "subscription") continue
    if (info.email) accountByEmail.set(info.email, id)
    if (info.refreshToken) {
      // Parse to get base token - handles both "token" and "token|projectId" formats
      const baseToken = parseRefreshParts(info.refreshToken).refreshToken
      accountByToken.set(baseToken, id)
    }
  }

  let firstAccountId: string | undefined

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh)
    if (!parts.refreshToken) {
      continue
    }

    // Check for existing account by email or token
    const existingByEmail = result.email ? accountByEmail.get(result.email) : undefined
    const existingByToken = accountByToken.get(parts.refreshToken)
    const existingId = existingByEmail ?? existingByToken

    try {
      if (existingId) {
        // Update existing account
        await Account.update("antigravity", existingId, {
          email: result.email,
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId: parts.managedProjectId,
        })
        if (!firstAccountId) firstAccountId = existingId
      } else {
        // Add new account
        const slug = result.email
          ? result.email.toLowerCase().replace(/@/g, "-").replace(/\./g, "-")
          : Date.now().toString(36)
        const accountId = `antigravity-subscription-${slug}`

        await Account.add("antigravity", accountId, {
          type: "subscription",
          name: result.email || `Account ${slug}`,
          email: result.email,
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId: parts.managedProjectId,
          addedAt: now,
        })

        // Update lookup maps for subsequent iterations
        if (result.email) accountByEmail.set(result.email, accountId)
        accountByToken.set(parts.refreshToken, accountId)

        if (!firstAccountId) firstAccountId = accountId
      }
    } catch (e) {
      console.error("[persistAccountPool] Failed to persist account:", e)
      // Log the full error stack for debugging
      if (e instanceof Error) {
        console.error("[persistAccountPool] Stack:", e.stack)
      }
    }
  }

  // Set the first account as active if this is a fresh login
  if (replaceAll && firstAccountId) {
    await Account.setActive("antigravity", firstAccountId)
  }

  // Refresh global account manager to pick up changes
  await refreshGlobalAccountManager()
}

function retryAfterMsFromResponse(response: Response, defaultRetryMs: number = 60_000): number {
  const retryAfterMsHeader = response.headers.get("retry-after-ms")
  if (retryAfterMsHeader) {
    const parsed = Number.parseInt(retryAfterMsHeader, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }

  const retryAfterHeader = response.headers.get("retry-after")
  if (retryAfterHeader) {
    const parsed = Number.parseInt(retryAfterHeader, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1000
    }
  }

  return defaultRetryMs
}

/**
 * Parse Go-style duration strings to milliseconds.
 * Supports compound durations: "1h16m0.667s", "1.5s", "200ms", "5m30s"
 *
 * @param duration - Duration string in Go format
 * @returns Duration in milliseconds, or null if parsing fails
 */
function parseDurationToMs(duration: string): number | null {
  // Handle simple formats first for backwards compatibility
  const simpleMatch = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i)
  if (simpleMatch) {
    const value = parseFloat(simpleMatch[1]!)
    const unit = (simpleMatch[2] || "s").toLowerCase()
    switch (unit) {
      case "h":
        return value * 3600 * 1000
      case "m":
        return value * 60 * 1000
      case "s":
        return value * 1000
      case "ms":
        return value
      default:
        return value * 1000
    }
  }

  // Parse compound Go-style durations: "1h16m0.667s", "5m30s", etc.
  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi
  let totalMs = 0
  let matchFound = false
  let match

  while ((match = compoundRegex.exec(duration)) !== null) {
    matchFound = true
    const value = parseFloat(match[1]!)
    const unit = match[2]!.toLowerCase()
    switch (unit) {
      case "h":
        totalMs += value * 3600 * 1000
        break
      case "m":
        totalMs += value * 60 * 1000
        break
      case "s":
        totalMs += value * 1000
        break
      case "ms":
        totalMs += value
        break
    }
  }

  return matchFound ? totalMs : null
}

interface RateLimitBodyInfo {
  retryDelayMs: number | null
  message?: string
  quotaResetTime?: string
  reason?: string
}

function extractRateLimitBodyInfo(body: unknown): RateLimitBodyInfo {
  if (!body || typeof body !== "object") {
    return { retryDelayMs: null }
  }

  const error = (body as { error?: unknown }).error
  const message = error && typeof error === "object" ? (error as { message?: string }).message : undefined

  const details = error && typeof error === "object" ? (error as { details?: unknown[] }).details : undefined

  let reason: string | undefined
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue
      const type = (detail as { "@type"?: string })["@type"]
      if (typeof type === "string" && type.includes("google.rpc.ErrorInfo")) {
        const detailReason = (detail as { reason?: string }).reason
        if (typeof detailReason === "string") {
          reason = detailReason
          break
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue
      const type = (detail as { "@type"?: string })["@type"]
      if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
        const retryDelay = (detail as { retryDelay?: string }).retryDelay
        if (typeof retryDelay === "string") {
          const retryDelayMs = parseDurationToMs(retryDelay)
          if (retryDelayMs !== null) {
            return { retryDelayMs, message, reason }
          }
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue
      const metadata = (detail as { metadata?: Record<string, string> }).metadata
      if (metadata && typeof metadata === "object") {
        const quotaResetDelay = metadata.quotaResetDelay
        const quotaResetTime = metadata.quotaResetTimeStamp
        if (typeof quotaResetDelay === "string") {
          const quotaResetDelayMs = parseDurationToMs(quotaResetDelay)
          if (quotaResetDelayMs !== null) {
            return { retryDelayMs: quotaResetDelayMs, message, quotaResetTime, reason }
          }
        }
      }
    }
  }

  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i)
    const rawDuration = afterMatch?.[1]
    if (rawDuration) {
      const parsed = parseDurationToMs(rawDuration)
      if (parsed !== null) {
        return { retryDelayMs: parsed, message, reason }
      }
    }
  }

  return { retryDelayMs: null, message, reason }
}

async function extractRetryInfoFromBody(response: Response): Promise<RateLimitBodyInfo> {
  try {
    const text = await response.clone().text()
    try {
      const parsed = JSON.parse(text) as unknown
      return extractRateLimitBodyInfo(parsed)
    } catch {
      return { retryDelayMs: null }
    }
  } catch {
    return { retryDelayMs: null }
  }
}

function formatWaitTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

// Progressive rate limit retry delays
const FIRST_RETRY_DELAY_MS = 1000 // 1s - first 429 quick retry on same account
const SWITCH_ACCOUNT_DELAY_MS = 5000 // 5s - delay before switching to another account

/**
 * Rate limit state tracking with time-window deduplication.
 *
 * Problem: When multiple subagents hit 429 simultaneously, each would increment
 * the consecutive counter, causing incorrect exponential backoff (5 concurrent
 * 429s = 2^5 backoff instead of 2^1).
 *
 * Solution: Track per account+quota with deduplication window. Multiple 429s
 * within RATE_LIMIT_DEDUP_WINDOW_MS are treated as a single event.
 */
const RATE_LIMIT_DEDUP_WINDOW_MS = 2000 // 2 seconds - concurrent requests within this window are deduplicated
const RATE_LIMIT_STATE_RESET_MS = 120_000 // Reset consecutive counter after 2 minutes of no 429s

interface RateLimitState {
  consecutive429: number
  lastAt: number
  quotaKey: string // Track which quota this state is for
}

// Key format: `${accountIndex}:${quotaKey}` for per-account-per-quota tracking
const rateLimitStateByAccountQuota = new Map<string, RateLimitState>()

// Track empty response retry attempts (ported from LLM-API-Key-Proxy)
const emptyResponseAttempts = new Map<string, number>()

/**
 * Get rate limit backoff with time-window deduplication.
 *
 * @param accountIndex - The account index
 * @param quotaKey - The quota key (e.g., "gemini-cli", "gemini-antigravity", "claude")
 * @param serverRetryAfterMs - Server-provided retry delay (if any)
 * @param maxBackoffMs - Maximum backoff delay in milliseconds (default 60000)
 * @returns { attempt, delayMs, isDuplicate } - isDuplicate=true if within dedup window
 */
function getRateLimitBackoff(
  accountIndex: number,
  quotaKey: string,
  serverRetryAfterMs: number | null,
  maxBackoffMs: number = 60_000,
): { attempt: number; delayMs: number; isDuplicate: boolean } {
  const now = Date.now()
  const stateKey = `${accountIndex}:${quotaKey}`
  const previous = rateLimitStateByAccountQuota.get(stateKey)

  // Check if this is a duplicate 429 within the dedup window
  if (previous && now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS) {
    // Same rate limit event from concurrent request - don't increment
    const baseDelay = serverRetryAfterMs ?? 1000
    const backoffDelay = Math.min(baseDelay * Math.pow(2, previous.consecutive429 - 1), maxBackoffMs)
    return {
      attempt: previous.consecutive429,
      delayMs: Math.max(baseDelay, backoffDelay),
      isDuplicate: true,
    }
  }

  // Check if we should reset (no 429 for 2 minutes) or increment
  const attempt = previous && now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS ? previous.consecutive429 + 1 : 1

  rateLimitStateByAccountQuota.set(stateKey, {
    consecutive429: attempt,
    lastAt: now,
    quotaKey,
  })

  const baseDelay = serverRetryAfterMs ?? 1000
  const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxBackoffMs)
  return { attempt, delayMs: Math.max(baseDelay, backoffDelay), isDuplicate: false }
}

/**
 * Reset rate limit state for an account+quota combination.
 * Only resets the specific quota, not all quotas for the account.
 */
function resetRateLimitState(accountIndex: number, quotaKey: string): void {
  const stateKey = `${accountIndex}:${quotaKey}`
  rateLimitStateByAccountQuota.delete(stateKey)
}

/**
 * Reset all rate limit state for an account (all quotas).
 * Used when account is completely healthy.
 */
function resetAllRateLimitStateForAccount(accountIndex: number): void {
  for (const key of rateLimitStateByAccountQuota.keys()) {
    if (key.startsWith(`${accountIndex}:`)) {
      rateLimitStateByAccountQuota.delete(key)
    }
  }
}

function headerStyleToQuotaKey(headerStyle: HeaderStyle, family: ModelFamily): string {
  if (family === "claude") return "claude"
  return headerStyle === "antigravity" ? "gemini-antigravity" : "gemini-cli"
}

// =============================================================================
// RPM Throttle — per-account per-family sliding window
// FIX: Avoid triggering upstream soft-bans by limiting request frequency
// =============================================================================

/** Sliding window of request timestamps, keyed by `${accountIndex}:${family}` */
const rpmWindows = new Map<string, number[]>()

/**
 * Wait if necessary to stay within the RPM limit.
 * Returns the number of milliseconds waited (0 if no wait was needed).
 */
async function enforceRpmLimit(
  accountIndex: number,
  family: string,
  rpmLimit: number,
  signal?: AbortSignal | null,
): Promise<number> {
  if (rpmLimit <= 0) return 0

  const key = `${accountIndex}:${family}`
  const now = Date.now()
  const windowMs = 60_000 // 1 minute sliding window

  // Get or create timestamps array
  let timestamps = rpmWindows.get(key)
  if (!timestamps) {
    timestamps = []
    rpmWindows.set(key, timestamps)
  }

  // Purge entries older than 1 minute
  const cutoff = now - windowMs
  while (timestamps.length > 0 && timestamps[0]! < cutoff) {
    timestamps.shift()
  }

  // If under limit, record and proceed
  if (timestamps.length < rpmLimit) {
    timestamps.push(now)
    return 0
  }

  // Over limit — calculate wait time until oldest entry expires
  const oldestTs = timestamps[0]!
  const waitMs = oldestTs + windowMs - now + Math.floor(Math.random() * 500) // +jitter
  if (waitMs > 0) {
    debugCheckpoint("ANTIGRAVITY", "RPM_THROTTLE", {
      accountIndex,
      family,
      rpmLimit,
      currentCount: timestamps.length,
      waitMs,
    })
    await sleep(waitMs, signal)
  }

  // Purge again after waiting, then record
  const nowAfter = Date.now()
  const cutoff2 = nowAfter - windowMs
  while (timestamps.length > 0 && timestamps[0]! < cutoff2) {
    timestamps.shift()
  }
  timestamps.push(nowAfter)

  return waitMs > 0 ? waitMs : 0
}

// Track consecutive non-429 failures per account to prevent infinite loops
const accountFailureState = new Map<number, { consecutiveFailures: number; lastFailureAt: number }>()
const MAX_CONSECUTIVE_FAILURES = 5
const FAILURE_COOLDOWN_MS = 30_000 // 30 seconds cooldown after max failures
const FAILURE_STATE_RESET_MS = 120_000 // Reset failure count after 2 minutes of no failures

function trackAccountFailure(accountIndex: number): { failures: number; shouldCooldown: boolean; cooldownMs: number } {
  const now = Date.now()
  const previous = accountFailureState.get(accountIndex)

  // Reset if last failure was more than 2 minutes ago
  const failures =
    previous && now - previous.lastFailureAt < FAILURE_STATE_RESET_MS ? previous.consecutiveFailures + 1 : 1

  accountFailureState.set(accountIndex, { consecutiveFailures: failures, lastFailureAt: now })

  const shouldCooldown = failures >= MAX_CONSECUTIVE_FAILURES
  const cooldownMs = shouldCooldown ? FAILURE_COOLDOWN_MS : 0

  return { failures, shouldCooldown, cooldownMs }
}

function resetAccountFailureState(accountIndex: number): void {
  accountFailureState.delete(accountIndex)
}

/**
 * Sleep for a given number of milliseconds, respecting an abort signal.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"))
      return
    }

    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    const onAbort = () => {
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"))
    }

    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export const createAntigravityPlugin =
  (providerId: string) =>
  async ({ client, directory }: PluginContext): Promise<PluginResult> => {
    // Load configuration from files and environment variables
    const config = loadConfig(directory)
    initRuntimeConfig(config)

    // Initialize runtime Antigravity version (remote fetch with fallback)
    await initAntigravityVersion()

    // Initialize debug with config
    initializeDebug(config)

    // Initialize structured logger for TUI integration
    initLogger(client)

    // Initialize health tracker for hybrid strategy
    // if (config.health_score) {
    //   initHealthTracker({
    //     initial: config.health_score.initial,
    //     successReward: config.health_score.success_reward,
    //     rateLimitPenalty: config.health_score.rate_limit_penalty,
    //     failurePenalty: config.health_score.failure_penalty,
    //     recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
    //     minUsable: config.health_score.min_usable,
    //     maxScore: config.health_score.max_score,
    //   })
    // }

    // Initialize token tracker for hybrid strategy
    // if (config.token_bucket) {
    //   initTokenTracker({
    //     maxTokens: config.token_bucket.max_tokens,
    //     regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
    //     initialTokens: config.token_bucket.initial_tokens,
    //   })
    // }

    // Initialize disk signature cache if keep_thinking is enabled
    // This integrates with the in-memory cacheSignature/getCachedSignature functions
    if (config.keep_thinking) {
      initDiskSignatureCache(config.signature_cache)
    }

    // Initialize session recovery hook with full context
    const sessionRecovery = createSessionRecoveryHook({ client, directory }, config)

    const updateChecker = createAutoUpdateCheckerHook(client, directory, {
      showStartupToast: true,
      autoUpdate: config.auto_update,
    })

    // Event handler for session recovery and updates
    const eventHandler = async (input: { event: { type: string; properties?: unknown } }) => {
      // Forward to update checker
      await updateChecker.event(input)

      // @event_2026-02-06:antigravity_v145_integration
      // Track if this is a child session (subagent, background task)
      // Used to filter toasts based on toast_scope config
      if (input.event.type === "session.created") {
        const props = input.event.properties as { info?: { parentID?: string } } | undefined
        if (props?.info?.parentID) {
          isChildSession = true
          childSessionParentID = props.info.parentID
          log.debug("child-session-detected", { parentID: props.info.parentID })
        } else {
          // Reset for root sessions - important when plugin instance is reused
          isChildSession = false
          childSessionParentID = undefined
          log.debug("root-session-detected", {})
        }
      }

      // Handle session recovery
      if (sessionRecovery && input.event.type === "session.error") {
        const props = input.event.properties as Record<string, unknown> | undefined
        const sessionID = props?.sessionID as string | undefined
        const messageID = props?.messageID as string | undefined
        const error = props?.error

        if (sessionRecovery.isRecoverableError(error)) {
          const messageInfo = {
            id: messageID,
            role: "assistant" as const,
            sessionID,
            error,
          }

          // handleSessionRecovery now does the actual fix (injects tool_result, etc.)
          const recovered = await sessionRecovery.handleSessionRecovery(messageInfo)

          // Only send "continue" AFTER successful tool_result_missing recovery
          // (thinking recoveries already resume inside handleSessionRecovery)
          if (recovered && sessionID && config.auto_resume) {
            // For tool_result_missing, we need to send continue after injecting tool_results
            await client.session
              .prompt({
                path: { id: sessionID },
                body: { parts: [{ type: "text", text: config.resume_text }] },
                query: { directory },
              })
              .catch(() => {})

            // @event_2026-02-06:antigravity_v145_integration
            // Show success toast (respects toast_scope for child sessions)
            const successToast = getRecoverySuccessToast()
            log.debug("recovery-toast", { ...successToast, isChildSession, toastScope: config.toast_scope })
            if (!(config.toast_scope === "root_only" && isChildSession)) {
              await client.tui
                .showToast({
                  body: {
                    title: successToast.title,
                    message: successToast.message,
                    variant: "success",
                  },
                })
                .catch(() => {})
            }
          }
        }
      }
    }

    // Create google_search tool with access to auth context
    const googleSearchTool = tool({
      description:
        "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. Uses Antigravity OAuth when configured; otherwise uses Gemini CLI OAuth. Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST extract those URLs and pass them in the 'urls' parameter for direct analysis.",
      args: {
        query: tool.schema.string().describe("The search query or question to answer using web search"),
        urls: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe(
            "List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here.",
          ),
        thinking: tool.schema
          .boolean()
          .optional()
          .default(true)
          .describe("Enable deep thinking for more thorough analysis (default: true)"),
      },
      async execute(args, ctx) {
        log.debug("Google Search tool called", { query: args.query, urlCount: args.urls?.length ?? 0 })
        debugCheckpoint("google_search", "start", {
          query: args.query,
          urlCount: args.urls?.length ?? 0,
          thinking: args.thinking ?? true,
        })

        const executeGeminiCliSearch = async (): Promise<{ ok: boolean; output: string; error?: string }> => {
          debugCheckpoint("google_search", "gemini-cli: start")
          const auth = await Auth.get("gemini-cli")
          if (!auth || !isGeminiOAuth(auth)) {
            debugCheckpoint("google_search", "gemini-cli: missing auth")
            return {
              ok: false,
              output:
                "Error: Gemini CLI OAuth is not configured. Please configure Gemini CLI OAuth (via /admin or accounts.json), or use an Antigravity account.",
              error: "Gemini CLI OAuth is not configured",
            }
          }

          const geminiClient: GeminiPluginClient = {
            auth: {
              set: async (input: { path: { id: string }; body: GeminiOAuthAuthDetails }) => {
                if (input.body.type !== "oauth") return
                const body = {
                  type: "oauth" as const,
                  refresh: input.body.refresh,
                  access: input.body.access,
                  expires: input.body.expires,
                  accountId: input.body.accountId,
                }
                await client.auth.set({
                  path: { id: input.path.id },
                  body,
                })
              },
            },
          }

          let authRecord = {
            type: "oauth" as const,
            refresh: auth.refresh,
            access: auth.access,
            expires: auth.expires,
          }

          if (geminiAccessTokenExpired(authRecord)) {
            debugCheckpoint("google_search", "gemini-cli: access token expired, refreshing")
            const refreshed = await refreshGeminiAccessToken(authRecord, geminiClient)
            if (!refreshed) {
              debugCheckpoint("google_search", "gemini-cli: refresh failed")
              return {
                ok: false,
                output:
                  "Error: Gemini CLI access token refresh failed. Please reconfigure Gemini CLI OAuth (via /admin or accounts.json), or use an Antigravity account.",
                error: "Gemini CLI access token refresh failed",
              }
            }
            if (refreshed.type !== "oauth") {
              debugCheckpoint("google_search", "gemini-cli: unexpected auth type", { type: refreshed.type })
              return {
                ok: false,
                output:
                  "Error: Gemini CLI auth must be OAuth. Please configure Gemini CLI OAuth (via /admin or accounts.json), or use an Antigravity account.",
                error: "Gemini CLI auth must be OAuth",
              }
            }
            authRecord = {
              type: "oauth",
              refresh: refreshed.refresh,
              access: refreshed.access,
              expires: refreshed.expires,
            }
          }

          const accessToken = authRecord.access
          if (!accessToken) {
            debugCheckpoint("google_search", "gemini-cli: missing access token")
            return {
              ok: false,
              output:
                "Error: Gemini CLI access token is missing. Please reconfigure Gemini CLI OAuth (via /admin or accounts.json), or use an Antigravity account.",
              error: "Gemini CLI access token is missing",
            }
          }

          const configuredProjectId = process.env.OPENCODE_GEMINI_PROJECT_ID?.trim() || undefined
          debugCheckpoint("google_search", "gemini-cli: resolve project context", {
            configuredProjectId: configuredProjectId ? "set" : "unset",
          })
          const projectContext = await ensureGeminiProjectContext(authRecord, geminiClient, configuredProjectId).catch(
            (error) => {
              const message = error instanceof Error ? error.message : String(error)
              return { error: message } as const
            },
          )

          if ("error" in projectContext) {
            debugCheckpoint("google_search", "gemini-cli: project context error", { error: projectContext.error })
            return {
              ok: false,
              output: `Error: ${projectContext.error}`,
              error: projectContext.error,
            }
          }

          if (!projectContext.effectiveProjectId) {
            debugCheckpoint("google_search", "gemini-cli: missing project id")
            return {
              ok: false,
              output: "Error: Gemini CLI project ID is missing. Set OPENCODE_GEMINI_PROJECT_ID and retry.",
              error: "Gemini CLI project ID is missing",
            }
          }

          const projectId = projectContext.effectiveProjectId
          debugCheckpoint("google_search", "gemini-cli: execute search", {
            projectId,
          })
          const result = await executeSearch(
            {
              query: args.query,
              urls: args.urls,
              thinking: args.thinking,
            },
            accessToken,
            projectId,
            ctx.abort,
            { headerStyle: "gemini-cli" },
          )
          if (result.ok) {
            debugCheckpoint("google_search", "gemini-cli: search ok")
            return { ok: true, output: result.output }
          }
          if (result.error === "Search returned empty response") {
            debugCheckpoint("google_search", "gemini-cli: empty response, retry with fallback model")
            const retry = await executeSearch(
              {
                query: args.query,
                urls: args.urls,
                thinking: false,
              },
              accessToken,
              projectId,
              ctx.abort,
              { headerStyle: "gemini-cli", model: "gemini-2.5-flash" },
            )
            if (retry.ok) {
              debugCheckpoint("google_search", "gemini-cli: retry ok")
              return { ok: true, output: retry.output }
            }
            debugCheckpoint("google_search", "gemini-cli: retry failed", { error: retry.error })
            return { ok: false, output: retry.output, error: retry.error }
          }
          debugCheckpoint("google_search", "gemini-cli: search failed", { error: result.error })
          return { ok: false, output: result.output, error: result.error }
        }

        await refreshGlobalAccountManager()

        let accountManager = globalAccountManager ?? (await AccountManager.loadFromDisk())
        if (!globalAccountManager) {
          globalAccountManager = accountManager
        }

        await accountManager.reloadFromAccountModule()
        debugCheckpoint("google_search", "antigravity: reloaded accounts", {
          count: accountManager.getAccountCount(),
          activeIndex: accountManager.getActiveIndex(),
          activeIndexByFamily: accountManager.getActiveIndexByFamily(),
        })

        const hardcodedEmail = "yeatsluo@gmail.com"
        const hardcodedModel = "gemini-3-pro"
        const hardcodedAccount = accountManager.getEnabledAccounts().find((account) => account.email === hardcodedEmail)
        if (!hardcodedAccount) {
          debugCheckpoint("google_search", "antigravity: hardcoded account not found", {
            email: hardcodedEmail,
          })
          return `Error: google_search hardcoded account not found (${hardcodedEmail})`
        }

        debugCheckpoint("google_search", "antigravity: hardcoded account selected", {
          email: hardcodedEmail,
          model: hardcodedModel,
          accountIndex: hardcodedAccount.index,
        })

        let authRecord = accountManager.toAuthDetails(hardcodedAccount)
        if (accessTokenExpired(authRecord)) {
          debugCheckpoint("google_search", "antigravity: access token expired, refreshing", {
            accountIndex: hardcodedAccount.index,
          })
          const refreshed = await refreshAccessToken(authRecord, client, providerId).catch((error) => {
            if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
              const removed = accountManager.removeAccount(hardcodedAccount)
              if (removed) {
                accountManager.requestSaveToDisk()
              }
            }
            const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(hardcodedAccount.index)
            getGlobalHealthTracker().recordFailure(`antigravity-account-${hardcodedAccount.index}`, "antigravity")
            if (shouldCooldown) {
              accountManager.markAccountCoolingDown(hardcodedAccount, cooldownMs, "auth-failure")
              accountManager.markRateLimited(hardcodedAccount, cooldownMs, "gemini", "antigravity", hardcodedModel)
            }
            return undefined
          })

          if (!refreshed) {
            debugCheckpoint("google_search", "antigravity: refresh failed", {
              accountIndex: hardcodedAccount.index,
            })
            return "Error: google_search hardcoded account refresh failed"
          }

          resetAccountFailureState(hardcodedAccount.index)
          accountManager.updateFromAuth(hardcodedAccount, refreshed)
          accountManager.requestSaveToDisk()
          await accountManager.flushSaveToDisk()
          authRecord = refreshed
          debugCheckpoint("google_search", "antigravity: refresh ok", {
            accountIndex: hardcodedAccount.index,
            expiresAt: authRecord.expires,
          })
        }

        const token = authRecord.access ?? ""
        if (!token) {
          debugCheckpoint("google_search", "antigravity: missing access token", {
            accountIndex: hardcodedAccount.index,
          })
          return "Error: google_search hardcoded account missing access token"
        }

        let projectContext: ProjectContextResult
        try {
          projectContext = await ensureProjectContext(authRecord)
          resetAccountFailureState(hardcodedAccount.index)
        } catch (error) {
          const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(hardcodedAccount.index)
          getGlobalHealthTracker().recordFailure(`antigravity-account-${hardcodedAccount.index}`, "antigravity")
          if (shouldCooldown) {
            accountManager.markAccountCoolingDown(hardcodedAccount, cooldownMs, "project-error")
            accountManager.markRateLimited(hardcodedAccount, cooldownMs, "gemini", "antigravity", hardcodedModel)
          }
          const message = error instanceof Error ? error.message : String(error)
          debugCheckpoint("google_search", "antigravity: project context error", {
            accountIndex: hardcodedAccount.index,
            error: message,
          })
          return `Error: google_search hardcoded account project context error (${message})`
        }

        if (projectContext.auth !== authRecord) {
          accountManager.updateFromAuth(hardcodedAccount, projectContext.auth)
          authRecord = projectContext.auth
          accountManager.requestSaveToDisk()
          await accountManager.flushSaveToDisk()
          const parts = parseRefreshParts(authRecord.refresh)
          debugCheckpoint("google_search", "antigravity: project context persisted", {
            accountIndex: hardcodedAccount.index,
            projectId: parts.projectId,
            managedProjectId: parts.managedProjectId,
            effectiveProjectId: projectContext.effectiveProjectId,
          })
        }

        const projectId = projectContext.effectiveProjectId
        if (!projectId) {
          debugCheckpoint("google_search", "antigravity: missing project id", {
            accountIndex: hardcodedAccount.index,
          })
          return "Error: google_search hardcoded account missing project ID"
        }

        accountManager.markAccountUsed(hardcodedAccount.index)
        accountManager.requestSaveToDisk()

        debugCheckpoint("google_search", "antigravity: execute search", {
          accountIndex: hardcodedAccount.index,
          projectId,
          model: hardcodedModel,
          hardcoded: true,
        })
        const hardcodedResult = await executeSearch(
          {
            query: args.query,
            urls: args.urls,
            thinking: args.thinking,
          },
          token,
          projectId,
          ctx.abort,
          { headerStyle: "antigravity", model: hardcodedModel },
        )
        if (hardcodedResult.ok) {
          debugCheckpoint("google_search", "antigravity: search ok", {
            accountIndex: hardcodedAccount.index,
          })
          return hardcodedResult.output
        }

        debugCheckpoint("google_search", "antigravity: search failed", {
          accountIndex: hardcodedAccount.index,
          error: hardcodedResult.error,
        })
        return `Error: google_search hardcoded account failed (${hardcodedResult.error ?? "Search failed"})`

        const accountCount = accountManager.getAccountCount()
        debugCheckpoint("google_search", "antigravity: account count", { count: accountCount })
        if (accountCount === 0) {
          debugCheckpoint("google_search", "antigravity: no accounts, fallback to gemini-cli")
          const geminiResult = await executeGeminiCliSearch()
          if (geminiResult.ok) {
            debugCheckpoint("google_search", "gemini-cli: returned result after no antigravity accounts")
            return geminiResult.output
          }
          debugCheckpoint("google_search", "google_search: both providers failed", {
            antigravity: "no accounts",
            geminiCli: geminiResult.error,
          })
          return `Error: google_search authentication failed for antigravity and gemini-cli. ${geminiResult.output}`
        }

        let lastError: Error | null = null

        for (let attempt = 0; attempt < accountCount; attempt++) {
          const account = accountManager.getCurrentOrNextForFamily(
            "gemini",
            SEARCH_MODEL,
            "sticky",
            "antigravity",
            config.pid_offset_enabled,
          )

          if (!account) {
            debugCheckpoint("google_search", "antigravity: no available account")
            lastError = new Error("No available Antigravity accounts")
            break
          }

          const selected = account as NonNullable<typeof account>
          let authRecord = accountManager.toAuthDetails(selected)
          if (accessTokenExpired(authRecord)) {
            debugCheckpoint("google_search", "antigravity: access token expired, refreshing", {
              accountIndex: selected.index,
            })
            const refreshed = await refreshAccessToken(authRecord, client, providerId).catch((error) => {
              lastError = error instanceof Error ? error : new Error(String(error))
              if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
                const removed = accountManager.removeAccount(selected)
                if (removed) {
                  accountManager.requestSaveToDisk()
                }
              }
              const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(selected.index)
              getGlobalHealthTracker().recordFailure(`antigravity-account-${selected.index}`, "antigravity")
              if (shouldCooldown) {
                accountManager.markAccountCoolingDown(selected, cooldownMs, "auth-failure")
                accountManager.markRateLimited(selected, cooldownMs, "gemini", "antigravity", SEARCH_MODEL)
              }
              return undefined
            })

            if (!refreshed) {
              debugCheckpoint("google_search", "antigravity: refresh failed", { accountIndex: selected.index })
              continue
            }

            const refreshedAuth = refreshed as OAuthAuthDetails
            resetAccountFailureState(selected.index)
            accountManager.updateFromAuth(selected, refreshedAuth)
            accountManager.requestSaveToDisk()
            await accountManager.flushSaveToDisk()
            authRecord = refreshedAuth
            debugCheckpoint("google_search", "antigravity: refresh ok", {
              accountIndex: selected.index,
              expiresAt: authRecord.expires,
            })
          }

          const token = authRecord.access ?? ""
          if (!token) {
            debugCheckpoint("google_search", "antigravity: missing access token", { accountIndex: selected.index })
            lastError = new Error("Missing access token")
            continue
          }

          let projectContext: ProjectContextResult
          try {
            projectContext = await ensureProjectContext(authRecord)
            resetAccountFailureState(selected.index)
          } catch (error) {
            const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(selected.index)
            getGlobalHealthTracker().recordFailure(`antigravity-account-${selected.index}`, "antigravity")
            const err = (error instanceof Error ? error : new Error(String(error))) as Error
            lastError = err
            const message = err.message
            if (shouldCooldown) {
              accountManager.markAccountCoolingDown(selected, cooldownMs, "project-error")
              accountManager.markRateLimited(selected, cooldownMs, "gemini", "antigravity", SEARCH_MODEL)
            }
            debugCheckpoint("google_search", "antigravity: project context error", {
              accountIndex: selected.index,
              error: message,
            })
            continue
          }

          if (projectContext.auth !== authRecord) {
            accountManager.updateFromAuth(selected, projectContext.auth)
            authRecord = projectContext.auth
            accountManager.requestSaveToDisk()
            await accountManager.flushSaveToDisk()
            const parts = parseRefreshParts(authRecord.refresh)
            debugCheckpoint("google_search", "antigravity: project context persisted", {
              accountIndex: selected.index,
              projectId: parts.projectId,
              managedProjectId: parts.managedProjectId,
              effectiveProjectId: projectContext.effectiveProjectId,
            })
          }

          const projectId = projectContext.effectiveProjectId
          if (!projectId) {
            debugCheckpoint("google_search", "antigravity: missing project id", { accountIndex: selected.index })
            lastError = new Error("Missing project ID")
            continue
          }

          const project = projectId

          accountManager.markAccountUsed(selected.index)
          accountManager.requestSaveToDisk()

          debugCheckpoint("google_search", "antigravity: execute search", {
            accountIndex: selected.index,
            projectId: project,
          })
          const result = await executeSearch(
            {
              query: args.query,
              urls: args.urls,
              thinking: args.thinking,
            },
            token,
            project,
            ctx.abort,
            { headerStyle: "antigravity" },
          )
          if (result.ok) {
            debugCheckpoint("google_search", "antigravity: search ok", { accountIndex: selected.index })
            return result.output
          }

          debugCheckpoint("google_search", "antigravity: search failed", {
            accountIndex: selected.index,
            error: result.error,
          })
          lastError = new Error(result.error ?? "Search failed")
          continue
        }

        debugCheckpoint("google_search", "antigravity: all attempts failed, trying gemini-cli", {
          error: lastError?.message,
        })
        const geminiResult = await executeGeminiCliSearch()
        if (geminiResult.ok) {
          debugCheckpoint("google_search", "gemini-cli: returned result after antigravity failure")
          return geminiResult.output
        }

        const antigravityError = lastError?.message ?? "No available Antigravity accounts"
        debugCheckpoint("google_search", "google_search: both providers failed", {
          antigravity: antigravityError,
          geminiCli: geminiResult.error,
        })
        return `Error: google_search authentication failed for antigravity and gemini-cli. Antigravity: ${antigravityError}. Gemini CLI: ${geminiResult.error ?? "unknown error"}`
      },
    })

    return {
      event: eventHandler,
      "experimental.chat.system.transform": async (input: any, output: any) => {
        try {
          const modelId = input.model?.id?.toLowerCase() || ""
          if (!modelId.includes("gemini")) return

          const system = output.system
          if (!system || system.length === 0) return

          const mainPrompt = system[0]
          if (!mainPrompt) return

          // 1. Identify AGENTS.md content
          const agentsBlockRegex =
            /Instructions from: .*?(?:AGENTS|CLAUDE)\.md[\s\S]*?(?=\nInstructions from:|<env>|$)/g
          const matches = mainPrompt.match(agentsBlockRegex)

          if (matches && matches.length > 0) {
            const agentsContent = matches.join("\n\n").trim()
            let strippedPrompt = mainPrompt.replace(agentsBlockRegex, "").trim()

            // 2. Identify Identity/Start and any immediate IMPORTANT/CRITICAL mandates
            // Since identity is now removed, we look for the IMPORTANT block at the start
            const headerRegex = /^(IMPORTANT:[\s\S]*?)(?=\n# |$)/
            const headerMatch = strippedPrompt.match(headerRegex)

            let header = ""
            if (headerMatch) {
              header = headerMatch[1].trim()
              strippedPrompt = strippedPrompt.replace(headerMatch[0], "").trim()
            }

            const optimizedAgents = ["<behavioral_guidelines>", agentsContent, "</behavioral_guidelines>"].join("\n")

            // Reconstruct: Header -> Optimized Guidelines -> Rest
            output.system[0] = [header, optimizedAgents, strippedPrompt].filter(Boolean).join("\n\n")
          }
        } catch (error) {
          console.error("[Antigravity] Failed to transform system prompt:", error)
        }
      },
      tool: {
        google_search: googleSearchTool,
      },
      auth: {
        provider: providerId,
        loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>> => {
          // Cache getAuth for tool access
          cachedGetAuth = getAuth

          const auth = await getAuth()

          // If OpenCode has no valid OAuth auth, clear any stale account storage
          if (!isOAuthAuth(auth)) {
            try {
              await clearAccounts()
            } catch (error) {
              log.debug("Failed to clear stale accounts", { error: String(error) })
            }
            return {}
          }

          // Validate that stored accounts are in sync with OpenCode's auth
          // If OpenCode's refresh token doesn't match any stored account, clear stale storage
          const authParts = parseRefreshParts(auth.refresh)
          const storedAccounts = await loadAccounts()

          // Note: AccountManager now ensures the current auth is always included in accounts

          const accountManager = await AccountManager.loadFromDisk(auth)
          globalAccountManager = accountManager

          // Initialize proactive refresh queue (if enabled)
          if (accountManager.getAccountCount() > 0) {
            accountManager.requestSaveToDisk()
          }

          // Initialize proactive token refresh queue (ported from LLM-API-Key-Proxy)
          let refreshQueue: ProactiveRefreshQueue | null = null
          if (config.proactive_token_refresh && accountManager.getAccountCount() > 0) {
            refreshQueue = createProactiveRefreshQueue(client, providerId, {
              enabled: config.proactive_token_refresh,
              bufferSeconds: config.proactive_refresh_buffer_seconds,
              checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
            })
            refreshQueue.setAccountManager(accountManager)
            refreshQueue.start()
          }

          if (isDebugEnabled()) {
            const logPath = getLogFilePath()
            if (logPath) {
              try {
                await client.tui.showToast({
                  body: { message: `Debug log: ${logPath}`, variant: "info" },
                })
              } catch {
                // TUI may not be available
              }
            }
          }

          if (provider.models) {
            for (const model of Object.values(provider.models)) {
              if (model) {
                model.cost = { input: 0, output: 0 }
              }
            }
          }

          return {
            apiKey: "",
            async fetch(input, init) {
              const inputUrl = toUrlString(input)
              debugCheckpoint("antigravity-plugin", "Custom fetch called", { url: inputUrl.substring(0, 100) })

              if (!isGenerativeLanguageRequest(input)) {
                debugCheckpoint("antigravity-plugin", "Not a generativelanguage request, using default fetch")
                return fetch(input, init)
              }

              const latestAuth = await getAuth()
              if (!isOAuthAuth(latestAuth)) {
                debugCheckpoint("antigravity-plugin", "No OAuth auth, using default fetch", {
                  authType: latestAuth?.type,
                })
                return fetch(input, init)
              }

              debugCheckpoint("antigravity-plugin", "OAuth auth present, proceeding with antigravity handling")

              if (accountManager.getAccountCount() === 0) {
                throw new Error("No Antigravity accounts configured. Run `opencode auth login`.")
              }

              const urlString = toUrlString(input)
              const family = getModelFamilyFromUrl(urlString)
              const model = extractModelFromUrl(urlString)

              // Extract accountId from headers if present
              const headers = init?.headers ? new Headers(init.headers) : new Headers()
              const headerAccountId = headers.get("x-opencode-account-id") || undefined

              // Determine base provider ID for protocol selection (Strict 3D Vector Logic)
              // 1. Use accountId from header if available (most specific)
              // 2. Fallback to plugin providerId
              // 3. Normalize using Account.parseProvider to handle "google-api" -> "gemini-cli" mapping if needed
              const rawProviderID = headerAccountId
                ? (Account.parseProvider(headerAccountId) ?? providerId)
                : providerId

              // Top-level request tracking
              debugCheckpoint("ANTIGRAVITY", "REQUEST_START", {
                family,
                model,
                url: urlString.substring(0, 100), // Truncate for readability
                accountCount: accountManager.getAccountCount(),
              })

              const debugLines: string[] = []
              const pushDebug = (line: string) => {
                if (!isDebugEnabled()) return
                debugLines.push(line)
              }
              pushDebug(`request=${urlString}`)

              type FailureContext = {
                response: Response
                streaming: boolean
                debugContext: ReturnType<typeof startAntigravityDebugRequest>
                requestedModel?: string
                projectId?: string
                endpoint?: string
                effectiveModel?: string
                sessionId?: string
                toolDebugMissing?: number
                toolDebugSummary?: string
                toolDebugPayload?: string
              }

              let lastFailure: FailureContext | null = null
              let lastError: Error | null = null
              const abortSignal = init?.signal ?? undefined

              // Helper to check if request was aborted
              const checkAborted = () => {
                if (abortSignal?.aborted) {
                  debugCheckpoint("ANTIGRAVITY", "REQUEST_ABORTED", {
                    family,
                    model,
                    reason:
                      abortSignal.reason instanceof Error ? abortSignal.reason.message : String(abortSignal.reason),
                  })
                  throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Aborted")
                }
              }

              // Use while(true) loop to handle rate limits with backoff
              // This ensures we wait and retry when all accounts are rate-limited
              const quietMode = config.quiet_mode
              const toastScope = config.toast_scope

              // @event_2026-02-06:antigravity_v145_integration
              // Helper to show toast without blocking on abort (respects quiet_mode and toast_scope)
              const showToast = async (message: string, variant: "info" | "warning" | "success" | "error") => {
                // Always log to debug regardless of toast filtering
                log.debug("toast", { message, variant, isChildSession, toastScope })

                if (quietMode) return
                if (abortSignal?.aborted) return

                // Filter toasts for child sessions when toast_scope is "root_only"
                if (toastScope === "root_only" && isChildSession) {
                  log.debug("toast-suppressed-child-session", { message, variant, parentID: childSessionParentID })
                  return
                }

                if (variant === "warning" && message.toLowerCase().includes("rate")) {
                  if (!shouldShowRateLimitToast(message)) {
                    return
                  }
                }

                try {
                  await client.tui.showToast({
                    body: { message, variant },
                  })
                } catch {
                  // TUI may not be available
                }
              }

              const hasOtherAccountWithAntigravity = (currentAccount: any): boolean => {
                if (family !== "gemini") return false
                const otherAccounts = accountManager.getAccounts().filter((acc) => acc.index !== currentAccount.index)
                return otherAccounts.some(
                  (acc) => !accountManager.isRateLimitedForHeaderStyle(acc, family, "antigravity", model),
                )
              }

              while (true) {
                // Check for abort at the start of each iteration
                checkAborted()

                // Sync with Account module to respect /admin changes
                await accountManager.syncActiveFromAccountModule()

                const accountCount = accountManager.getAccountCount()

                if (accountCount === 0) {
                  throw new Error("No Antigravity accounts available. Run `opencode auth login`.")
                }

                const pickAccount = async () => {
                  // Single source of truth: use whatever account rotation3d has set via Account.setActive().
                  // syncActiveFromAccountModule() (called above) already synced the index.
                  // This plugin does NOT decide which account to use — rotation3d does.
                  const pinned = accountManager.getPinnedForFamily(family)
                  if (!pinned) return null

                  // Strict Protocol Selection by Provider ID
                  const pinnedCoreId = pinned._coreAccountId
                  const pinnedProviderID =
                    (pinnedCoreId ? Account.parseProvider(pinnedCoreId) : providerId) ?? providerId
                  const headerStyle = getHeaderStyleFromUrl(urlString, family, pinnedProviderID)

                  const explicitQuota = isExplicitQuotaFromUrl(urlString)
                  let limited = accountManager.isRateLimitedForHeaderStyle(pinned, family, headerStyle, model)
                  const cooling = accountManager.isAccountCoolingDown(pinned)

                  // FIX: Avoid stale local Claude cooldown.
                  // Local rateLimitResetTimes may become stale while cockpit already reports
                  // available quota (remainingFraction > 0). Re-validate once with cockpit.
                  if (limited && !cooling && family === "claude" && pinned.access && pinned.parts.projectId && model) {
                    try {
                      const quota = await fetchModelQuotaResetTime(pinned.access, pinned.parts.projectId, model)
                      if (quota.remainingFraction !== null && quota.remainingFraction > 0) {
                        delete pinned.rateLimitResetTimes.claude
                        pinned.consecutiveFailures = 0
                        accountManager.requestSaveToDisk()
                        limited = false

                        debugCheckpoint("ANTIGRAVITY", "fixed_quota_revalidated", {
                          family,
                          model,
                          accountIndex: pinned.index,
                          remainingFraction: quota.remainingFraction,
                          resetTimeMs: quota.resetTimeMs,
                        })
                      }
                    } catch (e) {
                      debugCheckpoint("ANTIGRAVITY", "fixed_quota_revalidate_failed", {
                        family,
                        model,
                        accountIndex: pinned.index,
                        error: e instanceof Error ? e.message : String(e),
                      })
                    }
                  }

                  if (!limited && !cooling) return pinned

                  // Account is unavailable — throw to let rotation3d decide next move.
                  // Do NOT attempt internal fallback. rotation3d is the single authority.
                  const waitMs = accountManager.getMinWaitTimeForFamily(family, model, headerStyle, explicitQuota) || 0
                  const waitTimeFormatted = waitMs > 0 ? formatWaitTime(waitMs) : "later"
                  const cooldownReason = accountManager.getAccountCooldownReason(pinned)
                  const reasonLabel = cooling
                    ? `cooling down${cooldownReason ? ` (${cooldownReason})` : ""}`
                    : "temporarily unavailable"

                  await showToast(
                    `Selected account ${reasonLabel}. Retry ${waitTimeFormatted} or choose another model.`,
                    "warning",
                  )

                  const unavailableError: Error & {
                    status?: number
                    statusCode?: number
                    retryAfter?: number
                  } = new Error(
                    `Selected account ${reasonLabel} for ${family}. Retry ${waitTimeFormatted} or choose another model.`,
                  )
                  unavailableError.status = 503
                  unavailableError.statusCode = 503
                  unavailableError.retryAfter = Math.max(1, Math.ceil(waitMs / 1000))
                  throw unavailableError
                }

                const account = await pickAccount()

                if (!account) {
                  // Strict Protocol Selection by Provider ID (using fallback providerId as account is null)
                  const fallbackProviderID = rawProviderID === "google-api" ? "gemini-cli" : rawProviderID
                  const headerStyle = getHeaderStyleFromUrl(urlString, family, fallbackProviderID)

                  const explicitQuota = isExplicitQuotaFromUrl(urlString)
                  // All accounts are rate-limited - wait and retry
                  const waitMs =
                    accountManager.getMinWaitTimeForFamily(family, model, headerStyle, explicitQuota) || 60_000
                  const waitSecValue = Math.max(1, Math.ceil(waitMs / 1000))

                  debugCheckpoint("ANTIGRAVITY_ROTATION", "all_accounts_limited", {
                    family,
                    waitMs,
                    waitSecValue,
                    accountCount,
                    headerStyle,
                  })

                  pushDebug(`all-rate-limited family=${family} accounts=${accountCount} waitMs=${waitMs}`)
                  if (isDebugEnabled()) {
                    logAccountContext("All accounts rate-limited", {
                      index: -1,
                      family,
                      totalAccounts: accountCount,
                    })
                    logRateLimitSnapshot(family, accountManager.getAccountsSnapshot())
                  }

                  // If wait time exceeds max threshold, return error immediately instead of hanging
                  // 0 means disabled (wait indefinitely)
                  const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000
                  if (maxWaitMs > 0 && waitMs > maxWaitMs) {
                    const waitTimeFormatted = formatWaitTime(waitMs)
                    await showToast(
                      `Rate limited for ${waitTimeFormatted}. Try again later or add another account.`,
                      "error",
                    )

                    // Return a proper rate limit error response
                    throw new Error(
                      `All ${accountCount} account(s) rate-limited for ${family}. ` +
                        `Quota resets in ${waitTimeFormatted}. ` +
                        `Add more accounts with \`opencode auth login\` or wait and retry.`,
                    )
                  }

                  if (!allAccountsRateLimitedToastShown) {
                    await showToast(
                      `All ${accountCount} account(s) rate-limited for ${family}. Waiting ${waitSecValue}s...`,
                      "warning",
                    )
                    allAccountsRateLimitedToastShown = true
                    debugCheckpoint("ANTIGRAVITY", "ALL_ACCOUNTS_RATE_LIMITED", {
                      family,
                      accountCount,
                      waitMs,
                      waitSecValue,
                    })
                  }

                  // Wait for the rate-limit cooldown to expire, then retry
                  await sleep(waitMs, abortSignal)
                  continue
                }

                // Account is available - reset the toast flag
                resetAllAccountsRateLimitedToast()

                // Determine base provider ID for protocol selection
                // This normalizes "antigravity-subscription-1" -> "antigravity"
                const coreId = account._coreAccountId
                const effectiveProviderID = coreId ? Account.parseProvider(coreId) : providerId

                pushDebug(
                  `selected idx=${account.index} email=${account.email ?? ""} family=${family} accounts=${accountCount} provider=${effectiveProviderID}`,
                )
                if (isDebugEnabled()) {
                  logAccountContext("Selected", {
                    index: account.index,
                    email: account.email,
                    family,
                    totalAccounts: accountCount,
                    rateLimitState: account.rateLimitResetTimes,
                  })
                }

                // Show toast when switching to a different account (debounced, quiet_mode handled by showToast)
                if (accountCount > 1 && accountManager.shouldShowAccountToast(account.index)) {
                  const accountLabel = account.email || `Account ${account.index + 1}`
                  // Calculate position among enabled accounts (not absolute index)
                  const enabledAccounts = accountManager.getEnabledAccounts()
                  const enabledPosition = enabledAccounts.findIndex((a) => a.index === account.index) + 1
                  await showToast(`Using ${accountLabel} (${enabledPosition}/${accountCount})`, "info")
                  accountManager.markToastShown(account.index)
                }

                accountManager.requestSaveToDisk()

                let authRecord = accountManager.toAuthDetails(account)

                if (accessTokenExpired(authRecord)) {
                  try {
                    const refreshed = await refreshAccessToken(authRecord, client, providerId)
                    if (!refreshed) {
                      const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index)
                      getGlobalHealthTracker().recordFailure(`antigravity-account-${account.index}`, "antigravity")
                      lastError = new Error("Antigravity token refresh failed")
                      if (shouldCooldown) {
                        accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure")
                        // Use headerStyle determined by providerId if possible, else "antigravity" as safe default for auth errors
                        const errorHeaderStyle =
                          providerId === "gemini-cli"
                            ? "gemini-cli"
                            : providerId === "antigravity"
                              ? "antigravity"
                              : "antigravity"
                        accountManager.markRateLimited(account, cooldownMs, family, errorHeaderStyle, model)
                        pushDebug(`token-refresh-failed: cooldown ${cooldownMs}ms after ${failures} failures`)
                      }
                      continue
                    }
                    resetAccountFailureState(account.index)
                    accountManager.updateFromAuth(account, refreshed)
                    authRecord = refreshed
                    try {
                      await accountManager.saveToDisk()
                    } catch (error) {
                      log.error("Failed to persist refreshed auth", { error: String(error) })
                    }
                  } catch (error) {
                    if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
                      const removed = accountManager.removeAccount(account)
                      if (removed) {
                        log.warn("Removed revoked account from pool - reauthenticate via `opencode auth login`")
                        try {
                          await accountManager.saveToDisk()
                        } catch (persistError) {
                          log.error("Failed to persist revoked account removal", { error: String(persistError) })
                        }
                      }

                      if (accountManager.getAccountCount() === 0) {
                        try {
                          await client.auth.set({
                            path: { id: providerId },
                            body: { type: "oauth", refresh: "", access: "", expires: 0 },
                          })
                        } catch (storeError) {
                          log.error("Failed to clear stored Antigravity OAuth credentials", {
                            error: String(storeError),
                          })
                        }

                        throw new Error(
                          "All Antigravity accounts have invalid refresh tokens. Run `opencode auth login` and reauthenticate.",
                        )
                      }

                      lastError = error
                      continue
                    }

                    const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index)
                    getGlobalHealthTracker().recordFailure(`antigravity-account-${account.index}`, "antigravity")
                    lastError = error instanceof Error ? error : new Error(String(error))
                    if (shouldCooldown) {
                      accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure")
                      const errorHeaderStyle =
                        providerId === "gemini-cli"
                          ? "gemini-cli"
                          : providerId === "antigravity"
                            ? "antigravity"
                            : "antigravity"
                      accountManager.markRateLimited(account, cooldownMs, family, errorHeaderStyle, model)
                      pushDebug(`token-refresh-error: cooldown ${cooldownMs}ms after ${failures} failures`)
                    }
                    continue
                  }
                }

                const accessToken = authRecord.access
                if (!accessToken) {
                  lastError = new Error("Missing access token")
                  if (accountCount <= 1) {
                    throw lastError
                  }
                  continue
                }

                let projectContext: ProjectContextResult
                try {
                  projectContext = await ensureProjectContext(authRecord)
                  resetAccountFailureState(account.index)
                } catch (error) {
                  const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index)
                  getGlobalHealthTracker().recordFailure(`antigravity-account-${account.index}`, "antigravity")
                  lastError = error instanceof Error ? error : new Error(String(error))
                  if (shouldCooldown) {
                    accountManager.markAccountCoolingDown(account, cooldownMs, "project-error")
                    accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model)
                    pushDebug(`project-context-error: cooldown ${cooldownMs}ms after ${failures} failures`)
                  }
                  continue
                }

                if (projectContext.auth !== authRecord) {
                  accountManager.updateFromAuth(account, projectContext.auth)
                  authRecord = projectContext.auth
                  try {
                    await accountManager.saveToDisk()
                  } catch (error) {
                    log.error("Failed to persist project context", { error: String(error) })
                  }
                }

                const runThinkingWarmup = async (
                  prepared: ReturnType<typeof prepareAntigravityRequest>,
                  projectId: string,
                ): Promise<void> => {
                  if (!prepared.needsSignedThinkingWarmup || !prepared.sessionId) {
                    return
                  }

                  if (!trackWarmupAttempt(prepared.sessionId)) {
                    return
                  }

                  const warmupBody = buildThinkingWarmupBody(
                    typeof prepared.init.body === "string" ? prepared.init.body : undefined,
                    Boolean(
                      prepared.effectiveModel?.toLowerCase().includes("claude") &&
                        prepared.effectiveModel?.toLowerCase().includes("thinking"),
                    ),
                  )
                  if (!warmupBody) {
                    return
                  }

                  const warmupUrl = toWarmupStreamUrl(prepared.request)
                  const warmupHeaders = new Headers(prepared.init.headers ?? {})
                  warmupHeaders.set("accept", "text/event-stream")

                  const warmupInit: RequestInit = {
                    ...prepared.init,
                    method: prepared.init.method ?? "POST",
                    headers: warmupHeaders,
                    body: warmupBody,
                  }

                  const warmupDebugContext = startAntigravityDebugRequest({
                    originalUrl: warmupUrl,
                    resolvedUrl: warmupUrl,
                    method: warmupInit.method,
                    headers: warmupHeaders,
                    body: warmupBody,
                    streaming: true,
                    projectId,
                  })

                  try {
                    pushDebug("thinking-warmup: start")
                    debugCheckpoint("ANTIGRAVITY", "thinking-warmup: starting", {
                      sessionId: prepared.sessionId,
                      url: warmupUrl,
                    })
                    const warmupResponse = await fetch(warmupUrl, warmupInit)
                    const transformed = await transformAntigravityResponse(
                      warmupResponse,
                      true,
                      warmupDebugContext,
                      prepared.requestedModel,
                      projectId,
                      warmupUrl,
                      prepared.effectiveModel,
                      prepared.sessionId,
                    )
                    await transformed.text()
                    markWarmupSuccess(prepared.sessionId)
                    pushDebug("thinking-warmup: done")
                    debugCheckpoint("ANTIGRAVITY", "thinking-warmup: completed", {
                      sessionId: prepared.sessionId,
                      status: warmupResponse.status,
                    })
                  } catch (error) {
                    clearWarmupAttempt(prepared.sessionId)
                    const errorMsg = error instanceof Error ? error.message : String(error)
                    pushDebug(`thinking-warmup: failed ${errorMsg}`)
                    debugCheckpoint("ANTIGRAVITY", "thinking-warmup: FAILED", {
                      sessionId: prepared.sessionId,
                      error: errorMsg,
                    })
                  }
                }

                // Try endpoint fallbacks with single header style based on model suffix

                // Strict Protocol Selection by Provider ID
                // Note: effectiveProviderID is derived from account.id or providerId in the outer scope
                const baseHeaderStyle = getHeaderStyleFromUrl(urlString, family, effectiveProviderID ?? providerId)
                const explicitQuota = isExplicitQuotaFromUrl(urlString)
                // @event_2026-02-06:antigravity_v145_integration
                // Apply cli_first preference for Gemini models
                const cliFirst = getCliFirst(config)
                let headerStyle = resolvePreferredHeaderStyle(baseHeaderStyle, family, explicitQuota, cliFirst)
                pushDebug(
                  `headerStyle=${headerStyle} baseStyle=${baseHeaderStyle} cliFirst=${cliFirst} explicit=${explicitQuota}`,
                )
                if (account.fingerprint) {
                  pushDebug(
                    `fingerprint: quotaUser=${account.fingerprint.quotaUser} deviceId=${account.fingerprint.deviceId.slice(0, 8)}...`,
                  )
                }

                // Check if this header style is rate-limited for this account
                if (accountManager.isRateLimitedForHeaderStyle(account, family, headerStyle, model)) {
                  // Quota fallback: try alternate quota on same account (if enabled and not explicit)
                  if (config.quota_fallback && !explicitQuota && family === "gemini") {
                    const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model)
                    if (alternateStyle && alternateStyle !== headerStyle) {
                      const quotaName = headerStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity"
                      const altQuotaName = alternateStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity"
                      await showToast(`${quotaName} quota exhausted, using ${altQuotaName} quota`, "warning")
                      headerStyle = alternateStyle
                      pushDebug(`quota fallback: ${headerStyle}`)
                    } else {
                      // Account is rate limited on all quota styles — throw to rotation3d
                      const preLimitError: Error & { status?: number; statusCode?: number; retryAfter?: number } =
                        new Error(`Account pre-check: rate limited for ${family}/${headerStyle}`)
                      preLimitError.status = 429
                      preLimitError.statusCode = 429
                      preLimitError.retryAfter = 120
                      throw preLimitError
                    }
                  } else {
                    // Account is rate limited — throw to rotation3d
                    const preLimitError: Error & { status?: number; statusCode?: number; retryAfter?: number } =
                      new Error(`Account pre-check: rate limited for ${family}/${headerStyle}`)
                    preLimitError.status = 429
                    preLimitError.statusCode = 429
                    preLimitError.retryAfter = 120
                    throw preLimitError
                  }
                }

                // Flag to force thinking recovery on retry after API error
                let forceThinkingRecovery = false
                let forceDisableThinking = false

                // Track if token was consumed (for hybrid strategy refund on error)
                let tokenConsumed = false

                // Track capacity retries per endpoint to prevent infinite loops
                let capacityRetryCount = 0
                let lastEndpointIndex = -1

                for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
                  // Reset capacity retry counter when switching to a new endpoint
                  if (i !== lastEndpointIndex) {
                    capacityRetryCount = 0
                    lastEndpointIndex = i
                  }

                  const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i]

                  // @event_2026-02-06:antigravity_v145_integration
                  // #233: Skip sandbox endpoints for Gemini CLI models - they only work with production endpoint
                  if (headerStyle === "gemini-cli" && currentEndpoint !== ANTIGRAVITY_ENDPOINT_PROD) {
                    pushDebug(`Skipping sandbox endpoint ${currentEndpoint} for gemini-cli headerStyle`)
                    continue
                  }

                  try {
                    const prepared = prepareAntigravityRequest(
                      input,
                      init,
                      accessToken,
                      projectContext.effectiveProjectId,
                      currentEndpoint,
                      headerStyle,
                      forceThinkingRecovery,
                      {
                        claudeToolHardening: config.claude_tool_hardening,
                        fingerprint: account.fingerprint,
                        forceDisableThinking,
                      },
                    )

                    debugCheckpoint("ANTIGRAVITY", "REQUEST_PREPARED", {
                      family,
                      model,
                      effectiveModel: prepared.effectiveModel,
                      accountIndex: account.index,
                      endpoint: currentEndpoint,
                    })

                    const originalUrl = toUrlString(input)
                    const resolvedUrl = toUrlString(prepared.request)
                    pushDebug(`endpoint=${currentEndpoint}`)
                    pushDebug(`resolved=${resolvedUrl}`)
                    const debugContext = startAntigravityDebugRequest({
                      originalUrl,
                      resolvedUrl,
                      method: prepared.init.method,
                      headers: prepared.init.headers,
                      body: prepared.init.body,
                      streaming: prepared.streaming,
                      projectId: projectContext.effectiveProjectId,
                    })

                    await runThinkingWarmup(prepared, projectContext.effectiveProjectId)

                    if (config.request_jitter_max_ms > 0) {
                      const jitterMs = Math.floor(Math.random() * config.request_jitter_max_ms)
                      if (jitterMs > 0) {
                        await sleep(jitterMs, abortSignal)
                      }
                    }

                    // RPM Throttle — disabled; soft-ban root cause is protocol, not frequency
                    // await enforceRpmLimit(account.index, family, config.rpm_limit, abortSignal)

                    // Consume token for hybrid strategy
                    // Refunded later if request fails (429 or network error)
                    // Legacy strategy check removed - now always consumes if token tracker active?
                    // Actually, let's keep it conditional on strategy but hardcode to false or remove strategy check
                    // Since we are removing strategy config, let's assume no hybrid token tracking for now or default to false
                    // if (config.account_selection_strategy === "hybrid") {
                    //   tokenConsumed = getTokenTracker().consume(account.index)
                    // }

                    debugCheckpoint("ANTIGRAVITY", "FETCH_START", {
                      family,
                      model,
                      accountIndex: account.index,
                    })

                    const response = await fetch(prepared.request, prepared.init)

                    debugCheckpoint("ANTIGRAVITY", "FETCH_COMPLETE", {
                      family,
                      model,
                      accountIndex: account.index,
                      status: response.status,
                    })
                    pushDebug(`status=${response.status} ${response.statusText}`)

                    // Handle 429 rate limit (or Service Overloaded) with improved logic
                    if (response.status === 429 || response.status === 503 || response.status === 529) {
                      // Refund token on rate limit
                      if (tokenConsumed) {
                        tokenConsumed = false
                      }

                      const defaultRetryMs = (config.default_retry_after_seconds ?? 60) * 1000
                      const maxBackoffMs = (config.max_backoff_seconds ?? 60) * 1000
                      const headerRetryMs = retryAfterMsFromResponse(response, defaultRetryMs)
                      const bodyInfo = await extractRetryInfoFromBody(response)
                      const serverRetryMs = bodyInfo.retryDelayMs ?? headerRetryMs

                      // [Enhanced Parsing] Pass status to handling logic
                      const rateLimitReason = parseRateLimitReason(bodyInfo.reason, bodyInfo.message, response.status)

                      // All transient HTTP errors (429/503/529) go directly to rotation.
                      // Keep status semantics explicit:
                      // - 429: rate-limit/quota handling
                      // - 503: Service Unavailable
                      // - 529: Site Overloaded

                      // Unified error handling: mark rate limited + throw to rotation3d.
                      // NO internal account switching. rotation3d is the single authority.
                      {
                        // Calculate fallback backoff, then try cockpit for real reset time
                        let backoffMs = calculateBackoffMs(
                          rateLimitReason,
                          account.consecutiveFailures ?? 0,
                          serverRetryMs,
                        )
                        // Query cockpit for real reset time (non-blocking, fallback to calculated value)
                        debugCheckpoint("ANTIGRAVITY", "cockpit_query_check", {
                          hasAccess: !!account.access,
                          hasProjectId: !!account.parts.projectId,
                          hasModel: !!model,
                          accountIndex: account.index,
                          family,
                        })
                        if (account.access && account.parts.projectId && model) {
                          try {
                            const cockpitResult = await getCockpitBackoffMs(
                              account.access,
                              account.parts.projectId,
                              model,
                              backoffMs,
                            )
                            debugCheckpoint("ANTIGRAVITY", "cockpit_query_result", {
                              fromCockpit: cockpitResult.fromCockpit,
                              backoffMs: cockpitResult.backoffMs,
                              resetTimeMs: cockpitResult.resetTimeMs,
                              model,
                              accountIndex: account.index,
                            })
                            if (cockpitResult.fromCockpit) {
                              backoffMs = cockpitResult.backoffMs
                              pushDebug(
                                `429: cockpit reset ${new Date(cockpitResult.resetTimeMs!).toISOString()}, backoff=${backoffMs}ms`,
                              )
                            }
                          } catch (e) {
                            const errMsg = e instanceof Error ? e.message : String(e)
                            pushDebug(`429: cockpit query failed: ${errMsg}`)
                          }
                        }

                        // Mark account as rate limited locally
                        accountManager.markRateLimitedWithReason(
                          account,
                          family,
                          headerStyle,
                          model,
                          rateLimitReason,
                          serverRetryMs,
                          config.failure_ttl_seconds * 1000,
                        )
                        accountManager.requestSaveToDisk()

                        // Report to global rate limit tracker for rotation3d
                        const { getRateLimitTracker } = await import("../../account/rotation")
                        const coreAccountId = account._coreAccountId || `antigravity-account-${account.index}`
                        getRateLimitTracker().markRateLimited(
                          coreAccountId,
                          "antigravity",
                          rateLimitReason,
                          backoffMs,
                          model || undefined,
                        )
                        getGlobalHealthTracker().recordRateLimit(`antigravity-account-${account.index}`, "antigravity")

                        const waitTimeFormatted = formatWaitTime(backoffMs)
                        const statusCode = response.status
                        const errorLabel =
                          statusCode === 503
                            ? "Service unavailable"
                            : statusCode === 529
                              ? "Site overloaded"
                              : "Rate limited"

                        // Throw typed transient error — rotation3d decides next move
                        const rateLimitError: Error & {
                          status?: number
                          statusCode?: number
                          retryAfter?: number
                        } = new Error(
                          `${errorLabel} for ${family}. Reason: ${rateLimitReason}. Cooldown: ${waitTimeFormatted}`,
                        )
                        rateLimitError.status = statusCode
                        rateLimitError.statusCode = statusCode
                        rateLimitError.retryAfter = Math.ceil(backoffMs / 1000)

                        throw rateLimitError
                      }
                    }

                    // Success - reset rate limit backoff state for this quota
                    const quotaKey = headerStyleToQuotaKey(headerStyle, family)
                    resetRateLimitState(account.index, quotaKey)
                    resetAccountFailureState(account.index)

                    const shouldRetryEndpoint =
                      response.status === 403 || response.status === 404 || response.status >= 500

                    if (shouldRetryEndpoint) {
                      await logResponseBody(debugContext, response, response.status)
                    }

                    if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                      lastFailure = {
                        response,
                        streaming: prepared.streaming,
                        debugContext,
                        requestedModel: prepared.requestedModel,
                        projectId: prepared.projectId,
                        endpoint: prepared.endpoint,
                        effectiveModel: prepared.effectiveModel,
                        sessionId: prepared.sessionId,
                        toolDebugMissing: prepared.toolDebugMissing,
                        toolDebugSummary: prepared.toolDebugSummary,
                        toolDebugPayload: prepared.toolDebugPayload,
                      }
                      continue
                    }

                    // Success or non-retryable error - return the response
                    // @event_2026-02-06:rotation_unify - Removed redundant ModelHealthRegistry.markSuccess
                    if (response.ok) {
                      account.consecutiveFailures = 0
                      getGlobalHealthTracker().recordSuccess(`antigravity-account-${account.index}`, "antigravity")
                      accountManager.markAccountUsed(account.index)
                      debugCheckpoint("ANTIGRAVITY", "REQUEST_SUCCESS", {
                        family,
                        model,
                        accountIndex: account.index,
                        email: account.email,
                        status: response.status,
                      })
                    }
                    logAntigravityDebugResponse(debugContext, response, {
                      note: response.ok ? "Success" : `Error ${response.status}`,
                    })
                    if (!response.ok) {
                      await logResponseBody(debugContext, response, response.status)

                      // Handle 404 "Not Found" or 400 "Prompt too long" with synthetic response to avoid session lock
                      if (response.status === 404 || response.status === 400) {
                        const cloned = response.clone()
                        const bodyText = await cloned.text()

                        // [Auto-Fallback] if checking capabilities failed or backend is stricter than expected:
                        // If the model rejects the thinking config (e.g. "Thinking_config... only enabled when thinking is enabled"),
                        // we implicitly know this model DOES NOT support thinking.
                        // Instead of crashing, we forcibly disable thinking (forceDisableThinking=true) and retry transparently.
                        // This matches User request to "fallback automatically" without hardcoded allowlists.
                        if (
                          response.status === 400 &&
                          bodyText.includes("Thinking_config.include_thoughts is only enabled when thinking is enabled")
                        ) {
                          if (!forceDisableThinking) {
                            pushDebug("Thinking config error detected - retrying with thinking disabled")
                            forceDisableThinking = true
                            i = -1
                            continue
                          }
                        }

                        if (response.status === 404) {
                          const debugInfo = `\n\n[Debug Info]\nAccount: #${account.index} (${account.email || "Unknown"})\nRequested Model: ${prepared.requestedModel || "Unknown"}\nEffective Model: ${prepared.effectiveModel || "Unknown"}\nProject: ${prepared.projectId || "Unknown"}\nEndpoint: ${prepared.endpoint || "Unknown"}\nStatus: 404 Not Found\nRequest ID: ${response.headers.get("x-request-id") || "N/A"}`
                          const errorMessage = `[Antigravity Error] Resource not found (404).\n\nThis usually means the project ID is invalid for the selected endpoint, or the model is not supported on this endpoint.${debugInfo}`
                          return createSyntheticErrorResponse(errorMessage, prepared.requestedModel)
                        }

                        if (bodyText.includes("Prompt is too long") || bodyText.includes("prompt_too_long")) {
                          await showToast("Context too long - use /compact to reduce size", "warning")
                          const errorMessage = `[Antigravity Error] Context is too long for this model.\n\nPlease use /compact to reduce context size, then retry your request.\n\nAlternatively, you can:\n- Use /clear to start fresh\n- Use /undo to remove recent messages\n- Switch to a model with larger context window`
                          return createSyntheticErrorResponse(errorMessage, prepared.requestedModel)
                        }
                        // [Fix for "Always repeats 400 error"]
                        // If we get a 400 that is NOT "prompt too long" and NOT "thinking config",
                        // it might be a transient issue or account-specific issue.
                        // Instead of returning a synthetic error immediately, throw an error to trigger
                        // the existing rotation logic (switch endpoint or account).
                        // This allows finding a working path if one exists.
                        const errorMsg = `Antigravity 400 Error: ${bodyText.substring(0, 200)}...`
                        pushDebug(`Triggering rotation for 400 error: ${errorMsg}`)
                        throw new Error(errorMsg)
                      }
                    }

                    // Empty response retry logic (ported from LLM-API-Key-Proxy)
                    // For non-streaming responses, check if the response body is empty
                    // and retry if so (up to config.empty_response_max_attempts times)
                    if (response.ok && !prepared.streaming) {
                      const maxAttempts = config.empty_response_max_attempts ?? 4
                      const retryDelayMs = config.empty_response_retry_delay_ms ?? 2000

                      // Clone to check body without consuming original
                      const clonedForCheck = response.clone()
                      const bodyText = await clonedForCheck.text()

                      if (isEmptyResponseBody(bodyText)) {
                        // Track empty response attempts per request
                        const emptyAttemptKey = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`
                        const currentAttempts = (emptyResponseAttempts.get(emptyAttemptKey) ?? 0) + 1
                        emptyResponseAttempts.set(emptyAttemptKey, currentAttempts)

                        pushDebug(`empty-response: attempt ${currentAttempts}/${maxAttempts}`)

                        if (currentAttempts < maxAttempts) {
                          await showToast(
                            `Empty response received. Retrying (${currentAttempts}/${maxAttempts})...`,
                            "warning",
                          )
                          await sleep(retryDelayMs, abortSignal)
                          continue // Retry the endpoint loop
                        }

                        // Clean up and throw after max attempts
                        emptyResponseAttempts.delete(emptyAttemptKey)
                        throw new EmptyResponseError(
                          "antigravity",
                          prepared.effectiveModel ?? "unknown",
                          currentAttempts,
                        )
                      }

                      // Clean up successful attempt tracking
                      const emptyAttemptKeyClean = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`
                      emptyResponseAttempts.delete(emptyAttemptKeyClean)
                    }

                    const transformedResponse = await transformAntigravityResponse(
                      response,
                      prepared.streaming,
                      debugContext,
                      prepared.requestedModel,
                      prepared.projectId,
                      prepared.endpoint,
                      prepared.effectiveModel,
                      prepared.sessionId,
                      prepared.toolDebugMissing,
                      prepared.toolDebugSummary,
                      prepared.toolDebugPayload,
                      debugLines,
                    )

                    // Check for context errors and show appropriate toast
                    const contextError = transformedResponse.headers.get("x-antigravity-context-error")
                    if (contextError) {
                      if (contextError === "prompt_too_long") {
                        await showToast(
                          "Context too long - use /compact to reduce size, or trim your request",
                          "warning",
                        )
                      } else if (contextError === "tool_pairing") {
                        await showToast(
                          "Tool call/result mismatch - use /compact to fix, or /undo last message",
                          "warning",
                        )
                      }
                    }

                    return transformedResponse
                  } catch (error) {
                    debugCheckpoint("ANTIGRAVITY", "REQUEST_ERROR", {
                      family,
                      model,
                      accountIndex: account.index,
                      error: error instanceof Error ? error.message : String(error),
                      errorStack: error instanceof Error ? error.stack?.substring(0, 500) : undefined,
                    })

                    // Refund token on network/API error (only if consumed)
                    if (tokenConsumed) {
                      tokenConsumed = false
                    }

                    // Handle recoverable thinking errors - retry with forced recovery
                    if (error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
                      // Only retry once with forced recovery to avoid infinite loops
                      if (!forceThinkingRecovery) {
                        pushDebug("thinking-recovery: API error detected, retrying with forced recovery")
                        forceThinkingRecovery = true
                        i = -1 // Will become 0 after loop increment, restart endpoint loop
                        continue
                      }

                      // Already tried with forced recovery, give up and return error
                      const recoveryError =
                        error && typeof error === "object" ? (error as { originalError?: unknown }) : undefined
                      const originalError =
                        recoveryError?.originalError && typeof recoveryError.originalError === "object"
                          ? (recoveryError.originalError as { error?: { message?: string } })
                          : {
                              error: { message: "Thinking recovery triggered" },
                            }

                      const recoveryMessage = `${originalError.error?.message || "Session recovery failed"}\n\n[RECOVERY] Thinking block corruption could not be resolved. Try starting a new session.`

                      return new Response(
                        JSON.stringify({
                          type: "error",
                          error: {
                            type: "unrecoverable_error",
                            message: recoveryMessage,
                          },
                        }),
                        {
                          status: 400,
                          headers: { "Content-Type": "application/json" },
                        },
                      )
                    }

                    // Rate limit / soft-ban errors must NOT be retried on other endpoints
                    // — throw immediately to rotation3d
                    const errStatus = (error as any)?.status ?? (error as any)?.statusCode
                    if (errStatus === 429 || errStatus === 503 || errStatus === 529) {
                      throw error
                    }

                    if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                      lastError = error instanceof Error ? error : new Error(String(error))
                      continue
                    }

                    // All endpoints failed for this account - throw to rotation3d
                    const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index)
                    lastError = error instanceof Error ? error : new Error(String(error))
                    if (shouldCooldown) {
                      accountManager.markAccountCoolingDown(account, cooldownMs, "network-error")
                      accountManager.markRateLimited(account, cooldownMs, family, headerStyle, model)
                      pushDebug(`endpoint-error: cooldown ${cooldownMs}ms after ${failures} failures`)
                    }

                    // Throw to let rotation3d handle account switching
                    const networkError: Error & { status?: number; statusCode?: number; retryAfter?: number } =
                      new Error(`All endpoints failed for account ${account.index}: ${lastError.message}`)
                    networkError.status = 503
                    networkError.statusCode = 503
                    networkError.retryAfter = Math.ceil((cooldownMs || 60_000) / 1000)
                    throw networkError
                  }
                }

                // If we get here without returning, something went wrong
                if (lastFailure) {
                  return transformAntigravityResponse(
                    lastFailure.response,
                    lastFailure.streaming,
                    lastFailure.debugContext,
                    lastFailure.requestedModel,
                    lastFailure.projectId,
                    lastFailure.endpoint,
                    lastFailure.effectiveModel,
                    lastFailure.sessionId,
                    lastFailure.toolDebugMissing,
                    lastFailure.toolDebugSummary,
                    lastFailure.toolDebugPayload,
                    debugLines,
                  )
                }

                throw lastError || new Error("All Antigravity accounts failed")
              }
            },
          }
        },
        methods: [
          {
            label: "OAuth with Google (Antigravity)",
            type: "oauth",
            authorize: async (inputs?: Record<string, string>) => {
              const isHeadless = !!(
                process.env.SSH_CONNECTION ||
                process.env.SSH_CLIENT ||
                process.env.SSH_TTY ||
                process.env.OPENCODE_HEADLESS
              )

              // CLI flow (`opencode auth login`) passes an inputs object.
              if (inputs) {
                const accounts: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>> = []
                const noBrowser = inputs.noBrowser === "true" || inputs["no-browser"] === "true"
                const useManualMode = noBrowser || shouldSkipLocalServer()

                // Check for existing accounts and prompt user for login mode
                let startFresh = true
                let refreshAccountIndex: number | undefined
                const existingStorage = await loadAccounts()
                if (existingStorage && existingStorage.accounts.length > 0) {
                  let menuResult
                  while (true) {
                    const now = Date.now()
                    const existingAccounts = existingStorage.accounts.map((acc, idx) => {
                      let status: "active" | "rate-limited" | "expired" | "unknown" = "unknown"

                      const rateLimits = acc.rateLimitResetTimes
                      if (rateLimits) {
                        const isRateLimited = Object.values(rateLimits).some(
                          (resetTime) => typeof resetTime === "number" && resetTime > now,
                        )
                        if (isRateLimited) {
                          status = "rate-limited"
                        } else {
                          status = "active"
                        }
                      } else {
                        status = "active"
                      }

                      if (acc.coolingDownUntil && acc.coolingDownUntil > now) {
                        status = "rate-limited"
                      }

                      return {
                        email: acc.email,
                        index: idx,
                        addedAt: acc.addedAt,
                        lastUsed: acc.lastUsed,
                        status,
                        isCurrentAccount: idx === (existingStorage.activeIndex ?? 0),
                        enabled: acc.enabled !== false,
                      }
                    })

                    menuResult = await promptLoginMode(existingAccounts)

                    if (menuResult.mode === "check") {
                      console.log("\nChecking quotas for all accounts...")
                      const results = await checkAccountsQuota(existingStorage.accounts, client, providerId)
                      for (const res of results) {
                        const label = res.email || `Account ${res.index + 1}`
                        const disabledStr = res.disabled ? " (disabled)" : ""
                        console.log(`\n${res.index + 1}. ${label}${disabledStr}`)
                        if (res.status === "error") {
                          console.log(`   Error: ${res.error}`)
                          continue
                        }
                        if (!res.quota || Object.keys(res.quota.groups).length === 0) {
                          console.log("   No quota information available.")
                          if (res.quota?.error) console.log(`   Error: ${res.quota.error}`)
                          continue
                        }
                        const printGrp = (name: string, group: any) => {
                          if (!group) return
                          const remaining =
                            typeof group.remainingFraction === "number"
                              ? `${Math.round(group.remainingFraction * 100)}%`
                              : "UNKNOWN"
                          const resetStr = group.resetTime
                            ? `, resets in ${formatWaitTime(Date.parse(group.resetTime) - Date.now())}`
                            : ""
                          console.log(`   ${name}: ${remaining}${resetStr}`)
                        }
                        printGrp("Claude", res.quota.groups.claude)
                        printGrp("Gemini 3 Pro", res.quota.groups["gemini-pro"])
                        printGrp("Gemini 3 Flash", res.quota.groups["gemini-flash"])
                        if (res.updatedAccount) {
                          existingStorage.accounts[res.index] = res.updatedAccount
                          await saveAccounts(existingStorage)
                        }
                      }
                      console.log("")
                      continue
                    }

                    if (menuResult.mode === "manage") {
                      if (menuResult.toggleAccountIndex !== undefined) {
                        const acc = existingStorage.accounts[menuResult.toggleAccountIndex]
                        if (acc) {
                          acc.enabled = acc.enabled === false
                          await saveAccounts(existingStorage)
                          console.log(
                            `\nAccount ${acc.email || menuResult.toggleAccountIndex + 1} ${acc.enabled ? "enabled" : "disabled"}.\n`,
                          )
                        }
                      }
                      continue
                    }

                    break
                  }

                  if (menuResult.mode === "cancel") {
                    return {
                      url: "",
                      instructions: "Authentication cancelled",
                      method: "auto",
                      callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
                    }
                  }

                  if (menuResult.deleteAccountIndex !== undefined) {
                    const updatedAccounts = existingStorage.accounts.filter(
                      (_, idx) => idx !== menuResult.deleteAccountIndex,
                    )
                    await saveAccounts({
                      version: 3,
                      accounts: updatedAccounts,
                      activeIndex: 0,
                      activeIndexByFamily: { claude: 0, gemini: 0 },
                    })
                    console.log("\nAccount deleted.\n")

                    if (updatedAccounts.length > 0) {
                      return {
                        url: "",
                        instructions: "Account deleted. Please run `opencode auth login` again to continue.",
                        method: "auto",
                        callback: async () => ({ type: "failed", error: "Account deleted - please re-run auth" }),
                      }
                    }
                  }

                  if (menuResult.refreshAccountIndex !== undefined) {
                    refreshAccountIndex = menuResult.refreshAccountIndex
                    const refreshEmail = existingStorage.accounts[refreshAccountIndex]?.email
                    console.log(`\nRe-authenticating ${refreshEmail || "account"}...\n`)
                    startFresh = false
                  }

                  if (menuResult.deleteAll) {
                    await clearAccounts()
                    console.log("\nAll accounts deleted.\n")
                    startFresh = true
                  } else {
                    startFresh = menuResult.mode === "fresh"
                  }

                  if (startFresh && !menuResult.deleteAll) {
                    console.log("\nStarting fresh - existing accounts will be replaced.\n")
                  } else if (!startFresh) {
                    console.log("\nAdding to existing accounts.\n")
                  }
                }

                while (accounts.length < MAX_OAUTH_ACCOUNTS) {
                  console.log(`\n=== Antigravity OAuth (Account ${accounts.length + 1}) ===`)

                  const projectId = await promptProjectId()

                  const result = await (async (): Promise<AntigravityTokenExchangeResult> => {
                    const authorization = await authorizeAntigravity(projectId)
                    const fallbackState = getStateFromAuthorizationUrl(authorization.url)

                    console.log("\nOAuth URL:\n" + authorization.url + "\n")

                    if (useManualMode) {
                      const browserOpened = await openBrowser(authorization.url)
                      if (!browserOpened) {
                        console.log("Could not open browser automatically.")
                        console.log("Please open the URL above manually in your local browser.\n")
                      }
                      return promptManualOAuthInput(fallbackState)
                    }

                    let listener: OAuthListener | null = null
                    if (!isHeadless) {
                      try {
                        listener = await startOAuthListener()
                      } catch {
                        // Failed to start listener, will fallback to manual
                        listener = null
                      }
                    }

                    if (!isHeadless) {
                      await openBrowser(authorization.url)
                    }

                    if (listener) {
                      try {
                        const SOFT_TIMEOUT_MS = 30000
                        const callbackPromise = listener.waitForCallback()
                        const timeoutPromise = new Promise<never>((_, reject) =>
                          setTimeout(() => reject(new Error("SOFT_TIMEOUT")), SOFT_TIMEOUT_MS),
                        )

                        let callbackUrl: URL
                        try {
                          callbackUrl = await Promise.race([callbackPromise, timeoutPromise])
                        } catch (err) {
                          if (err instanceof Error && err.message === "SOFT_TIMEOUT") {
                            console.log("\n⏳ Automatic callback not received after 30 seconds.")
                            console.log("You can paste the redirect URL manually.\n")
                            console.log("OAuth URL (in case you need it again):")
                            console.log(authorization.url + "\n")

                            try {
                              await listener.close()
                            } catch {
                              // Ignore close error
                            }

                            return promptManualOAuthInput(fallbackState)
                          }
                          throw err
                        }

                        const params = extractOAuthCallbackParams(callbackUrl)
                        if (!params) {
                          return { type: "failed", error: "Missing code or state in callback URL" }
                        }

                        return exchangeAntigravity(params.code, params.state)
                      } catch (error) {
                        if (error instanceof Error && error.message !== "SOFT_TIMEOUT") {
                          return {
                            type: "failed",
                            error: error.message,
                          }
                        }
                        return {
                          type: "failed",
                          error: error instanceof Error ? error.message : "Unknown error",
                        }
                      } finally {
                        try {
                          await listener.close()
                        } catch {
                          // Ignore close error
                        }
                      }
                    }

                    return promptManualOAuthInput(fallbackState)
                  })()

                  if (result.type === "failed") {
                    if (accounts.length === 0) {
                      return {
                        url: "",
                        instructions: `Authentication failed: ${result.error}`,
                        method: "auto",
                        callback: async () => result,
                      }
                    }

                    console.warn(
                      `[opencode-antigravity-auth] Skipping failed account ${accounts.length + 1}: ${result.error}`,
                    )
                    break
                  }

                  accounts.push(result)

                  try {
                    await client.tui.showToast({
                      body: {
                        message: `Account ${accounts.length} authenticated${result.email ? ` (${result.email})` : ""}`,
                        variant: "success",
                      },
                    })
                  } catch {
                    // TUI toast optional
                  }

                  try {
                    if (refreshAccountIndex !== undefined) {
                      const currentStorage = await loadAccounts()
                      if (currentStorage) {
                        const updatedAccounts = [...currentStorage.accounts]
                        const parts = parseRefreshParts(result.refresh)
                        if (parts.refreshToken) {
                          updatedAccounts[refreshAccountIndex] = {
                            email: result.email ?? updatedAccounts[refreshAccountIndex]?.email,
                            refreshToken: parts.refreshToken,
                            projectId: parts.projectId ?? updatedAccounts[refreshAccountIndex]?.projectId,
                            managedProjectId:
                              parts.managedProjectId ?? updatedAccounts[refreshAccountIndex]?.managedProjectId,
                            addedAt: updatedAccounts[refreshAccountIndex]?.addedAt ?? Date.now(),
                            lastUsed: Date.now(),
                          }
                          await saveAccounts({
                            version: 3,
                            accounts: updatedAccounts,
                            activeIndex: currentStorage.activeIndex,
                            activeIndexByFamily: currentStorage.activeIndexByFamily,
                          })
                        }
                      }
                    } else {
                      const isFirstAccount = accounts.length === 1
                      await persistAccountPool([result], isFirstAccount && startFresh)
                    }
                  } catch (e) {
                    console.error("[persistAccountPool] Failed to persist account:", e)
                  }

                  if (refreshAccountIndex !== undefined) {
                    break
                  }

                  if (accounts.length >= MAX_OAUTH_ACCOUNTS) {
                    break
                  }

                  // Get the actual deduplicated account count from storage for the prompt
                  let currentAccountCount = accounts.length
                  try {
                    const currentStorage = await loadAccounts()
                    if (currentStorage) {
                      currentAccountCount = currentStorage.accounts.length
                    }
                  } catch {
                    // Fall back to accounts.length if we can't read storage
                  }

                  const addAnother = await promptAddAnotherAccount(currentAccountCount)
                  if (!addAnother) {
                    break
                  }
                }

                const primary = accounts[0]
                if (!primary) {
                  return {
                    url: "",
                    instructions: "Authentication cancelled",
                    method: "auto",
                    callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
                  }
                }

                let actualAccountCount = accounts.length
                try {
                  const finalStorage = await loadAccounts()
                  if (finalStorage) {
                    actualAccountCount = finalStorage.accounts.length
                  }
                } catch {
                  // Fall back to accounts.length if we can't read storage
                }

                const successMessage =
                  refreshAccountIndex !== undefined
                    ? `Token refreshed successfully.`
                    : `Multi-account setup complete (${actualAccountCount} account(s)).`

                return {
                  url: "",
                  instructions: successMessage,
                  method: "auto",
                  callback: async (): Promise<AntigravityTokenExchangeResult> => primary,
                }
              }

              // TUI flow (`/connect`) does not support per-account prompts.
              // Default to adding new accounts (non-destructive).
              // Users can run `opencode auth logout` first if they want a fresh start.
              const projectId = ""

              // Check existing accounts count for toast message
              const existingStorage = await loadAccounts()
              const existingCount = existingStorage?.accounts.length ?? 0

              const useManualFlow = isHeadless || shouldSkipLocalServer()

              let listener: OAuthListener | null = null
              if (!useManualFlow) {
                try {
                  listener = await startOAuthListener()
                } catch {
                  // Failed to start listener, will fallback to manual
                  listener = null
                }
              }

              const authorization = await authorizeAntigravity(projectId)
              const fallbackState = getStateFromAuthorizationUrl(authorization.url)

              if (!useManualFlow) {
                const browserOpened = await openBrowser(authorization.url)
                if (!browserOpened) {
                  listener?.close().catch(() => {
                    // Ignore close error
                  })
                  listener = null
                }
              }

              if (listener) {
                return {
                  url: authorization.url,
                  instructions:
                    "Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
                  method: "auto",
                  callback: async (): Promise<AntigravityTokenExchangeResult> => {
                    const CALLBACK_TIMEOUT_MS = 30000
                    try {
                      const callbackPromise = listener.waitForCallback()
                      const timeoutPromise = new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error("CALLBACK_TIMEOUT")), CALLBACK_TIMEOUT_MS),
                      )

                      let callbackUrl: URL
                      try {
                        callbackUrl = await Promise.race([callbackPromise, timeoutPromise])
                      } catch (err) {
                        if (err instanceof Error && err.message === "CALLBACK_TIMEOUT") {
                          return {
                            type: "failed",
                            error: "Callback timeout - please use CLI with --no-browser flag for manual input",
                          }
                        }
                        throw err
                      }

                      const params = extractOAuthCallbackParams(callbackUrl)
                      if (!params) {
                        return { type: "failed", error: "Missing code or state in callback URL" }
                      }

                      const result = await exchangeAntigravity(params.code, params.state)
                      if (result.type === "success") {
                        try {
                          await persistAccountPool([result], false)
                        } catch (e) {
                          console.error("[persistAccountPool] Failed to persist account (CLI callback):", e)
                        }

                        const newTotal = existingCount + 1
                        const toastMessage =
                          existingCount > 0
                            ? `Added account${result.email ? ` (${result.email})` : ""} - ${newTotal} total`
                            : `Authenticated${result.email ? ` (${result.email})` : ""}`

                        try {
                          await client.tui.showToast({
                            body: {
                              message: toastMessage,
                              variant: "success",
                            },
                          })
                        } catch {
                          // TUI toast optional
                        }
                      }

                      return result
                    } catch (error) {
                      return {
                        type: "failed",
                        error: error instanceof Error ? error.message : "Unknown error",
                      }
                    } finally {
                      try {
                        await listener.close()
                      } catch {
                        // Ignore close error
                      }
                    }
                  },
                }
              }

              return {
                url: authorization.url,
                instructions:
                  "Visit the URL above, complete OAuth, then paste either the full redirect URL or the authorization code.",
                method: "code",
                callback: async (codeInput: string): Promise<AntigravityTokenExchangeResult> => {
                  const params = parseOAuthCallbackInput(codeInput, fallbackState)
                  if ("error" in params) {
                    return { type: "failed", error: params.error }
                  }

                  const result = await exchangeAntigravity(params.code, params.state)
                  if (result.type === "success") {
                    try {
                      // TUI flow adds to existing accounts (non-destructive)
                      await persistAccountPool([result], false)
                    } catch (e) {
                      console.error("[persistAccountPool] Failed to persist account (TUI callback):", e)
                    }

                    // Show appropriate toast message
                    const newTotal = existingCount + 1
                    const toastMessage =
                      existingCount > 0
                        ? `Added account${result.email ? ` (${result.email})` : ""} - ${newTotal} total`
                        : `Authenticated${result.email ? ` (${result.email})` : ""}`

                    try {
                      await client.tui.showToast({
                        body: {
                          message: toastMessage,
                          variant: "success",
                        },
                      })
                    } catch {
                      // TUI may not be available
                    }
                  }

                  return result
                },
              }
            },
          },
          {
            label: "Manually enter API Key",
            type: "api",
          },
        ],
      },
    }
  }

export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)
export const AntigravityLegacyOAuthPlugin = createAntigravityPlugin("antigravity")
export const GoogleOAuthPlugin = AntigravityCLIOAuthPlugin
export const AntigravityOAuthPlugin = AntigravityCLIOAuthPlugin

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value
  }
  const candidate = (value as Request).url
  if (candidate) {
    return candidate
  }
  return value.toString()
}

function toWarmupStreamUrl(value: RequestInfo): string {
  const urlString = toUrlString(value)
  try {
    const url = new URL(urlString)
    if (!url.pathname.includes(":streamGenerateContent")) {
      url.pathname = url.pathname.replace(":generateContent", ":streamGenerateContent")
    }
    url.searchParams.set("alt", "sse")
    return url.toString()
  } catch {
    // Invalid URL, return original
    return urlString
  }
}

function extractModelFromUrl(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/?]+)(?::\w+)?/)
  return match?.[1] ?? null
}

function extractModelFromUrlWithSuffix(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/\?]+)/)
  return match?.[1] ?? null
}

function getModelFamilyFromUrl(urlString: string): ModelFamily {
  const model = extractModelFromUrl(urlString)
  let family: ModelFamily = "gemini"
  if (model && model.includes("claude")) {
    family = "claude"
  }
  if (isDebugEnabled()) {
    logModelFamily(urlString, model, family)
  }
  return family
}

function getHeaderStyleFromUrl(urlString: string, family: ModelFamily, providerId: string): HeaderStyle {
  if (providerId === "antigravity") {
    return "antigravity"
  }
  return "gemini-cli"
}

// @event_2026-02-06:antigravity_v145_integration
// Helper to get cli_first preference from config
function getCliFirst(config: AntigravityConfig): boolean {
  return (config as AntigravityConfig & { cli_first?: boolean }).cli_first ?? false
}

// @event_2026-02-06:antigravity_v145_integration
// Resolve the preferred header style for Gemini models considering cli_first
function resolvePreferredHeaderStyle(
  baseHeaderStyle: HeaderStyle,
  family: ModelFamily,
  explicitQuota: boolean,
  cliFirst: boolean,
): HeaderStyle {
  // Only apply cli_first preference for Gemini models without explicit quota
  if (family !== "gemini" || explicitQuota) {
    return baseHeaderStyle
  }
  // If cli_first is enabled, prefer gemini-cli; otherwise keep the base style
  if (cliFirst) {
    return "gemini-cli"
  }
  return baseHeaderStyle
}

function isExplicitQuotaFromUrl(urlString: string): boolean {
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString)
  if (!modelWithSuffix) {
    return false
  }
  const { explicitQuota } = resolveModelWithTier(modelWithSuffix)
  return explicitQuota ?? false
}
