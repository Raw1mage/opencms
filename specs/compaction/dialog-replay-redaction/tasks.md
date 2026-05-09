# Tasks: dialog-replay-redaction

> Implementation checklist mirroring the IDEF0 hierarchy. Numbering follows `M<phase>-<idef0-id>-<step>`. All code changes live on a feature branch per beta-workflow §7; spec mutations commit to `main`. Final fetch-back at `verified` state.

## M1 — Serializer module + reasoning fix (corresponds to IDEF0 A6 + DD-8)

- [ ] M1-A6-1 Create new file `packages/opencode/src/session/dialog-serializer.ts` exporting `serializeRedactedDialog(messages, options?): { text, lastRound, messagesEmitted }`. Pure function; no I/O. Implements DD-2 markdown grammar.
- [ ] M1-A6-2 Add helper `findUnansweredUserMessageId(messages, prevAnchorIdx?): string | undefined` — same logic as Spec 1's `snapshotUnansweredUserMessage` walk but returns id only. Place in `dialog-serializer.ts` (shared by both specs going forward).
- [ ] M1-A6-3 Add helper `parsePrevLastRound(prevBody: string): number` — regex scan `/^## Round (\d+)$/m`, returns highest match or 0. Place next to serializer.
- [ ] M1-A6-4 Unit tests `dialog-serializer.test.ts` covering: (a) empty input → empty output; (b) single user/assistant round; (c) round with reasoning + tool calls; (d) `excludeUserMessageID` skips that user msg + dependent assistant continuation; (e) `startRound` continues numbering; (f) tool args > 500 chars truncated with `…`; (g) tool with status=pending/running NOT redacted (skipped); (h) round numbering monotonic.
- [ ] M1-DD8-1 Rename `lastTextPartText` → `lastNarrativePartText` in `packages/opencode/src/session/memory.ts:201`. Add reasoning-part fallback per DD-8.
- [ ] M1-DD8-2 Update all callers (compile-time check; expect 2-3 sites in memory.ts). Behaviour: prefer text part, fall back to reasoning.
- [ ] M1-DD8-3 Unit test `memory-render.test.ts` (new or extend existing): codex-shape turn with `[reasoning, tool_call]` parts now contributes non-empty entry to turnSummaries.

## M2 — tryNarrative rewrite (corresponds to IDEF0 A1)

- [ ] M2-A1-1 Rewrite `tryNarrative` (compaction.ts:959-975) per DD-3. Read prev anchor + its body; compute `prevLastRound`; identify unanswered user msg id; serialise tail with exclude + startRound; concatenate.
- [ ] M2-A1-2 Add legacy fallback `tryNarrativeLegacy` (extracted current implementation) gated by `!enableDialogRedactionAnchor`. Same return shape.
- [ ] M2-A1-3 Add `__test__.setNarrativeBuilder` / `__test__.resetNarrativeBuilder` exports for test mocking (mirror existing seam patterns).
- [ ] M2-A1-4 Unit tests `compaction-extend-redaction.test.ts` covering DD-3 happy path: (a) first compaction, no prev anchor → body equals serialised tail; (b) subsequent compaction → body equals prevBody + serialised tail; (c) round numbering continues from prev anchor; (d) unanswered user msg excluded from tail; (e) flag off → falls back to legacy.

## M3 — post-anchor-transform v6 → v7 (corresponds to IDEF0 A4)

- [ ] M3-A4-1 Rewrite `transformPostAnchorTail` in `packages/opencode/src/session/post-anchor-transform.ts` per DD-5. Replace drop logic with redact-only logic. Preserve all carve-outs (in-flight, compaction-bearing, anchor-at-0).
- [ ] M3-A4-2 Add `redactToolPart(part)` helper — returns new ToolPart with `state.output = "[recall_id: <part.id>]"`, other fields unchanged.
- [ ] M3-A4-3 Keep `transformPostAnchorTailV6` exported as legacy fallback. Top of new function checks `Tweaks.compactionSync().enableDialogRedactionAnchor` and dispatches.
- [ ] M3-A4-4 Update existing tests in `post-anchor-transform.test.ts`: split into `*-v6.test.ts` (existing 11 cases gated to flag-off) and new `post-anchor-transform-v7.test.ts` covering: (a) all messages survive; (b) tool outputs redacted to recall_id; (c) tool args + reasoning preserved; (d) in-flight carve-out untouched; (e) compaction-bearing carve-out untouched; (f) status=pending/running not redacted.
- [ ] M3-A4-5 Verify `TransformResult` schema unchanged; v7 always reports `transformedTurnCount=0, exemptTurnCount=0, cacheRefHits=0, cacheRefMisses=0`.

## M4 — scheduleHybridEnrichment + recompress dispatch (corresponds to IDEF0 A2 + A3)

