# Tasks

## ERRATUM 2026-05-08 (d) — Phase 1 tasks DONE-THEN-ABANDONED

All Phase 1 tasks (1.x–6.x below) were executed through commits
`6dcd327fa` (v1) → `43d400258` (v2) → `a2f30dc4c` (v3) →
`ac2b34a0b` (v5) → `c56e5538f` (v6) → `c1feb48a1` (disabled).

**Phase 1 transformer is off by default and not part of the production
architecture.** See [proposal.md ERRATUM](./proposal.md#erratum-2026-05-08-d--phase-1-misframing-disabled).

Treat tasks below as forensic reference. Do **not** reactivate Phase 1
without first revisiting the upstream re-read (Phase 1's premise was a
misread of `for_prompt()`).

Phase 2 (anchor-prefix-expand for codex compactedItems) **is** the live
alignment. Phase 2 work lived inside commit `2f3545303` and survived
all subsequent revisions. Phase 2 governed by DD-8…DD-13 in design.md.

---

Phase 1 execution checklist for compaction-fix. Numbering uses A1-A5 from idef0.json for traceability where applicable. Per plan-builder §16.1, only the current phase's unchecked items go to TodoWrite at any time.

## 1. tweaks.cfg keys + flag plumbing (Phase 1, DD-6)

- [ ] 1.1 Add `compaction.phase1Enabled: false` (default), `compaction.recentRawRounds: 2` (default), `compaction.fallbackThreshold: 5` (default) to [packages/opencode/src/util/tweaks.ts](../../packages/opencode/src/util/tweaks.ts) compaction sync section
- [ ] 1.2 Plumb readers into `prompt.ts` so the transformer entry point can read all three values
- [ ] 1.3 Unit test: tweaks loader reads new keys, defaults take effect when keys absent

## 2. Post-anchor transformer (Phase 1 core, A3 + DD-1, DD-2, DD-3, DD-7)

- [ ] 2.1 Define `TraceMarker` shape per data-schema.json `$defs/TraceMarker` in a new file (suggested: `packages/opencode/src/session/post-anchor-transform.ts`)
- [ ] 2.2 Implement `formatTraceMarker(turn: AssistantTurn)`: produces single-line text per DD-1 format (`[turn N] tool_a(args) → WC042; tool_b(args) → WC043; reasoning_summary`)
- [ ] 2.3 Args truncation: tool args truncated to 80 chars; reasoning truncated to 50 chars
- [ ] 2.4 WorkingCache reference resolution: query existing reference by tool callId; if absent, lazy-write via existing WorkingCache write API (DD-3 fallback)
- [ ] 2.5 Layer purity guard: assert formatted text contains none of LayerPurityForbiddenKeys (data-schema.json) — throw at format time if violated (defensive)
- [ ] 2.6 Implement `transformPostAnchorTail(messages, recentRawRounds)`: iterate completed assistant messages, skip last N rounds, fold each older one into a single synthetic user-role TraceMarker message
- [ ] 2.7 Preserve `compaction` part type (Mode 1 inline) — assistant messages containing `compaction` parts are exempt from transform (DD-7 white-list)
- [ ] 2.8 Preserve in-flight assistant message intact (last assistant if pending tool calls present)

## 3. Wiring + safety net (Phase 1, A4 + DD-4, DD-5)

- [ ] 3.1 In [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts), at step=1 prompt assembly site (around `applyStreamAnchorRebind` call at line ~1840), add transformer invocation when `phase1Enabled && !session.parentID`
- [ ] 3.2 Subagent bypass per DD-5 — early return path for `session.parentID` cases
- [ ] 3.3 Safety net per DD-4 — count transformed messages; if < `fallbackThreshold`, log warn `phase1-transform: fallback to raw, threshold=X, got=Y` and use raw messages
- [ ] 3.4 Refresh `lastFinished.tokens.input` after transform (consistent with existing rebind path behavior at prompt.ts:1850)

## 4. Tests (Phase 1)

- [ ] 4.1 Unit test in `packages/opencode/test/session/post-anchor-transform.test.ts`:
   - 4.1.1 30-turn synthetic session → transformer keeps last 2 raw, folds 28 into trace markers, output count matches expected
   - 4.1.2 Trace marker text format conforms to DD-1 (regex check `^\[turn \d+\]`)
   - 4.1.3 Layer purity assertion: trace marker text never contains forbidden keys (DD-7)
   - 4.1.4 Tool args truncated to 80 chars; reasoning to 50 chars
   - 4.1.5 `compaction` part type exempt from transform
   - 4.1.6 In-flight assistant preserved intact
- [ ] 4.2 Integration test against `applyStreamAnchorRebind` flow in extended `prompt.applyStreamAnchorRebind.test.ts`:
   - 4.2.1 Flag off → transformer skipped, behaviour identical to pre-Phase-1
   - 4.2.2 Flag on + main session → transformer runs
   - 4.2.3 Flag on + subagent (parentID set) → transformer skipped
   - 4.2.4 Safety net fires when transformed messages < threshold
- [ ] 4.3 WorkingCache integration test: trace marker references resolve back to original tool result via existing `WorkingCache.selectValid`
- [ ] 4.4 Regression: all existing `applyStreamAnchorRebind` tests still pass

## 5. Observability + manual verification (Phase 1)

- [ ] 5.1 Add structured log line at transform entry: `phase1-transform: applied, sessionID=..., transformedTurns=N, recentRawRounds=2, traceMarkers=N, cacheRefs=N, missing=N`
- [ ] 5.2 Add JSONL field to fix-empty-response-rca's empty-turns.jsonl entries: `phase1TransformApplied: boolean` (passed through requestOptionsShape or sibling field) — confirms during soak whether transformer fired
- [ ] 5.3 Operator runbook entry: how to enable for one session via tweaks.cfg, verify drop in inputItemCount via M-equivalent jq query

## 6. Phase 1 ship sequence

- [ ] 6.1 All 1-4 complete; 5.1-5.2 logging in place
- [ ] 6.2 Beta worktree fetch-back to `test/compaction-fix` in main repo
- [ ] 6.3 Manual smoke: enable flag in test branch, run a 30+ turn session, observe inputItemCount drops in `[CODEX-WS] REQ` logs
- [ ] 6.4 Soak 24h: monitor fix-empty-response-rca empty-turns.jsonl — failure rate must not increase relative to pre-Phase-1 baseline (0.71%)
- [ ] 6.5 If 6.4 green, flip default `compaction.phase1Enabled` to `true` in a separate small commit
- [ ] 6.6 Merge `test/compaction-fix` → main; cleanup beta + test branches; promote spec to verified

## Per-phase ship gates

- **Phase 1 ship gate**: 1.x-5.x all checked; 4.x tests pass; 6.x sequence executed end-to-end with 24h soak green. Phase 1 is independently shippable.
- **Phase 2 (future)**: separate plan iteration; unblocked by Phase 1 baseline data (cache_read changes, classifier threshold recalibration observations) feeding the design.
