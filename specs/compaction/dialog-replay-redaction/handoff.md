# Handoff: dialog-replay-redaction

## Execution Contract

This is a **restoration-class spec** — the formal two-tier compaction model exists in code but has been misdirected by v1→v6 evolution on `post-anchor-transform.ts`. Implementation re-aligns four pieces with the formal model. Implementation must follow beta-workflow contract:

- Branch off `main` to `beta/dialog-replay-redaction`.
- All code changes land on the beta branch; **no direct pushes to main**.
- Spec mutations (state advances, README sync, tasks check-offs) commit to **main** via the spec-doc split rule (per memory `feedback_commit_all_split_code_docs.md`).
- Fetch-back from beta → main happens at `verified` state (M8-4), not before.
- Daemon restart requires explicit user consent (per memory `feedback_restart_daemon_consent.md`).

The implementer is authorized to:

- Edit any file enumerated in `design.md` § Critical Files.
- Add the new test files enumerated in M6.
- Refactor adjacent code only if blocking (e.g. extract `lastTextPartText` callers when renaming).

The implementer is NOT authorized to:

- Touch `specs/compaction/user-msg-replay-unification/` (sibling spec, already living; cross-spec sync via M6-4 only).
- Restructure the kind chain (narrative / replay-tail / low-cost-server / llm-agent stay; only narrative's body construction changes).
- Modify the codex `/responses/compact` plugin or `Hybrid.runHybridLlm` body.
- Modify `anchor-prefix-expand.ts` Phase 2 (codex's structured `serverCompactedItems` path stays orthogonal).
- Change `working-cache.deriveLedger` keying (recall flow depends on existing `part.id` linkage).
- Schema migrations on MessageV2 / CompactionPart / Anchor message shape.

## Required Reads

Before writing the first line of code:

1. **`proposal.md`** — full v1-v6 evolution timeline + 2026-05-09 incident quantification (440 items at 735K bytes ≈ 1671 bytes/item).
2. **`design.md`** — DD-1 through DD-11 are load-bearing. Read all of them. Pay special attention to DD-7 (Spec 1 synergy) and DD-11 (round numbering across recompress boundary; OQ-1 may need resolution during M4).
3. **`spec.md`** — `### Requirement:` and `#### Scenario:` blocks define correctness contract.
4. **`data-schema.json`** — exact type signatures for `SerializeRedactedDialogInput`, `RecompressDispatchInput`, `RecompressTelemetryEvent`, `TweaksDelta`.
5. **`sequence.json`** — sequence diagrams covering extend / recompress / recall paths.
6. **`c4.json`** — component-level view of the four patches.
7. **Spec 1 (`compaction/user-msg-replay-unification`)** `design.md` DD-1 (snapshotUnansweredUserMessage) — Spec 2's `findUnansweredUserMessageId` mirrors the same walk; **must** stay in sync.
8. **`packages/opencode/src/session/compaction.ts:512-680`** — `compactWithSharedContext`. Anchor write site; entry to scheduleHybridEnrichment.
9. **`packages/opencode/src/session/compaction.ts:959-975`** — `tryNarrative`, primary M2 rewrite target.
10. **`packages/opencode/src/session/compaction.ts:1454-1660`** — `scheduleHybridEnrichment` + the in-place anchor update flow STEP 3 (compaction.ts:1546-1660).
11. **`packages/opencode/src/session/post-anchor-transform.ts`** entire file — read v6 logic before rewriting to v7.
12. **`packages/opencode/src/session/memory.ts:201-289`** — `lastTextPartText` + `renderForLLMSync`. M1-DD8 site.
13. **`packages/opencode/src/session/working-cache.ts:514-555`** — `deriveLedger`. Verifies recall flow at DD-9; no edits expected.
14. **`refs/codex/codex-rs/core/src/compact.rs:466-530`** — upstream `build_compacted_history`; understanding why imitating it without the three preconditions led to v5 amnesia.
15. **`memory/feedback_no_silent_fallback.md` (AGENTS.md rule 1)** — every transformation step must log explicitly.

## Stop Gates In Force

These conditions immediately halt implementation and require user consultation:

1. **Round-numbering across recompressed boundary breaks (OQ-1)** — if parsing `## Round N` from recompressed LLM summaries proves unreliable, do NOT silently reset to `## Round 1`. Surface the issue, decide whether to add `lastRound` metadata to CompactionPart.
2. **Recall round-trip fails** — if any `recall_id: prt_xxx` in anchor body fails to resolve via `recall_toolcall_raw`, halt. The anchor body is unusable without recall.
3. **Anchor body grows beyond 3-4× current narrative output** in real sessions — projected token bloat exceeds budget. Inspect serialiser; check args truncation cap.
4. **Recompress fires synchronously during compaction commit** — design assumes background-only. If a code path forces synchronous recompress (e.g. ceiling hit during commit), pause and confirm scheduling model.
5. **More than 4 patch sites discovered** — design assumed 4 (tryNarrative, lastTextPartText, post-anchor-transform, scheduleHybridEnrichment). If a 5th divergence is found, update design.md before proceeding.
6. **Spec 1 synergy fails** — if M6-4 shows the unanswered user msg appearing in BOTH anchor body AND post-anchor stream, the `excludeUserMessageID` plumbing is broken. Halt and re-trace.

## Execution-Ready Checklist

Before claiming a task done:

- [ ] All Required Reads completed.
- [ ] Code changes pass `bun test` for the affected packages (compaction + post-anchor-transform + memory + dialog-serializer).
- [ ] New test fixtures (M6) added; each scenario exercised.
- [ ] `tweaks.cfg` includes both new flags (`enable_dialog_redaction_anchor`, `anchor_recompress_ceiling_tokens`); defaults `true` / `50000`; toggling to `false` / lower values does NOT crash anything (graceful degrade to pre-fix behaviour).
- [ ] Telemetry verified: `compaction.recompressed` events appear with full schema on every recompress.
- [ ] No amnesia loop reproduction in M7-8 manual session.
- [ ] Recall round-trip verified: M6-2 covers it; spot-check one real session manually.
- [ ] `design.md` Critical Files section unchanged (no surprise file edits beyond the listed ones).
- [ ] Cross-spec synergy: M6-4 passes — anchor body excludes unanswered user msg; Spec 1 helper replays it post-anchor; model sees it exactly once.
- [ ] `lastTextPartText` rename propagated to all callers (compile-time check).

## Commit Strategy

Per memory `feedback_commit_all_split_code_docs.md`:

- **Code commits** (under `packages/opencode/`) → `beta/dialog-replay-redaction` branch only.
- **Spec commits** (under `specs/compaction/dialog-replay-redaction/`) → `main` directly.
- Don't mix the two in a single commit. If you find yourself wanting to, split.

Suggested commit cadence:

1. M1 (serializer + reasoning fix): one commit `feat(session): add dialog-serializer module + lastNarrativePartText reasoning fix`.
2. M2 (tryNarrative): one commit `refactor(session): tryNarrative produces redacted-dialog body`.
3. M3 (post-anchor v7): one commit `refactor(session): post-anchor-transform v7 redacts tool outputs instead of dropping turns`.
4. M4 (recompress dispatch): one commit `feat(session): size-triggered recompress with provider dispatch` (or split into M4-A2 + M4-A3 if reviewing concerns).
5. M5 (tweaks): one commit `feat(tweaks): register dialog-redaction-anchor + recompress-ceiling flags`.
6. M6 (tests): one commit per fixture file; or batched `test(session): dialog-replay-redaction integration coverage`.
7. M7 evidence: spec-side, no code commit; spec_record_event entries in `events/`.
8. M8 sync: spec-side promote + sync.

## Open Questions

- **OQ-1 (DD-11)**: Round numbering across recompressed boundary. **Resolution gate**: M4 implementation phase. Two options:
  - A: instruct recompress LLM prompt to preserve `## Round N` markers; parse them in next extend.
  - B: store `lastRound` as explicit metadata on `CompactionPart`.
  - Decide based on prompt-engineering robustness during M4. Default: try A first; fall back to B if M7-5 manual repro shows duplicate round numbers.

## Rollback

If post-merge incidents occur:

1. **Hot toggle**: `tweaks.cfg` set `compaction.enable_dialog_redaction_anchor=false`. No daemon restart required (Tweaks is hot-reloaded). All four patches revert atomically:
   - `tryNarrative` → legacy `Memory.renderForLLMSync` body.
   - `transformPostAnchorTail` → v6 drop logic.
   - `scheduleHybridEnrichment` → legacy thresholds + observed-gate.
   - `lastNarrativePartText` rename stays (it's correctness-level, not a behaviour switch); the reasoning-channel fix stays active.
2. **Cold revert**: revert the entire merge commit; `git revert -m1 <merge_sha>` on `main`. Spec stays at `verified` (don't down-grade state on revert).
3. **Spec quarantine**: if defect was in design (not implementation), set `.state.json` mode to `revise` to mark the spec for re-design.
4. **Cross-spec rollback note**: rolling back this spec does NOT affect Spec 1 (`user-msg-replay-unification`); they share helper logic but not state.
