/**
 * ModelUpdateSignal — per-session Promise registry for cross-process model updates.
 *
 * Used by the worker process: when a child session hits a rate limit, the
 * processor awaits `ModelUpdateSignal.wait(sessionID)` while the parent
 * decides the new model and pushes it via stdin `model_update` command.
 */

export type ModelUpdatePayload = {
  providerId: string
  modelID: string
  accountId?: string
}

const pending = new Map<
  string,
  {
    resolve: (model: ModelUpdatePayload) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

const DEFAULT_MODEL_UPDATE_TIMEOUT_MS = 30_000

/**
 * Wait for the parent process to push a model update for this session.
 * Rejects after `timeoutMs` (default 30 s) — the caller should fail fast.
 *
 * responsive-orchestrator R3: caller passes
 * `Tweaks.subagent().escalationWaitMs` so the timeout is user-tunable
 * via /etc/opencode/tweaks.cfg without recompiling.
 */
export function wait(sessionID: string, timeoutMs: number = DEFAULT_MODEL_UPDATE_TIMEOUT_MS): Promise<ModelUpdatePayload> {
  // If there is already a pending wait for this session, reject the old one
  // so we don't leak promises.
  const existing = pending.get(sessionID)
  if (existing) {
    // [rot-rca] Phase A instrument — detect RW-1 (new wait cancels old)
    process.stderr.write(
      `[rot-rca] signal wait-overwrite session=${sessionID} RW-1 prior-pending-dropped\n`,
    )
    clearTimeout(existing.timer)
    pending.delete(sessionID)
  }

  // [rot-rca] log every wait() invocation for chain timing
  const __rotRcaWaitRegisterTs = Date.now()
  process.stderr.write(
    `[rot-rca] signal wait-register session=${sessionID} ts=${__rotRcaWaitRegisterTs}\n`,
  )

  return new Promise<ModelUpdatePayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(sessionID)
      process.stderr.write(
        `[rot-rca] signal wait-timeout session=${sessionID} elapsedMs=${Date.now() - __rotRcaWaitRegisterTs}\n`,
      )
      reject(new Error(`ModelUpdateSignal timeout (${timeoutMs}ms) for session ${sessionID}`))
    }, timeoutMs)
    // Don't hold the process alive just for this timer.
    if (typeof timer.unref === "function") timer.unref()

    pending.set(sessionID, { resolve, timer })
  })
}

/**
 * Resolve a pending model-update wait. Called from the worker stdin handler
 * when it receives a `model_update` command from the parent.
 */
export function resolve(sessionID: string, model: ModelUpdatePayload): boolean {
  const entry = pending.get(sessionID)
  if (!entry) {
    // [rot-rca] Phase A instrument — track dropped model_update (no pending wait)
    process.stderr.write(
      `[rot-rca] signal resolve-miss session=${sessionID} RW-1 no-pending-wait\n`,
    )
    return false
  }
  clearTimeout(entry.timer)
  pending.delete(sessionID)
  entry.resolve(model)
  return true
}

/**
 * Check whether a session is currently waiting for a model update.
 */
export function isPending(sessionID: string): boolean {
  return pending.has(sessionID)
}
