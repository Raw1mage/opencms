/**
 * SameProviderRotationGuard — prevents repeated same-provider rotates in a short window.
 */

import { Log } from "../../util/log"
import { readUnifiedState, writeUnifiedState } from "./state"

const log = Log.create({ service: "same-provider-rotation-guard" })

export const SAME_PROVIDER_ROTATE_COOLDOWN_MS = 5 * 60 * 1000

export class SameProviderRotationGuard {
  private clearExpired(state = readUnifiedState()): ReturnType<typeof readUnifiedState> {
    const now = Date.now()
    let changed = false
    for (const [providerId, entry] of Object.entries(state.sameProviderRotationCooldowns ?? {})) {
      if (!entry || now >= entry.until) {
        delete state.sameProviderRotationCooldowns[providerId]
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
    state.sameProviderRotationCooldowns[providerId] = {
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

  getWaitTime(providerId: string): number {
    const state = this.clearExpired(readUnifiedState())
    const entry = state.sameProviderRotationCooldowns?.[providerId]
    if (!entry) return 0
    return Math.max(0, entry.until - Date.now())
  }

  isCoolingDown(providerId: string): boolean {
    return this.getWaitTime(providerId) > 0
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
    for (const [providerId, entry] of Object.entries(state.sameProviderRotationCooldowns ?? {})) {
      result[providerId] = {
        ...entry,
        waitMs: Math.max(0, entry.until - now),
      }
    }
    return result
  }

  clear(providerId: string): void {
    const state = readUnifiedState()
    if (!state.sameProviderRotationCooldowns?.[providerId]) return
    delete state.sameProviderRotationCooldowns[providerId]
    writeUnifiedState(state)
  }

  clearAll(): void {
    const state = readUnifiedState()
    state.sameProviderRotationCooldowns = {}
    writeUnifiedState(state)
  }
}
