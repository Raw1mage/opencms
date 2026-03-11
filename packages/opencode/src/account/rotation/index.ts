/**
 * Unified Rotation Framework — barrel exports.
 *
 * @event_20260216_rotation_split
 * This file replaces the monolithic rotation.ts (1390 lines) with modular
 * re-exports from focused sub-modules. All existing imports from
 * "@/account/rotation" continue to work unchanged.
 *
 * Module Breakdown:
 * - types.ts              — shared types, interfaces, time utilities
 * - state.ts              — unified file persistence (read/write state)
 * - backoff.ts            — calculateBackoffMs, parseRateLimitReason, constants
 * - health-tracker.ts     — HealthScoreTracker class
 * - rate-limit-tracker.ts — RateLimitTracker class
 * - account-selector.ts   — selectBestAccount, sortByLruWithHealth
 * - error-classifier.ts   — isRateLimitError, isAuthError, extractRateLimitDetails
 * - model-health-registry.ts — REMOVED in Phase 4 (was deprecated dead code)
 */

// ============================================================================
// Types & Utilities
// ============================================================================

export type { RateLimitReason } from "./types"
export type {
  HealthScoreConfig,
  HealthScoreState,
  RateLimitState,
  SameProviderRotationCooldownState,
  UnifiedRotationState,
  AccountCandidate,
  ErrorWithMetadata,
} from "./types"
export { asErrorWithMetadata, getNextQuotaReset, getQuotaDayStart } from "./types"
export { DEFAULT_HEALTH_SCORE_CONFIG } from "./types"

// ============================================================================
// State Persistence
// ============================================================================

// readUnifiedState / writeUnifiedState are internal — not re-exported.
// Use the tracker classes instead.

// ============================================================================
// Backoff & Parsing
// ============================================================================

export { parseRateLimitReason, calculateBackoffMs } from "./backoff"

// ============================================================================
// Trackers
// ============================================================================

export { HealthScoreTracker } from "./health-tracker"
export { RateLimitTracker } from "./rate-limit-tracker"
export { SameProviderRotationGuard, SAME_PROVIDER_ROTATE_COOLDOWN_MS } from "./same-provider-rotation-guard"

// ============================================================================
// Account Selection
// ============================================================================

export { selectBestAccount, sortByLruWithHealth } from "./account-selector"

// ============================================================================
// Error Classification
// ============================================================================

export { isRateLimitError, isAuthError, extractRateLimitDetails } from "./error-classifier"

// ============================================================================
// Model Health Registry (DEPRECATED — Phase 4 removal)
// ============================================================================

// ModelHealthRegistry — REMOVED in Phase 4 (@event_20260216_rotation_split)
// Was dead code: nobody wrote to it, all consumers now use RateLimitTracker.getSnapshot3D()

// ============================================================================
// Global Singletons
// ============================================================================

import { HealthScoreTracker } from "./health-tracker"
import { RateLimitTracker } from "./rate-limit-tracker"
import { SameProviderRotationGuard } from "./same-provider-rotation-guard"
import type { HealthScoreConfig } from "./types"

let globalHealthTracker: HealthScoreTracker | null = null
let globalRateLimitTracker: RateLimitTracker | null = null
let globalSameProviderRotationGuard: SameProviderRotationGuard | null = null

/**
 * Get the global health score tracker instance.
 */
export function getHealthTracker(): HealthScoreTracker {
  if (!globalHealthTracker) {
    globalHealthTracker = new HealthScoreTracker()
  }
  return globalHealthTracker
}

/**
 * Get the global rate limit tracker instance.
 */
export function getRateLimitTracker(): RateLimitTracker {
  if (!globalRateLimitTracker) {
    globalRateLimitTracker = new RateLimitTracker()
  }
  return globalRateLimitTracker
}

/**
 * Get the global same-provider rotation guard instance.
 */
export function getSameProviderRotationGuard(): SameProviderRotationGuard {
  if (!globalSameProviderRotationGuard) {
    globalSameProviderRotationGuard = new SameProviderRotationGuard()
  }
  return globalSameProviderRotationGuard
}

/**
 * Initialize global trackers with custom config.
 */
export function initGlobalTrackers(healthConfig?: Partial<HealthScoreConfig>): void {
  globalHealthTracker = new HealthScoreTracker(healthConfig)
  globalRateLimitTracker = new RateLimitTracker()
  globalSameProviderRotationGuard = new SameProviderRotationGuard()
}
