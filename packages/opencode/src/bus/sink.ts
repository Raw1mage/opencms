/**
 * Dependency-free debug event sink.
 *
 * SSOT contract:
 *   - Log / debug write here (Layer 1 → Layer 0).
 *   - Bus registers the real handler at startup (Layer 2 → Layer 0).
 *   - No circular dependency possible: this file imports NOTHING from the project.
 */

type DebugHandler = (scope: string, message: string, data?: Record<string, unknown>) => void

let handler: DebugHandler = () => {} // no-op until Bus registers

/** Emit a debug event. Before Bus registers, events are silently dropped. */
export function emitDebug(scope: string, message: string, data?: Record<string, unknown>) {
  handler(scope, message, data)
}

/** Called once by Bus at module init to wire the real dispatch. */
export function setDebugHandler(fn: DebugHandler) {
  handler = fn
}
