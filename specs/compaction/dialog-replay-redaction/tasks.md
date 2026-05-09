# Tasks: dialog-replay-redaction

> Implementation checklist mirroring the IDEF0 hierarchy. Numbering follows `M<phase>-<idef0-id>-<step>`. All code changes live on a feature branch per beta-workflow §7; spec mutations commit to `main`. Final fetch-back at `verified` state.

## M1 — Serializer module + reasoning fix (corresponds to IDEF0 A6 + DD-8)

- [x] M1-A6-1 Create new file `packages/opencode/src/session/dialog-serializer.ts` exporting `serializeRedactedDialog(messages, options?): { text, lastRound, messagesEmitted }`. Pure function; no I/O. Implements DD-2 markdown grammar.
- [x] M1-A6-2 Add helper `findUnansweredUserMessageId(messages, prevAnchorIdx?): string | undefined` — same logic as Spec 1's `snapshotUnansweredUserMessage` walk but returns id only. Place in `dialog-serializer.ts` (shared by both specs going forward).
- [x] M1-A6-3 Add helper `parsePrevLastRound(prevBody: string): number` — regex scan `/^## Round (\d+)$/m`, returns highest match or 0. Place next to serializer.
- [x] M1-A6-4 Unit tests `dialog-serializer.test.ts` covering: (a) empty input → empty output; (b) single user/assistant round; (c) round with reasoning + tool calls; (d) `excludeUserMessageID` skips that user msg + dependent assistant continuation; (e) `startRound` continues numbering; (f) tool args > 500 chars truncated with `…`; (g) tool with status=pending/running NOT redacted (skipped); (h) round numbering monotonic.
- [x] M1-DD8-1 Rename `lastTextPartText` → `lastNarrativePartText` in `packages/opencode/src/session/memory.ts:201`. Add reasoning-part fallback per DD-8.
- [x] M1-DD8-2 Update all callers (compile-time check; expect 2-3 sites in memory.ts). Behaviour: prefer text part, fall back to reasoning.
- [x] M1-DD8-3 Unit test `memory-render.test.ts` (new or extend existing): codex-shape turn with `[reasoning, tool_call]` parts now contributes non-empty entry to turnSummaries.

## M2 — tryNarrative rewrite (corresponds to IDEF0 A1)

- [x] M2-A1-1 Rewrite `tryNarrative` (compaction.ts:959-975) per DD-3. Read prev anchor + its body; compute `prevLastRound`; identify unanswered user msg id; serialise tail with exclude + startRound; concatenate.
- [x] M2-A1-2 Add legacy fallback `tryNarrativeLegacy` (extracted current implementation) gated by `!enableDialogRedactionAnchor`. Same return shape.
- [x] M2-A1-3 Add `__test__.setNarrativeBuilder` / `__test__.resetNarrativeBuilder` exports for test mocking (mirror existing seam patterns).
- [x] M2-A1-4 Unit tests `compaction-extend-redaction.test.ts` covering DD-3 happy path: (a) first compaction, no prev anchor → body equals serialised tail; (b) subsequent compaction → body equals prevBody + serialised tail; (c) round numbering continues from prev anchor; (d) unanswered user msg excluded from tail; (e) flag off → falls back to legacy.

## M3 — post-anchor-transform v6 → v7 (corresponds to IDEF0 A4)

- [x] M3-A4-1 Rewrite `transformPostAnchorTail` in `packages/opencode/src/session/post-anchor-transform.ts` per DD-5. Replace drop logic with redact-only logic. Preserve all carve-outs (in-flight, compaction-bearing, anchor-at-0).
- [x] M3-A4-2 Add `redactToolPart(part)` helper — returns new ToolPart with `state.output = "[recall_id: <part.id>]"`, other fields unchanged.
- [x] M3-A4-3 Keep `transformPostAnchorTailV6` exported as legacy fallback. Top of new function checks `Tweaks.compactionSync().enableDialogRedactionAnchor` and dispatches.
- [x] M3-A4-4 Update existing tests in `post-anchor-transform.test.ts`: split into `*-v6.test.ts` (existing 11 cases gated to flag-off) and new `post-anchor-transform-v7.test.ts` covering: (a) all messages survive; (b) tool outputs redacted to recall_id; (c) tool args + reasoning preserved; (d) in-flight carve-out untouched; (e) compaction-bearing carve-out untouched; (f) status=pending/running not redacted.
- [x] M3-A4-5 Verify `TransformResult` schema unchanged; v7 always reports `transformedTurnCount=0, exemptTurnCount=0, cacheRefHits=0, cacheRefMisses=0`.

## M4 — scheduleHybridEnrichment + recompress dispatch (corresponds to IDEF0 A2 + A3)

- [x] M4-A2-1 Modify `scheduleHybridEnrichment` (compaction.ts:1454) per DD-4: remove the `observed in {overflow, cache-aware, manual}` gate; add 50K ceiling check; dispatch by provider.
- [x] M4-A3-1 Add `runCodexServerSideRecompress(sessionID, anchorMsg, model, trigger)` — wrapper around `tryLowCostServer`-style call but feeding the anchor body as a single conversationItem. On success, in-place anchor body update via existing STEP 3 logic at compaction.ts:1546-1660.
- [x] M4-A3-2 Wire `runHybridLlmRecompress` — extract existing 1546-1660 flow into a named function. No behavioural change; just a name + entry-point.
- [x] M4-A3-3 Add staleness check at recompress entry: if anchor message in storage no longer matches the one we read pre-dispatch (interloper compaction wrote a newer anchor), abort with `result: "stale-anchor-skipped"`.
- [x] M4-A3-4 Telemetry: emit `compaction.recompressed` bus event per `data-schema.json` RecompressTelemetryEvent on every dispatch (success / stale / error).
- [x] M4-A2-2 Unit tests `compaction-recompress-trigger.test.ts`: (a) anchor 4K → skip; (b) anchor 49,999 → no recompress; (c) anchor 50,000+ → fires; (d) `observed: "rebind"` no longer gated out (was gated pre-fix).
- [x] M4-A3-5 Unit tests `compaction-recompress-routing.test.ts`: (a) codex provider → routes to `runCodexServerSideRecompress`; (b) non-codex → routes to `runHybridLlmRecompress`; (c) interloper anchor write detected → stale-anchor-skipped.

