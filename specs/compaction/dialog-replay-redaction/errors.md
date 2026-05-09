# Errors: dialog-replay-redaction

Per AGENTS.md rule 1 + memory `feedback_no_silent_fallback.md`, every transformation step logs explicitly. The serializer is a pure function (cannot fail except on type-level errors); recompress dispatch handles failures by falling back to the prior anchor body (no in-place update). All errors degrade gracefully.

## Error Catalogue

### CRR-001 — recompress provider call failed (codex /responses/compact returned 4xx/5xx)

**Trigger**: codex backend returns HTTP error during `runCodexServerSideRecompress`. Common cases: 429 (rate limit), 500 (transient), 401 (token rotated mid-call).

**Severity**: Low — anchor body retains the redacted-dialog form (no in-place overwrite). Recompress will retry on the next compaction commit if anchor still > 50K.

**Surface**:
- `log.warn("recompress: codex /responses/compact failed; keeping redacted-dialog body", { sessionID, anchorMessageID, status, errorMessage })`
- Bus event `compaction.recompressed { result: "provider-error", errorMessage, providerId, kind: "low-cost-server" }`
- No anchor body mutation.

**Recovery**: caller does not throw. Runloop continues with the (oversized) redacted-dialog body. Next compaction commit re-evaluates ceiling and re-dispatches.

**Ops detection**: grep debug.log for `recompress: codex /responses/compact failed`. Sustained occurrence indicates upstream codex outage; not a defect in this spec.

### CRR-002 — recompress LLM call failed (Hybrid.runHybridLlm threw or returned empty)

**Trigger**: `runHybridLlmRecompress` invokes `Hybrid.runHybridLlm` which throws (network error, model error) or returns no usable output.

**Severity**: Low — same as CRR-001; no anchor mutation, retry on next commit.

**Surface**:
- `log.warn("recompress: hybrid_llm failed; keeping redacted-dialog body", { sessionID, anchorMessageID, error })`
- Bus event `compaction.recompressed { result: "exception" or "provider-error", errorMessage, kind: "hybrid_llm" }`

**Recovery**: skip. Anchor stays.

### CRR-003 — stale anchor detected at recompress in-place update step

**Trigger**: after async dispatch returns, the anchor message's id no longer matches the storage's current latest summary-true assistant message. An interloper compaction commit wrote a newer anchor.

**Severity**: Low — by design. Old anchor is no longer load-bearing; overwriting it would be a no-op at best and a corruption at worst.

**Surface**:
- `log.info("recompress: stale anchor detected; skipping in-place update", { sessionID, dispatchedAnchorID, currentAnchorID })`
- Bus event `compaction.recompressed { result: "stale-anchor-skipped" }`

**Recovery**: skip. The current anchor (written by the interloper) is in effect.

### CRR-004 — `excludeUserMessageID` does not match any user msg in tail

**Trigger**: caller passes a user msg id that's not in the tail (e.g. id from a different session, or already removed). Serializer must not crash.

**Severity**: Low — defensive.

**Surface**:
- `log.warn("serializeRedactedDialog: excludeUserMessageID not found in tail; serialising all messages", { excludeUserMessageID, tailLength })`
- Output: serialiser proceeds without exclusion; result includes all user msgs.

**Recovery**: skip. Caller should re-validate the id, but no halt needed.

### CRR-005 — `parsePrevLastRound` finds no `## Round N` markers

**Trigger**: prev anchor body has no markdown round headers. Could happen for: (a) anchor written by legacy `tryNarrative` (Memory.renderForLLMSync output); (b) anchor body recompressed by LLM that stripped headers; (c) cold-start (no prev anchor).

**Severity**: Low — fallback behaviour.

**Surface**:
- `log.info("parsePrevLastRound: no round markers in prev anchor body; starting from Round 1", { sessionID })`
- Output: `parsePrevLastRound` returns 0; serialiser uses `startRound=1`.

**Recovery**: continue. Round numbering may have a small discontinuity (e.g. legacy anchor → Round 1 reset). Cosmetic-only.

### CRR-006 — recall_id resolution fails at runtime

**Trigger**: model emits `recall_toolcall_raw({part_id: "prt_xxx"})` but `working-cache.deriveLedger` cannot find that part id (e.g. message storage corrupted, part since deleted).

**Severity**: Medium — model can't access historical tool output. Model's response quality degrades for that turn.

**Surface**:
- `log.error("recall_toolcall_raw: part id not found in ledger", { sessionID, partId })`
- MCP response: error message returned to model ("recall failed: part not in working cache").

**Recovery**: model receives error and may fall back to general reasoning. No system-level halt. If sustained, indicates storage corruption — escalate.

**Ops detection**: grep debug.log for `recall_toolcall_raw: part id not found`. Expected near-zero baseline. Sustained occurrence indicates storage layer issue.

### CRR-007 — Tweaks flag toggled mid-compaction into inconsistent state

**Trigger**: operator sets `enableDialogRedactionAnchor = false` while a compaction is committing. Pre-anchor read sees `true`, post-anchor recompress check sees `false`, or vice versa.

**Severity**: Low — by design. Each code path reads the flag once at entry; toggling can produce one transitional cycle with mixed behaviour.

**Surface**:
- No log entry by default (transitional state is acceptable).
- Optional `log.debug("flag-toggle observed mid-compaction", { sessionID, before, after })` if running with debug.

**Recovery**: next compaction commit honours the new flag fully.

### CRR-008 — anchor body grows during recompress dispatch (tail kept extending)

**Trigger**: anchor is dispatched for recompress at 52K; while async LLM runs, more compactions extend it to 65K. By the time recompress finishes, anchor is even bigger than when dispatched.

**Severity**: Low — recompress overwrites with LLM summary regardless. Slight inefficiency: the LLM didn't see the latest extended portion.

**Surface**:
- No special handling. Telemetry's `anchorTokensBefore` reflects dispatch-time size; future extends absorb the post-summary tail naturally.

**Recovery**: none required.

## Non-Errors (intentional skip outcomes)

These return without action and are NOT errors:

| Condition | Meaning |
|-----------|---------|
| anchor < 5K tokens | skip floor preserved; no recompress |
| anchor 5K-50K tokens, observed not in legacy gates | no recompress (matches legacy behaviour for non-large anchors) |
| `enableDialogRedactionAnchor === false` | all four patches fall back atomically; no error |
| empty tail messages | serialiser returns `{ text: "", lastRound: 0, messagesEmitted: 0 }`; tryNarrative returns `{ ok: false, reason: "memory empty" }` if also no prev body |

These all emit `log.info` with the skip reason — not error level.

## Watchpoints (sustained occurrence triggers human attention)

- **CRR-001 + CRR-002 combined > 5% of recompress dispatches sustained**: provider/LLM layer is unhealthy. Investigate but not a defect of this spec.
- **CRR-003 > 1% of dispatches sustained**: too many concurrent compactions. Investigate scheduling — compactions should not overlap on the same session.
- **CRR-006 ANY occurrence**: storage / ledger derivation issue; halt rollout if sustained; investigate `working-cache.deriveLedger`.
- **Anchor token estimate (chars/4) drift > 20% from real tokenizer count**: heuristic is too loose; revise estimator or move to real tokenizer.
- **Amnesia loop reproduction post-fix** (model refuses to reference its own prior turns): v7 redaction broke; halt rollout via flag toggle.
