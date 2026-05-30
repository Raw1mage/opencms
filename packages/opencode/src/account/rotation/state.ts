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
