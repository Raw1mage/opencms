/**
 * Unified state persistence for cross-process rotation tracking.
 *
 * @event_20260216_rotation_split — extracted from rotation.ts
 */

import { Log } from "../../util/log"
import fs from "fs"
import {
  UNIFIED_STATE_FILE,
  LEGACY_RATE_LIMITS_FILE,
  LEGACY_ACCOUNT_HEALTH_FILE,
  type UnifiedRotationState,
  type HealthScoreState,
  type RateLimitState,
} from "./types"

const log = Log.create({ service: "rotation-state" })

/**
 * Read the unified state file with backwards compatibility.
 * @event_2026-02-06:rotation_unify
 * If the unified file doesn't exist, migrate from legacy files (rate-limits.json, account-health.json).
 */
export function readUnifiedState(): UnifiedRotationState {
  try {
    // Try to read the unified state file first
    if (fs.existsSync(UNIFIED_STATE_FILE)) {
      const content = fs.readFileSync(UNIFIED_STATE_FILE, "utf-8")
      const data = JSON.parse(content) as UnifiedRotationState
      return {
        version: data.version ?? 1,
        accountHealth: data.accountHealth ?? {},
        rateLimits: data.rateLimits ?? {},
        dailyRateLimitCounts: data.dailyRateLimitCounts ?? {},
        sameProviderRotationCooldowns: data.sameProviderRotationCooldowns ?? {},
      }
    }

    // Backwards compatibility: migrate from legacy files
    const state: UnifiedRotationState = {
      version: 1,
      accountHealth: {},
      rateLimits: {},
      dailyRateLimitCounts: {},
      sameProviderRotationCooldowns: {},
    }

    // Read legacy rate-limits.json
    if (fs.existsSync(LEGACY_RATE_LIMITS_FILE)) {
      try {
        const content = fs.readFileSync(LEGACY_RATE_LIMITS_FILE, "utf-8")
        const legacyData = JSON.parse(content) as Record<string, Record<string, RateLimitState>>
        state.rateLimits = legacyData
        log.info("Migrated rate limits from legacy file", { entries: Object.keys(legacyData).length })
      } catch {
        // Ignore parse errors
      }
    }

    // Read legacy account-health.json
    if (fs.existsSync(LEGACY_ACCOUNT_HEALTH_FILE)) {
      try {
        const content = fs.readFileSync(LEGACY_ACCOUNT_HEALTH_FILE, "utf-8")
        const legacyData = JSON.parse(content) as Record<string, HealthScoreState>
        state.accountHealth = legacyData
        log.info("Migrated account health from legacy file", { entries: Object.keys(legacyData).length })
      } catch {
        // Ignore parse errors
      }
    }

    // Write the unified state file to complete migration
    if (Object.keys(state.rateLimits).length > 0 || Object.keys(state.accountHealth).length > 0) {
      writeUnifiedState(state)
      log.info("Created unified state file from legacy data")
    }

    return state
  } catch {
    return {
      version: 1,
      accountHealth: {},
      rateLimits: {},
      dailyRateLimitCounts: {},
      sameProviderRotationCooldowns: {},
    }
  }
}

/**
 * Remove rotation-state entries (health / rate-limit / daily-count) for a
 * SPECIFIC set of account ids — used right after those accounts are removed /
 * deduplicated, so they don't leave orphan entries behind. Scoped and precise:
 * only the given ids are touched, so it can never affect a live account.
 *
 * `sameProviderRotationCooldowns` is keyed by provider family (not account id)
 * and is left intact. dailyRateLimitCounts keys are `${provider}:${accountId}`
 * or `${provider}:${accountId}:${model}` — provider/accountId/model never contain
 * ':' so the accountId is unambiguously the second segment.
 *
 * @spec auth/credential-token-refresh-ineffective DD-6
 */
export function pruneAccountIds(accountIds: string[]): string[] {
  if (accountIds.length === 0) return []
  const target = new Set(accountIds)
  const state = readUnifiedState()
  const removed = new Set<string>()

  for (const id of Object.keys(state.accountHealth)) {
    if (target.has(id)) {
      delete state.accountHealth[id]
      removed.add(id)
    }
  }
  for (const id of Object.keys(state.rateLimits)) {
    if (target.has(id)) {
      delete state.rateLimits[id]
      removed.add(id)
    }
  }
  for (const key of Object.keys(state.dailyRateLimitCounts)) {
    const accountId = key.split(":")[1]
    if (accountId && target.has(accountId)) {
      delete state.dailyRateLimitCounts[key]
      removed.add(accountId)
    }
  }

  if (removed.size > 0) {
    writeUnifiedState(state)
    log.info("Pruned rotation-state for removed accounts", { count: removed.size, removed: [...removed] })
  }
  return [...removed]
}

/**
 * Full reconcile: prune ALL rotation-state entries whose account id is absent
 * from `validAccountIds` (the complete cross-provider set from accounts.json).
 * Broader blast radius than {@link pruneAccountIds} — NOT called automatically;
 * exposed for an explicit, user-initiated one-shot cleanup of accumulated
 * orphans. @spec auth/credential-token-refresh-ineffective DD-6
 */
export function pruneOrphanedAccounts(validAccountIds: Set<string>): string[] {
  const state = readUnifiedState()
  const removed = new Set<string>()
  const drop = (id: string | undefined) => !!id && !validAccountIds.has(id)

  for (const id of Object.keys(state.accountHealth)) if (drop(id)) (delete state.accountHealth[id], removed.add(id))
  for (const id of Object.keys(state.rateLimits)) if (drop(id)) (delete state.rateLimits[id], removed.add(id))
  for (const key of Object.keys(state.dailyRateLimitCounts)) {
    const accountId = key.split(":")[1]
    if (drop(accountId)) (delete state.dailyRateLimitCounts[key], removed.add(accountId!))
  }

  if (removed.size > 0) {
    writeUnifiedState(state)
    log.info("Pruned orphaned rotation-state entries (full reconcile)", { count: removed.size })
  }
  return [...removed]
}

/**
 * Write the unified state file.
 * @event_2026-02-06:rotation_unify
 */
export function writeUnifiedState(state: UnifiedRotationState): void {
  try {
    fs.writeFileSync(UNIFIED_STATE_FILE, JSON.stringify(state), "utf-8")
  } catch {
    // Ignore write errors
  }
}
