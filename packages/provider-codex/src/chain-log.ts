/**
 * WS chain-reset forensic log for the codex provider (cache-chain-hotfix W1).
 *
 * Why: the [CODEX-WS] REQ/CHAIN/USAGE breadcrumbs go only to daemon stderr,
 * which nothing captures — so a chain reset's CAUSE cannot be counted after the
 * fact, and "chainless resend" vs "length_not_grown" are indistinguishable in
 * cache_read alone (both collapse to the prefix floor). This sink lands one
 * JSONL line per WS request (and per usage frame) so a single session can be
 * split into length_not_grown / chainless / server_evict / none counts — the
 * KPI that proves whether the commit-on-completion fix removed the self-inflicted
 * resets (DD-1, evidence-gated).
 *
 * Provider-boundary discipline (INV-16, matches empty-turn-log.ts): this package
 * does NOT import from packages/opencode. The file path is INJECTED by the
 * runtime caller via setChainLogPath(), mirroring setEmptyTurnLogPath().
 *
 * data-schema.json: WsResetEvent contract.
 */

import { appendFileSync, mkdirSync } from "fs"
import { dirname } from "path"

// ---------------------------------------------------------------------------
// § 1  Injected path (runtime caller wires this up)
// ---------------------------------------------------------------------------

let _filePath: string | null = null

/**
 * Inject the JSONL log file path. Caller (opencode runtime) computes
 * `<Global.Path.state>/codex/ws-chain.jsonl` and passes it in. Idempotent.
 * If never called, entries are silently dropped — the binary still runs,
 * evidence is just lost (never blocks the hot path).
 */
export function setChainLogPath(filePath: string): void {
  _filePath = filePath
}

// ---------------------------------------------------------------------------
// § 2  resetClass classifier (pure, testable)
// ---------------------------------------------------------------------------

export type ResetClass = "length_not_grown" | "chainless" | "server_evict" | "none"

/**
 * Classify a WS request's chain outcome from the signals available.
 *
 *   - chainResetReason set (length_not_grown)        → "length_not_grown"  (our self-inflicted reset; the fix's KPI)
 *   - no previous_response_id sent                   → "chainless"         (doInvalidate path already cleared the chain)
 *   - prev_resp sent AND server returned 0 cached    → "server_evict"      (server dropped the chain under load)
 *   - prev_resp sent AND server cached > 0           → "none"              (healthy delta hit)
 *
 * cachedTokens is only known at the USAGE/completion frame; at REQ time it is
 * undefined, so a request that sent a chain pointer classifies as "none"
 * provisionally and is refined to server_evict/none once usage arrives.
 */
export function classifyReset(input: {
  hasPrevResp: boolean
  chainResetReason: string | null | undefined
  cachedTokens?: number | undefined
}): ResetClass {
  if (input.chainResetReason) return "length_not_grown"
  if (!input.hasPrevResp) return "chainless"
  if (input.cachedTokens === 0) return "server_evict"
  return "none"
}

// ---------------------------------------------------------------------------
// § 3  Append (load-bearing JSONL; never throws)
// ---------------------------------------------------------------------------

let _seq = 0

/** Allocate a monotonic per-process sequence for offline req↔usage join. */
export function nextChainSeq(): number {
  return _seq++
}

/**
 * Append one JSONL line. NEVER throws (INV-05 parity with empty-turn-log):
 * a write failure emits a single console.error breadcrumb and returns.
 */
export function appendChainEvent(payload: object): void {
  if (!_filePath) return
  try {
    mkdirSync(dirname(_filePath), { recursive: true })
    appendFileSync(_filePath, JSON.stringify(payload) + "\n", "utf-8")
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[CODEX-WS] chain-log emission failed: ${reason}`)
  }
}

// ---------------------------------------------------------------------------
// § 4  Test-only helpers
// ---------------------------------------------------------------------------

export function _resetChainLogForTest(): void {
  _filePath = null
  _seq = 0
}

export function _getChainLogPathForTest(): string | null {
  return _filePath
}
