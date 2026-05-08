# Tasks

All tasks complete. Spec is in `living` state, merged to `main` in
commit `01aca5124`.

## Shipped Components

### Three itemCount-gated triggers

- [x] Paralysis × bloated-input compaction trigger
  ([prompt.ts](../../packages/opencode/src/session/prompt.ts) at
  3-turn paralysis recovery branch). Commit `077214fe7`.
- [x] ws-truncation × bloated-input compaction trigger
  ([prompt.ts](../../packages/opencode/src/session/prompt.ts) at
  runloop top, after `lastFinished` resolution). Commits
  `6530fa6ca` (initial), `6163d81eb` (use `finish` field instead
  of part metadata).
- [x] Pre-emptive rebind compaction
  ([prompt.ts](../../packages/opencode/src/session/prompt.ts) at
  step=1, after `applyStreamAnchorRebind`). Commit `451d87b39`.

### Phase 2 anchor-prefix expansion

- [x] `CompactionPart.metadata` additive fields (`serverCompactedItems`,
  `chainBinding`) in
  [message-v2.ts](../../packages/opencode/src/session/message-v2.ts).
- [x] `tryLowCostServer` persists `compactedItems` + chain identity
  in [compaction.ts](../../packages/opencode/src/session/compaction.ts).
- [x] `expandAnchorCompactedPrefix` module
  ([anchor-prefix-expand.ts](../../packages/opencode/src/session/anchor-prefix-expand.ts)).
- [x] Wired into prompt assembly after `applyStreamAnchorRebind`.
- [x] Decoupled from Phase 1 (independent flag gate). Commits
  `2f3545303` (initial), `c1feb48a1` (decouple).

### Compaction priority

- [x] `resolveKindChain` codex-first reorder; subscription/ctxRatio
  gate removed. Commit `39bc97786`.

### Telemetry

- [x] inputItemCount in tooltip + Context tab. Commit `99e954985`.
- [x] Prompt-block names reflect cache-reuse mental model
  (`動態內文 · 低頻 / 中頻 / 高頻`). Commit `c3bc9cd09`.
- [x] Rotation/compaction recent-events ring buffer in Q card.
  Commit `ea2cc166e`, hotfix `02c239fdb`.

### Tests

- [x] Phase 2 expander unit tests
  (`packages/opencode/test/session/anchor-prefix-expand.test.ts`,
  10 cases).
- [x] Compaction kind-chain tests updated for codex-first priority
  (`packages/opencode/test/session/compaction.test.ts`).
- [x] Emission filter unit tests
  (`packages/opencode/test/session/emission-filter.test.ts`,
  15 cases).
- [x] Regression: 253 tests pass (26 pre-existing failures unchanged).

## Out of Scope (deferred)

- Phase 1 per-turn transformer code retained at
  [packages/opencode/src/session/post-anchor-transform.ts](../../packages/opencode/src/session/post-anchor-transform.ts)
  with `compaction_phase1_enabled=0`. Available for future
  experimental re-enable; not part of production architecture.
- L3 lazy retrieval runtime (model-facing recall tools): out of
  this plan's scope, lives in `system-manager:recall_toolcall_*`
  MCP surface.
- gpt-5.5 backend item-array sensitivity: upstream bug, mitigated
  not eliminated. If OpenAI raises gpt-5.5's `max_context_window`
  to 1 M, the itemCount triggers fall dormant naturally
  (paralysis-gated for the reactive ones, threshold-gated for the
  pre-emptive one).
