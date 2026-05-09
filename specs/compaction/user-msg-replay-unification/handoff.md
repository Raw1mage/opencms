# Handoff: user-msg-replay-unification

## Execution Contract

This is a **hotfix-class spec** — the live system has a recurring defect (user message swallowed by compaction). Implementation must follow the beta-workflow contract:

- Branch off `main` to `beta/user-msg-replay-unification`.
- All code changes land on the beta branch; **no direct pushes to main**.
- Spec mutations (state advances, README sync, tasks check-offs) commit to **main** via the spec-doc split rule (per memory `feedback_commit_all_split_code_docs.md`).
- Fetch-back from beta → main happens at `verified` state (M8-4), not before.
- Daemon restart requires explicit user consent (per memory `feedback_restart_daemon_consent.md`).

The implementer is authorized to:

- Edit any file enumerated in `design.md` § Critical Files.
- Add the new test files enumerated in M6.
- Refactor adjacent code only if blocking (e.g. test seam needs a small `__test__` export addition that isn't already there).

The implementer is NOT authorized to:

- Touch `specs/compaction/narrative-quality/` (sibling spec; depends on this one shipping first but doesn't share code with it).
- Restructure `SessionCompaction.run` chain semantics or kind ordering — this spec is purely additive.
- Merge `compactWithSharedContext` legacy path into `SessionCompaction.run` — DD-9 explicitly preserves the separation.
- Change provider behavior (codex / claude / etc) — replay helper is provider-agnostic.

## Required Reads

Before writing the first line of code:

1. **`proposal.md`** — full bug timeline + 2026-05-09 incident evidence.
2. **`design.md`** — DD-1 through DD-9 are load-bearing. Read all of them.
3. **`spec.md`** — `### Requirement:` and `#### Scenario:` blocks define correctness contract.
4. **`data-schema.json`** — exact type signatures for ReplayInput / ReplayResult / ReplayTelemetryEvent.
5. **`sequence.json`** — three sequence diagrams (rebind / manual / exception) showing helper integration points.
6. **`c4.json`** — component-level view of the call sites.
7. **`packages/opencode/src/session/prompt.ts:1484-1554`** — the inline replay block being deleted. Understand it first; it is the canonical reference behaviour.
8. **`packages/opencode/src/session/compaction.ts:1700-1859`** — `SessionCompaction.run` chain walker. The helper integrates here.
9. **`packages/opencode/src/session/compaction.ts:1911-1948`** — `defaultWriteAnchor`, primary integration point.
10. **`packages/opencode/src/session/compaction.ts:1867-1893`** — `injectContinueAfterAnchor`, target of M3 rewrite.
11. **`packages/opencode/src/session/compaction.ts:872-885`** — `INJECT_CONTINUE` static table being deleted (kept as fallback when feature flag off).
12. **`packages/opencode/src/session/compaction-run.test.ts`** — existing `__test__.setAnchorWriter` pattern to mirror.
13. **`memory/feedback_no_silent_fallback.md` (AGENTS.md rule 1)** — every helper branch must log explicitly.

## Stop Gates In Force

These conditions immediately halt implementation and require user consultation:

1. **Schema break in MessageV2.User / MessageV2.Part** — replay helper assumes the existing shapes. If the migration of either type happens mid-implementation, pause and re-evaluate.
2. **Storage backend change** — replay relies on `Session.updateMessage` / `Session.updatePart` / `Session.removeMessage`. If storage router behaviour changes (e.g. async batching), pause.
3. **Cooldown gate interaction unclear** — if you discover the cooldown gate fires AFTER the helper has run a partial mutation, pause; we may need to integrate cooldown awareness.
4. **Production regression detected** — if M7 manual reproduction shows the runloop entering a NEW failure mode (not silent-exit, but something else), stop and escalate. Roll back via `enableUserMsgReplay = false` flag.
5. **More than 4 call sites discovered** — design assumed 4 commit paths. If grep reveals a 5th (or 6th), update design.md before proceeding.

## Execution-Ready Checklist

Before claiming a task done:

- [ ] All Required Reads completed.
- [ ] Code changes pass `bun test` for the affected packages (compaction + prompt + storage).
- [ ] New test fixtures (M6) added; each call site exercised.
- [ ] `tweaks.cfg` includes the new flag; default `true`; toggling to `false` does NOT crash anything (graceful degrade to pre-fix behaviour).
- [ ] Telemetry verified: `compaction.user_msg_replay` events appear with full schema; `recentEvents.observed` is never `"unknown"` post-fix.
- [ ] `loop:no_user_after_compaction` log line stays present in code (diagnostic) but does NOT trigger in any of the M6 fixtures.
- [ ] `prompt.ts:1484-1554` deleted (inline replay block); replaced by helper firing inside `SessionCompaction.run`.
- [ ] `INJECT_CONTINUE` table replaced by stream-driven runtime decision; fallback table only reachable with feature flag off.
- [ ] `design.md` Critical Files section unchanged (no surprise file edits beyond the listed ones).
- [ ] Per-call-site sanity: verbose dry-run of empty-response / overflow / rebind / provider-switch each shows the expected helper invocation in debug.log.

## Commit Strategy

Per memory `feedback_commit_all_split_code_docs.md`:

- **Code commits** (under `packages/opencode/`) → `beta/user-msg-replay-unification` branch only.
- **Spec commits** (under `specs/compaction/user-msg-replay-unification/`) → `main` directly with `spec_*` tooling.
- Don't mix the two in a single commit. If you find yourself wanting to, split.

Suggested commit cadence:

1. M1 (helpers): one commit `feat(session): add replayUnansweredUserMessage helper + snapshot helper`.
2. M2 (caller wiring): one commit per call site (4 commits) for clean revert affordance.
3. M3 (INJECT_CONTINUE replacement): one commit `refactor(session): runtime-decide Continue injection`.
4. M4 (telemetry + side-fix): one commit `feat(session): compaction.user_msg_replay telemetry + thread observed through publishCompactedAndResetChain`.
5. M5 (tweaks): one commit `feat(tweaks): register compaction.enable_user_msg_replay flag`.
6. M6 (tests): one commit per fixture file; or batched `test(session): user-msg-replay coverage across all call sites`.
7. M7 evidence: spec-side, no code commit; spec_record_event entries in `events/`.
8. M8 sync: spec-side promote + sync.

## Open Questions Resolved

None blocking. See design.md § Open questions.

## Rollback

If post-merge incidents occur:

1. Hot toggle: `tweaks.cfg` set `compaction.enable_user_msg_replay=false`. No daemon restart required (Tweaks is hot-reloaded). Behaviour reverts to pre-fix; bug returns but symptoms are known and bounded.
2. Cold revert: revert the entire merge commit; `git revert -m1 <merge_sha>` on `main`. Spec stays at `verified` (don't down-grade state on revert).
3. Spec quarantine: if defect was in design (not implementation), set `.state.json` mode to `revise` to mark the spec for re-design.
