# Bug Report: Duplicate tool calls and apply_patch retry friction during agent run

## Status

- CLOSED (2026-06-11, soak passed since 2026-06-05, no recurrence) — was OBSERVING — old high-noise duplicate-denial symptom appears resolved/degraded into low-impact runtime dedup.
- Observing since: 2026-06-05
- Exit → closed/: no recurrence of user-visible `Duplicate tool call with same arguments denied` / noisy `apply_patch` retry friction after soak.
- Regress → open: duplicate tool calls again surface as noisy user-visible denial/retry loops rather than quiet runtime dedup.

## Summary

During a `llmserver` implementation run, the agent repeatedly emitted duplicated tool calls in the same turn. The runtime correctly denied duplicate calls, but the behavior created noisy transcripts, confusing progress signals, and one failed `apply_patch` retry path that required manual recovery.

## Current Assessment (2026-06-05)

- Runtime now has two-layer dedup: in-flight parallel dedup plus same-turn DB-based dedup.
- `apply_patch({ input })` and `apply_patch({ patchText })` are canonicalized to the same dedup signature.
- Regression coverage passes: `bun test packages/opencode/src/session/tool-invoker.dedup.test.ts` → `21 pass / 0 fail`.
- Recent logs no longer show old `Duplicate tool call with same arguments denied` user-visible symptom; they do show `dedup: short-circuited identical tool call`, indicating duplicate calls may still occasionally happen but are quietly short-circuited.
- Related compaction/continuation/paralysis fixes likely reduced the upstream cause: sessions are less likely to get stuck repeatedly emitting the same action after continuation/compaction drift.

## Environment

- Date: 2026-05-29
- Main repo under work: `/home/pkcs12/projects/llmserver`
- Bug report target repo: `/home/pkcs12/projects/opencode`
- Agent role: Main Agent / orchestrator
- Tools involved: `multi_tool_use.parallel`, `read`, `grep`, `apply_patch`, `todowrite`, `bash`

## Impact

- Duplicate read/patch/todo calls were sent with identical arguments in one turn.
- Runtime emitted `Duplicate tool call with same arguments denied` and reused/blocked results.
- Transcript became harder to inspect because user-visible narration and duplicate-denial messages interleaved with real progress.
- One failed `apply_patch` had to be followed by a fresh `read` and smaller patch, which is expected, but duplicate emission around the patch made the recovery harder to audit.

## Evidence

Observed messages during the run included:

- `Duplicate tool call with same arguments denied: functions.glob`
- `Duplicate tool call with same arguments denied: functions.read`
- `Duplicate tool call with same arguments denied: functions.apply_patch`
- `Duplicate tool call with same arguments denied: functions.todowrite`
- `[already executed — reusing result] Success. Updated the following files: ...`
- `apply_patch verification failed: Failed to find expected lines ... Before retrying, call read on the target file ...`

Representative duplicated calls:

- `multi_tool_use.parallel` contained two identical `glob` calls for `issues/*.md` and two identical `glob` calls for `AGENTS.md`.
- `multi_tool_use.parallel` contained repeated identical `apply_patch` payloads for `src/llm-sidecar/src/main.rs`, `llmctl.sh`, `scripts/llmserver_config.py`, `specs/architecture.md`, `plans/driver_framework_switching/tasks.md`, `.state.json`, and `implementation-spec.md`.
- The final `todowrite` was accidentally sent twice with identical todo payloads.

## Reproduction

1. Start a main-agent coding/documentation run with multiple parallel tool calls.
2. Ask the agent to continue a multi-step implementation.
3. Observe `multi_tool_use.parallel` payloads where identical tool calls appear more than once.
4. Observe runtime duplicate-denial messages and/or `[already executed — reusing result]` outputs.
5. Trigger an `apply_patch` context mismatch and watch recovery interleave with duplicate tool-denial noise.

## Expected Behavior

- The agent or tool dispatcher should prevent identical tool calls from being emitted inside one `multi_tool_use.parallel` batch.
- If the provider duplicates tool-call JSON during streaming/retry, the UI should collapse or annotate the duplicate as transport/model duplication rather than normal agent intent.
- `apply_patch` retry recovery should remain visually clear: failed patch → read exact file → new smaller patch.

## Actual Behavior

- Identical calls were sent in the same turn and denied by the dispatcher.
- Denial messages appeared inline and made it look like the agent was fighting the tool layer.
- Some successful duplicate `apply_patch` attempts returned `[already executed — reusing result]`, which is safe but confusing when reviewing what actually changed.

## Suspected Causes

- The model may have generated duplicate entries inside a single `multi_tool_use.parallel` call.
- The runtime duplicate-call guard is working, but its feedback is surfaced as regular tool output rather than as a compact diagnostic.
- There may be no pre-dispatch de-duplication for `multi_tool_use.parallel` child calls.
- `apply_patch` idempotency/reuse reporting is safe but not optimized for human auditability.

## Acceptance Criteria

- Identical child calls inside one `multi_tool_use.parallel` batch are de-duplicated before dispatch, or rejected as a single compact batch-level warning.
- Duplicate-denial output is grouped/collapsed so it does not obscure successful progress.
- `apply_patch` duplicate/reuse responses clearly state whether bytes were changed in this attempt or reused from a previous identical payload.
- Documentation or system prompt guidance warns agents not to include duplicate entries in `multi_tool_use.parallel`.

## Next-Session Checklist

- Inspect `multi_tool_use.parallel` dispatch code for child-call de-duplication opportunities.
- Inspect duplicate-call guard messaging for UI grouping/collapsing.
- Inspect `apply_patch` idempotency/reuse path and clarify output wording.
- Add a regression test for identical child calls in one parallel batch.

## Observing Notes

- Do not reopen merely because logs show `dedup: short-circuited identical tool call`; that indicates the guard is working.
- Reopen only if duplicate calls again become user-visible noisy denial/retry loops or cause actual patch recovery ambiguity.
