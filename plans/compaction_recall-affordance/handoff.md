# Handoff — compaction_recall-affordance

## Execution Contract

This is a **defect-class spec** — production AI loops (跳針) due to narrative compaction destroying tool-call addressability. Implementation must follow the beta-workflow contract:

- Branch off `main` to `beta/compaction-recall-affordance` in `~/projects/opencode-beta` worktree.
- All code changes land on the beta branch; **no direct pushes to `main` from the worktree**.
- Spec mutations (state advances, README sync, tasks check-offs) commit to **main repo** per memory `feedback_commit_all_split_code_docs.md` — code and docs MUST be separate commits.
- Fetch-back from beta → main happens at `verified` state (M5-4), and inside the main repo, not the worktree (per memory `feedback_fetchback_location.md`).
- Daemon restart requires explicit user consent (per memory `feedback_restart_daemon_consent.md`).

The implementer is authorized to:

- Edit any file enumerated in `design.md` § Critical Files.
- Add new test files enumerated in M4.
- Add a `kind` field to MessageV2.Assistant metadata if open question Q1 confirms it's not currently persisted (small schema extension, additive).

The implementer is NOT authorized to:

- Change provider integrations.
- Modify rebind logic (`applyStreamAnchorRebind`) beyond reading its result.
- Restart the daemon — pause for operator consent first.
- Bundle code + docs in a single commit.

## Required Reads

Before writing any code, the implementer MUST read:

1. `specs/compaction/user-msg-replay-unification/events/event_2026-05-11_production-incident-29-min-predicate-silence-gap-5.md` — production incident context, RCA, why this work matters.
2. `packages/opencode/src/session/memory.ts` lines 360–510 — `Memory.Hybrid` namespace patterns; sibling helpers convention.
3. `packages/opencode/src/session/compaction.ts` lines 2580–2700 (defaultWriteAnchor) and 3110–3170 (buildUserPayload) — L1 surfaces.
4. `packages/opencode/src/session/prompt.ts` lines 1950–2040 — applyStreamAnchorRebind and surrounding block-assembly context for L3.
5. `packages/opencode/src/tool/reread-attachment.ts` — voucher-tool template; closest existing analog to RecallTool shape.
6. `packages/opencode/src/tool/registry.ts` lines 130–165 — registration pattern.

## Stop Gates In Force

- **Q1 unresolved**: if `MessageV2.Assistant.kind` (or compaction-kind metadata on the anchor message) does not exist, PAUSE M3 and surface the schema-extension decision to operator. Do not silently invent a field.
- **Test fixtures**: if integration test (M4-1) cannot spin up a real Session with in-memory storage, PAUSE and ask operator about preferred test harness pattern. Do not skip the integration test.
- **Daemon restart**: after M5-4 fetchback, STOP. Surface diff summary. Do not auto-restart.
- **Type errors crossing module boundaries**: if M4-2 reveals type errors in non-target files (e.g. provider integrations break because of an unintended export change), PAUSE and surface. Do not silently fix unrelated code.

## Execution-Ready Checklist

- [ ] Worktree exists at `~/projects/opencode-beta` and is on branch `beta/compaction-recall-affordance` (or branch created and checked out)
- [ ] Main repo on `main`; this plan's folder (`plans/compaction_recall-affordance/`) committed at state `planned`
- [ ] Required Reads (above) all loaded
- [ ] Test runner working: `bun test --bail` succeeds on an unrelated existing test file
- [ ] Typecheck working: `bun typecheck` (or repo equivalent) succeeds on current main
- [ ] Q1 (anchor `kind` persistence) investigated — outcome recorded in M3 first task before implementing

## Status at planned-state entry

All design artifacts authored:
- [proposal.md](proposal.md) — effective requirements, scope, constraints
- [design.md](design.md) — architecture, 10 design decisions, code anchors
- [idef0.json](idef0.json) — 5 activities, 15 arrows (functional decomposition)
- [grafcet.json](grafcet.json) — 16 steps (runtime evolution)
- [spec.md](spec.md) — 6 invariants, behavioural contract, API additions
- [c4.json](c4.json) — minimal C4 (5 containers; per SKILL §12.1)
- [sequence.json](sequence.json) — 2 sequences (happy path + degraded)
- [data-schema.json](data-schema.json) — 5 schemas (ToolIndexEntry, RecallInput/Output, AmnesiaNoticeBlock, telemetry events)
- [errors.md](errors.md) — 5 catalogued errors + recovery rules
- [observability.md](observability.md) — 4 event types, log line conventions, verification commands
- [test-vectors.json](test-vectors.json) — vitest coverage for L1/L2/L3 + integration

## Pre-implementation checklist for the build agent

1. **Read the production incident log first**: `specs/compaction/user-msg-replay-unification/events/event_2026-05-11_production-incident-29-min-predicate-silence-gap-5.md`. It explains *why* this work matters — 跳針 root cause + audit findings.
2. **Confirm beta-workflow location**: code goes in `~/projects/opencode-beta` worktree, branch `beta/compaction-recall-affordance`. Docs (this folder) stay on the main repo's `main` branch.
3. **Verify MessageV2.Assistant has a `kind` or equivalent field for anchor classification**. If not, M3-2 needs a schema extension; pause and surface.
4. **Verify `Tool.define` signature** in `packages/opencode/src/tool/tool.ts` before writing `recall.ts`.

## Open questions surfaced during design

- Q1: Where exactly is `kind` (narrative / hybrid_llm / etc.) persisted on the anchor assistant message? Inspected `compaction.ts:1620-1634` shows `metadata.phase` but no `kind` field on the message itself; kind is in the `recentEvents` history. M3-2 may need to thread `kind` into the message metadata at write time.
- Q2: Does `defaultWriteAnchor`'s post-write path have a sync hook before publishing telemetry? If not, INV-2 validation needs to chain into existing log call ordering.
- Q3: Should `RecallTool` be available to subagents? Initial scope says no (DD-6). If yes, registration site needs to be conditional on agent type.
- Q4: Token cost of the amnesia notice block — needs measurement against typical narrative anchor sizes. Pre-estimate: ≤500 tokens for the notice itself; cumulative over a session with frequent rebinds = bounded by anchor lifetime.

## Definition of done

- M1+M2+M3+M4 tasks all checked
- Type check passes (`bun typecheck` or equivalent)
- Targeted vitest passes (all 4 new test files green)
- Integration test verifies: anchor has TOOL_INDEX → next prompt has notice → recall returns content
- Beta commit + main-repo docs commit both exist, cross-referenced
- Diff summary surfaced to operator; **no daemon restart performed**

## Rollback plan

- If integration breaks production after merge:
  - Revert beta merge commit in main repo
  - Submodule pointer auto-rolls
  - No DB migration to reverse (no storage changes in scope)
- Feature is unconditionally on (DD-9, no flag). If gating is needed mid-rollout, add a Tweaks flag in a follow-up.

## Follow-up plans referenced

- `/plans/compaction_predicate-and-bloat/` (not yet created) — owns Bug A (predicate gap) + Bug C (anchor bloat) from the incident report. Deferrable; recall-affordance bounds the damage even without these.
