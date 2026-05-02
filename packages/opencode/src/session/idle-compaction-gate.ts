// Idle compaction precondition (DD-7 of specs/prompt-cache-and-compaction-hardening).
//
// Before idleCompaction allows an anchor write, scan the last N messages for
// any tool parts still in pending/running state. If found, defer — writing an
// anchor mid tool-use would split the persisted message stream in a way that
// the LLM provider may reject on the next request (Anthropic strict pairing
// requirement; the same concern that drives sanitizeOrphanedToolCalls in
// llm.ts).
//
// Pure function over MessageV2.WithParts[]. The compaction.ts caller decides
// what to do with the result.

import type { MessageV2 } from "./message-v2"

export interface CleanTailCheckResult {
  clean: boolean
  /** Required when clean=false. Lists callIDs of tool parts still in flight. */
  reason?: string
  scannedMessageCount: number
}

/**
 * Scan the trailing `windowSize` messages for tool parts whose state.status
 * is `pending` or `running`. If any are found, return clean:false with a
 * comma-joined list of callIDs in `reason`.
 *
 * Only assistant messages can carry tool parts; user/tool/system messages are
 * skipped quickly. Empty input is considered clean (nothing to corrupt).
 */
export function checkCleanTail(
  messages: ReadonlyArray<MessageV2.WithParts>,
  windowSize = 2,
): CleanTailCheckResult {
  const scanFrom = Math.max(0, messages.length - windowSize)
  const window = messages.slice(scanFrom)
  const inFlight: string[] = []
  for (const m of window) {
    if (m.info.role !== "assistant") continue
    for (const p of m.parts) {
      if (p.type !== "tool") continue
      const status = (p as MessageV2.ToolPart).state.status
      if (status === "pending" || status === "running") {
        inFlight.push((p as MessageV2.ToolPart).callID)
      }
    }
  }
  if (inFlight.length === 0) {
    return { clean: true, scannedMessageCount: window.length }
  }
  const reason =
    inFlight.length === 1
      ? `unmatched tool_use ${inFlight[0]}`
      : `multiple unmatched tool_use [${inFlight.join(", ")}]`
  return { clean: false, reason, scannedMessageCount: window.length }
}
