# Event: compaction-redesign phase 2 — render functions

## Phase

2 — Memory render functions (DD-5: two independent render outputs from
the same SessionMemory).

## Done

- 2.1 `Memory.renderForLLM(sid)` async + `Memory.renderForLLMSync(mem)`
  pure variant for testability. Output: compact provider-agnostic plain
  text. Concatenates `turnSummaries[].text` without per-turn headers
  (token economy). Falls back to fileIndex+actionLog text when
  turnSummaries empty (e.g. first-turn sessions where TurnSummary capture
  hasn't fired yet).
- 2.2 `Memory.renderForHuman(sid)` async + `renderForHumanSync(mem)` pure
  variant. Output: markdown timeline with `# Session <id>`, `## Turn N`
  headers, file-touch chronology, action log, last-compacted footer.
  Includes provider/model identity for debug context.
- 2.3 Unit test asserts both renders produce distinct strings on the same
  Memory (R-8 acceptance).
- 2.4 Unit test simulates 20 realistic-sized turns and verifies
  `renderForLLM` stays under 30% of typical 272K context window
  (~81600 tokens). Result: well under budget.

## Key design choices

- **Pure sync variant exposed for tests** — `renderForLLMSync(mem)` and
  `renderForHumanSync(mem)` take an already-loaded SessionMemory so tests
  don't need Storage mocks. Async public API delegates to them. Aligns
  with existing `formatSnapshot(space)` pattern in shared-context.ts.
- **No model/provider IDs in LLM output** — provider-agnostic per R-5
  (provider-switch must be safe). Verified by negative assertion in
  test "renderForLLMSync concatenates turn texts without per-turn headers".
- **Human form intentionally noisier** — model IDs, ISO timestamps,
  section markers. Different optimization target per DD-5 (this is what
  makes the two-function split worth it instead of one-function-with-flag).
- **Empty-Memory behaviour** — `renderForLLMSync` returns `""`, signalling
  caller (kind chain in phase 4) to fall through. `renderForHumanSync`
  returns a stub message so UI never gets empty string surprise.

## Validation

- `bun test packages/opencode/src/session/memory.test.ts` → 16 pass / 0 fail
  (added 7 new render tests on top of phase 1's 9)
- `bun test packages/opencode/src/session/compaction.test.ts` → 9 pass /
  0 fail (existing tests unaffected)
- `plan-sync.ts specs/compaction-redesign/` → clean (no drift)

## Drift

None. The render functions are additive on top of phase 1; no consumer
yet reads them.

## Remaining (phase 3 onward)

Phase 3 wires `Memory.appendTurnSummary` into `prompt.ts:1230` runloop
exit handler — that's when Memory starts accumulating real narrative
content from production sessions.

## Files changed

- `packages/opencode/src/session/memory.ts` — added renderForLLM /
  renderForLLMSync / renderForHuman / renderForHumanSync
- `packages/opencode/src/session/memory.test.ts` — 7 new render tests
- `specs/compaction-redesign/tasks.md` — phase 2 boxes checked
