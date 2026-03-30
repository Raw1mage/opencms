/**
 * SameProviderRotationGuard — prevents repeated same-provider rotates in a short window.
 */

import { Log } from "../../util/log"
import { readUnifiedState, writeUnifiedState } from "./state"

const log = Log.create({ service: "same-provider-rotation-guard" })

export const SAME_PROVIDER_ROTATE_COOLDOWN_MS = 5 * 60 * 1000

export class SameProviderRotationGuard {
  private makeKey(providerId: string, accountId: string) {
    return `${providerId}:${accountId}`
  }

  private clearExpired(state = readUnifiedState()): ReturnType<typeof readUnifiedState> {
    const now = Date.now()
    let changed = false
    for (const [key, entry] of Object.entries(state.sameProviderRotationCooldowns ?? {})) {
      if (!entry || now >= entry.until) {
        delete state.sameProviderRotationCooldowns[key]
        changed = true
      }
    }
    if (changed) writeUnifiedState(state)
    return state
  }

  mark(
    providerId: string,
    fromAccountId: string,
    toAccountId: string,
    modelID: string,
    cooldownMs = SAME_PROVIDER_ROTATE_COOLDOWN_MS,
  ): void {
    const state = this.clearExpired(readUnifiedState())
    const now = Date.now()
    state.sameProviderRotationCooldowns[this.makeKey(providerId, fromAccountId)] = {
      until: now + cooldownMs,
      rotatedAt: now,
      fromAccountId,
      toAccountId,
      modelID,
    }
    writeUnifiedState(state)
    log.info("Armed same-provider rotation cooldown", {
      providerId,
      fromAccountId,
      toAccountId,
      modelID,
      cooldownMs,
      until: new Date(now + cooldownMs).toISOString(),
    })
  }

  getWaitTime(providerId: string, accountId: string): number {
    const state = this.clearExpired(readUnifiedState())
    const entry = state.sameProviderRotationCooldowns?.[this.makeKey(providerId, accountId)]
    if (!entry) return 0
    return Math.max(0, entry.until - Date.now())
  }

  /**
   * Check if ANY account in this provider has an active rotation cooldown.
   * Prevents cascade: A→B→C→D in seconds when all rotations fail (e.g. stale token).
   */
  getProviderWaitTime(providerId: string): number {
    const state = this.clearExpired(readUnifiedState())
    const prefix = `${providerId}:`
    const now = Date.now()
    let maxWait = 0
    for (const [key, entry] of Object.entries(state.sameProviderRotationCooldowns ?? {})) {
      if (!key.startsWith(prefix) || !entry) continue
      const wait = entry.until - now
      if (wait > maxWait) maxWait = wait
    }
    return Math.max(0, maxWait)
  }

  isCoolingDown(providerId: string, accountId: string): boolean {
    return this.getWaitTime(providerId, accountId) > 0
  }

  getSnapshot(): Record<
    string,
    { until: number; rotatedAt: number; fromAccountId: string; toAccountId: string; modelID: string; waitMs: number }
  > {
    const state = this.clearExpired(readUnifiedState())
    const now = Date.now()
    const result: Record<
      string,
      { until: number; rotatedAt: number; fromAccountId: string; toAccountId: string; modelID: string; waitMs: number }
    > = {}
    for (const [key, entry] of Object.entries(state.sameProviderRotationCooldowns ?? {})) {
      result[key] = {
        ...entry,
        waitMs: Math.max(0, entry.until - now),
      }
    }
    return result
  }

  clear(providerId: string, accountId: string): void {
    const state = readUnifiedState()
    const key = this.makeKey(providerId, accountId)
    if (!state.sameProviderRotationCooldowns?.[key]) return
    delete state.sameProviderRotationCooldowns[key]
    writeUnifiedState(state)
  }

  clearAll(): void {
    const state = readUnifiedState()
    state.sameProviderRotationCooldowns = {}
    writeUnifiedState(state)
  }
}
