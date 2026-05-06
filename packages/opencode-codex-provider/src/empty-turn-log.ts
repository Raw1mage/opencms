/**
 * Empty-turn forensic log emitter for the codex provider.
 *
 * Decision D-2 (proposal.md): logs are the LOAD-BEARING evidence path for
 * codex empty-turn classification; recovery actions are subordinate.
 * INV-04: every classified empty turn produces a log-attempt before
 * recovery is dispatched. INV-05: log-failure NEVER blocks recovery.
 * INV-06: JSONL is load-bearing; bus is convenience.
 *
 * Provider-boundary discipline (INV-16, feedback_provider_boundary.md):
 * the codex-provider package does NOT import from packages/opencode.
 * Filesystem path and Bus publisher are INJECTED by the runtime caller
 * via setEmptyTurnLogPath() and setEmptyTurnLogBus(), matching the
 * pattern established by continuation.ts:setContinuationFilePath().
 *
 * spec.md Requirement: "Forensic evidence preservation"
 * data-schema.json: log entry contract (schemaVersion: 1)
 * errors.md: CET-001 (jsonl write failure), CET-002 (bus publish failure)
 */

import { appendFileSync, mkdirSync } from "fs"
import { dirname } from "path"

// ---------------------------------------------------------------------------
// § 1  Injected dependencies (runtime caller wires these up)
// ---------------------------------------------------------------------------

let _filePath: string | null = null
let _busPublish: ((channel: string, payload: unknown) => unknown) | null = null

/**
 * Inject the JSONL log file path. Caller (opencode runtime) computes
 * `<Global.Path.state>/codex/empty-turns.jsonl` and passes it in.
 *
 * Idempotent. Safe to call multiple times (e.g., on config reload).
 * If never called, log entries are silently dropped — the binary still
 * runs (INV-05), but evidence is lost. Callers are expected to set this
 * during provider initialization.
 */
export function setEmptyTurnLogPath(filePath: string): void {
  _filePath = filePath
}

/**
 * Inject the Bus publish function. Optional — bus is non-load-bearing
 * per DD-2 / INV-06; absence here means no bus mirroring, which is
 * acceptable. JSONL append is independent and remains the load-bearing
 * path regardless.
 *
 * The publisher may return synchronously or as a Promise; we never
 * await — fire-and-forget. Errors thrown by the publisher are swallowed
 * (CET-002 is severity Low — by design).
 */
export function setEmptyTurnLogBus(
  publish: (channel: string, payload: unknown) => unknown,
): void {
  _busPublish = publish
}

// ---------------------------------------------------------------------------
// § 2  Monotonic logSequence (DD-11 / INV-07)
// ---------------------------------------------------------------------------

let _seq = 0

/**
 * Allocate the next monotonic logSequence value. Process-scoped counter
 * starting at 0, increments per call. Used by data-schema.json field
 * `logSequence` to enable join across retry pairs (previousLogSequence)
 * and forensic correlation with providerMetadata.openai.emptyTurnClassification.logSequence.
 *
 * Exposed separately so the classifier can mint the sequence number
 * BEFORE constructing the payload (the sequence is part of both the
 * log entry and the providerMetadata attached to the finish part —
 * they must match).
 */
export function nextLogSequence(): number {
  return _seq++
}

// ---------------------------------------------------------------------------
// § 3  Append + publish
// ---------------------------------------------------------------------------

/**
 * Append one JSONL line to the configured log file AND publish to bus.
 *
 * Behavior contract (spec.md "Forensic evidence preservation"):
 * - INV-04: this function is the single entry point for empty-turn log emission.
 *   Caller MUST invoke it for every classified empty turn.
 * - INV-05: this function NEVER throws. File write errors emit a single
 *   console.error breadcrumb (CET-001) and return normally. Bus publish
 *   errors are swallowed silently (CET-002).
 * - INV-06: file append is the load-bearing path; bus publish is
 *   convenience. Bus failure does NOT abort file append, and vice versa.
 * - INV-07: caller is responsible for producing a payload that validates
 *   against data-schema.json. This function does not validate at runtime
 *   (validation is a unit-test concern; runtime validation would itself
 *   risk throwing).
 *
 * The two side-effect paths run independently in this order:
 *   1. JSONL append (load-bearing)
 *   2. Bus publish (convenience)
 * Failure of either does not affect the other.
 */
export function appendEmptyTurnLog(payload: object): void {
  // Path 1: JSONL append (load-bearing per INV-06)
  if (_filePath) {
    try {
      mkdirSync(dirname(_filePath), { recursive: true })
      appendFileSync(_filePath, JSON.stringify(payload) + "\n", "utf-8")
    } catch (err) {
      // CET-001 — log emission failed. Severity Medium: degrades evidence
      // but does NOT block. INV-05 forbids re-throwing.
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[CODEX-EMPTY-TURN] log emission failed: ${reason}`)
    }
  }
  // If _filePath is null, the caller never wired the path. We could log
  // this as a configuration error, but doing so on every empty turn
  // would itself become a noise source. Silently dropping is acceptable
  // here; configuration health is a deployment concern, not a runtime one.

  // Path 2: Bus publish (non-load-bearing per INV-06)
  if (_busPublish) {
    try {
      const result = _busPublish("codex.emptyTurn", payload)
      // If the publisher returns a Promise, attach a silent rejection
      // handler so unhandled-promise-rejection warnings don't surface
      // (CET-002 is by-design silent).
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        ;(result as Promise<unknown>).catch(() => {
          /* CET-002: bus publish failed; severity Low by design */
        })
      }
    } catch {
      /* CET-002: bus publish failed; severity Low by design */
    }
  }
}

// ---------------------------------------------------------------------------
// § 4  Test-only helpers (kept exported for unit tests; not part of public API)
// ---------------------------------------------------------------------------

/**
 * Reset all module-level state. Test-only — used by unit tests to
 * isolate test cases. Do NOT call from production code.
 */
export function _resetForTest(): void {
  _filePath = null
  _busPublish = null
  _seq = 0
}

/**
 * Read the currently-configured file path. Test-only / introspection.
 */
export function _getFilePathForTest(): string | null {
  return _filePath
}

/**
 * Read the current logSequence value without incrementing. Test-only.
 */
export function _peekLogSequenceForTest(): number {
  return _seq
}