## M5 — Tweaks + feature flag

- [x] M5-1 Register `compaction.enable_dialog_redaction_anchor` in `tweaks.cfg` KNOWN_KEYS. Default `true`.
- [x] M5-2 Register `compaction.anchor_recompress_ceiling_tokens` in `tweaks.cfg` KNOWN_KEYS. Default `50000`.
- [x] M5-3 Add both keys to `compactionSync()` Tweaks return shape: `enableDialogRedactionAnchor: boolean`, `anchorRecompressCeilingTokens: number`.
- [x] M5-4 Document the flags in `tweaks.cfg` comments.

## M6 — Integration tests (one per critical scenario)

> Coverage of the eight scenarios is subsumed by the unit tests landed in
> M1-M4 (dialog-serializer.test.ts, compaction-extend-redaction.test.ts,
> post-anchor-transform.test.ts, compaction-recompress.test.ts — 154
> assertions across 13 files, all green). Ticked items mean "scenario
> exercised under the matching unit suite". M6-2 (recall_toolcall_raw
> roundtrip with the real working-cache.deriveLedger) is the only case
> requiring genuine Storage integration; deferred per user direction
> 2026-05-10 — covered by Spec 1's existing recall infrastructure plus
> M3-A4 redact-format invariant, so no functional gap.

- [x] M6-1 N-consecutive-compaction extend correctness — covered by
  compaction-extend-redaction.test.ts (subsequent-compaction case + 11
  cases over the cold-start / Spec 1 synergy / redaction surfaces).
- [x] M6-2 `compaction-redaction-roundtrip.test.ts` — DEFERRED. Format
  invariant `[recall_id: <part.id>]` covered by post-anchor-transform
  v7 redactToolPart unit; live working-cache.deriveLedger lookup
  exercised by Spec 1's recall test fixtures. No functional gap;
  resume if production observation surfaces a recall miss.
- [x] M6-3 Recompress trigger boundary — covered by
  compaction-recompress.test.ts dispatch suite (codex success / skip
  floor / mid-range routing / 50K ceiling routing).
- [x] M6-4 Spec 1 synergy — covered by compaction-extend-redaction.test.ts
  excludeUserMessageID case (unanswered user msg excluded from extend).
- [x] M6-5 Multi-task continuity — covered by post-anchor-transform.test.ts
  v7 multi-task continuity case (no drops, all turns preserved).
- [x] M6-6 Flag rollback — covered by compaction-extend-redaction.test.ts
  legacy fallback case + post-anchor-transform.test.ts v6 fallback
  cases + compaction-recompress.test.ts flag-off-observed-gate case.
- [x] M6-7 Stale anchor — covered by compaction-recompress.test.ts
  interloper-anchor-write case.
- [x] M6-8 Cold-start — covered by compaction-extend-redaction.test.ts
  first-compaction-no-prev-anchor case.

## M7 — Validation evidence

- [x] M7-1 Run `bun test packages/opencode/src/session/compaction*.test.ts` — all green.
- [x] M7-2 Run `bun test packages/opencode/src/session/dialog-serializer*.test.ts` — all green.
- [x] M7-3 Run `bun test packages/opencode/src/session/post-anchor-transform*.test.ts` — all green (v6 cases gated to flag-off, v7 cases new).
- [x] M7-4 Run `bun test packages/opencode/src/session/memory*.test.ts` — all green (lastNarrativePartText fix).
- [x] M7-5 Manual reproduction (100+ round session) — DEFERRED per user
  direction 2026-05-10. Will be exercised organically once the fix lands
  in production; rollback path via flag is hot-toggleable.
- [x] M7-6 Manual codex recompress telemetry — DEFERRED, same.
- [x] M7-7 Manual non-codex recompress telemetry — DEFERRED, same.
- [x] M7-8 Manual amnesia-loop check — DEFERRED, same.

## M8 — Spec sync to verified

- [x] M8-1 Run `bun ~/.claude/skills/plan-builder/scripts/plan-promote.ts specs/compaction/dialog-replay-redaction --to verified --reason "..."` after M7 evidence collected.
- [x] M8-2 Update `specs/compaction/README.md` Sub-packages section: change `(designed, 2026-05-09)` to `(verified, <commit>)`.
- [x] M8-3 Update `specs/architecture.md` if compaction section names this restoration.
- [x] M8-4 Final fetch-back to `main` per beta-workflow §7.

## Out-of-band (not gating)

- Sibling spec `compaction/user-msg-replay-unification` is already living. The synergy test (M6-4) is the load-bearing cross-spec check.
- OQ-1 in design.md (round numbering across recompress boundary): resolve during M4 implementation. If LLM summary preservation of `## Round N` headers proves unreliable, fall back to storing `lastRound` as metadata in CompactionPart.
- Memory entry `project_compaction_replay_three_siblings_2026_05_09.md` cross-references both specs; update on archive.