- [ ] M4-A2-1 Modify `scheduleHybridEnrichment` (compaction.ts:1454) per DD-4: remove the `observed in {overflow, cache-aware, manual}` gate; add 50K ceiling check; dispatch by provider.
- [ ] M4-A3-1 Add `runCodexServerSideRecompress(sessionID, anchorMsg, model, trigger)` — wrapper around `tryLowCostServer`-style call but feeding the anchor body as a single conversationItem. On success, in-place anchor body update via existing STEP 3 logic at compaction.ts:1546-1660.
- [ ] M4-A3-2 Wire `runHybridLlmRecompress` — extract existing 1546-1660 flow into a named function. No behavioural change; just a name + entry-point.
- [ ] M4-A3-3 Add staleness check at recompress entry: if anchor message in storage no longer matches the one we read pre-dispatch (interloper compaction wrote a newer anchor), abort with `result: "stale-anchor-skipped"`.
- [ ] M4-A3-4 Telemetry: emit `compaction.recompressed` bus event per `data-schema.json` RecompressTelemetryEvent on every dispatch (success / stale / error).
- [ ] M4-A2-2 Unit tests `compaction-recompress-trigger.test.ts`: (a) anchor 4K → skip; (b) anchor 49,999 → no recompress; (c) anchor 50,000+ → fires; (d) `observed: "rebind"` no longer gated out (was gated pre-fix).
- [ ] M4-A3-5 Unit tests `compaction-recompress-routing.test.ts`: (a) codex provider → routes to `runCodexServerSideRecompress`; (b) non-codex → routes to `runHybridLlmRecompress`; (c) interloper anchor write detected → stale-anchor-skipped.

## M5 — Tweaks + feature flag

- [ ] M5-1 Register `compaction.enable_dialog_redaction_anchor` in `tweaks.cfg` KNOWN_KEYS. Default `true`.
- [ ] M5-2 Register `compaction.anchor_recompress_ceiling_tokens` in `tweaks.cfg` KNOWN_KEYS. Default `50000`.
- [ ] M5-3 Add both keys to `compactionSync()` Tweaks return shape: `enableDialogRedactionAnchor: boolean`, `anchorRecompressCeilingTokens: number`.
- [ ] M5-4 Document the flags in `tweaks.cfg` comments.

## M6 — Integration tests (one per critical scenario)

- [ ] M6-1 `compaction-extend-correctness.test.ts` — N consecutive compactions on synthetic session; verify `anchor[n+1].body == anchor[n].body + redacted(tail)` for every n.
- [ ] M6-2 `compaction-redaction-roundtrip.test.ts` — for each `recall_id: prt_xxx` in anchor body, `recall_toolcall_raw(prt_xxx)` returns original tool output (uses real working-cache.deriveLedger).
- [ ] M6-3 `compaction-recompress-boundary.test.ts` — 49,999 token anchor stays; 50,001 triggers; provider routing verified end-to-end.
- [ ] M6-4 `compaction-spec-1-synergy.test.ts` — unanswered user msg msg_X exists pre-extend; anchor body does NOT contain msg_X text; post-anchor stream contains msg_Y (Spec 1 helper output) with id > anchor.id; model sees msg_X exactly once.
- [ ] M6-5 `compaction-multi-task-continuity.test.ts` — 3 prior user-task chains in post-anchor stream; v7 preserves all assistant turns; tool outputs redacted; assistant text + reasoning + args preserved verbatim.
- [ ] M6-6 `compaction-flag-rollback.test.ts` — `enableDialogRedactionAnchor: false`; verifies tryNarrative legacy + post-anchor v6 + scheduleHybridEnrichment legacy gating all restored atomically.
- [ ] M6-7 `compaction-recompress-stale-anchor.test.ts` — interloper anchor write; recompress aborts cleanly with `stale-anchor-skipped`.
- [ ] M6-8 `compaction-cold-start.test.ts` — fresh session, no prev anchor; first narrative compaction body is just `serializeRedactedDialog(tail)` with no prefix.

## M7 — Validation evidence

- [ ] M7-1 Run `bun test packages/opencode/src/session/compaction*.test.ts` — all green.
- [ ] M7-2 Run `bun test packages/opencode/src/session/dialog-serializer*.test.ts` — all green.
- [ ] M7-3 Run `bun test packages/opencode/src/session/post-anchor-transform*.test.ts` — all green (v6 cases gated to flag-off, v7 cases new).
- [ ] M7-4 Run `bun test packages/opencode/src/session/memory*.test.ts` — all green (lastNarrativePartText fix).
- [ ] M7-5 Manual reproduction: synthesize a session with 100+ rounds; verify anchor body contains `## Round 1` through `## Round N` markers; verify recompress fires at the configured ceiling.
- [ ] M7-6 Manual: trigger codex compaction with anchor > 50K; verify telemetry `compaction.recompressed { kind: "low-cost-server", trigger: "size-ceiling" }` emitted.
- [ ] M7-7 Manual: trigger non-codex compaction with anchor > 50K; verify telemetry `kind: "hybrid_llm"` emitted.
- [ ] M7-8 Manual: tail debug.log during a real session for one hour; confirm no amnesia loop reproduction (model can reference prior assistant turns).

## M8 — Spec sync to verified

- [ ] M8-1 Run `bun ~/.claude/skills/plan-builder/scripts/plan-promote.ts specs/compaction/dialog-replay-redaction --to verified --reason "..."` after M7 evidence collected.
- [ ] M8-2 Update `specs/compaction/README.md` Sub-packages section: change `(designed, 2026-05-09)` to `(verified, <commit>)`.
- [ ] M8-3 Update `specs/architecture.md` if compaction section names this restoration.
- [ ] M8-4 Final fetch-back to `main` per beta-workflow §7.

## Out-of-band (not gating)

- Sibling spec `compaction/user-msg-replay-unification` is already living. The synergy test (M6-4) is the load-bearing cross-spec check.
- OQ-1 in design.md (round numbering across recompress boundary): resolve during M4 implementation. If LLM summary preservation of `## Round N` headers proves unreliable, fall back to storing `lastRound` as metadata in CompactionPart.
- Memory entry `project_compaction_replay_three_siblings_2026_05_09.md` cross-references both specs; update on archive.
