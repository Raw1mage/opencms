# Bug Report: Tool registry/write unavailable and patch success not persisted

## Status

- CLOSED (2026-06-11, soak passed since 2026-06-05, no recurrence) — was OBSERVING — core `apply_patch` persistence issue appears fixed; deployed runtime has post-write readback verification and gitignored-path hinting.
- Observing since: 2026-06-05
- Exit → closed/: no recurrence of `apply_patch` success with missing bytes after soak / further sessions.
- Regress → open: any confirmed `apply_patch` success where later `read` cannot observe the written bytes.

## Summary

During a Warroom plan-builder session, the assistant attempted to use a `write` tool after generating drawmiat artifacts. `tool_loader` reported that `write` does not exist in the current tool pool. More seriously, multiple earlier `apply_patch` calls reported `Success` for new/updated files under `/home/pkcs12/projects/warroom`, but subsequent `read`, `glob`, and `git status` showed those files were not present.

## Current Assessment (2026-06-05)

- Core persistence concern appears fixed: `apply_patch` now performs post-write readback verification for add/update/delete and fails loudly with `apply_patch post-write verification failed` if bytes are not observable.
- The 2026-05-26 confusion pattern is specifically acknowledged in `apply_patch` output: gitignored paths are marked as `gitignored — not in git status`, with a hint to verify via `read` instead of `git status`.
- Regression coverage exists and passes: `bun test packages/opencode/test/tool/apply_patch.test.ts` → `34 pass / 0 fail`; key case is `post-write verification makes read-after-apply observable for markdown files`.
- `tool_loader({ tools: ["write"] })` still fails in the current session, but that is now treated as a separate tool-exposure/contract question because the active coding workflow uses always-present `apply_patch`.

## Environment

- Date: 2026-05-26 Asia/Taipei
- Main repo: `/home/pkcs12/projects/warroom`
- Issue repo: `/home/pkcs12/projects/opencode`
- Role: Main Agent
- Tool chain involved: `tool_loader`, `apply_patch`, `read`, `glob`, `bash`, `drawmiat_*`

## Expected Behavior

- `tool_loader({tools:["write"]})` should either load a registered file-write tool or provide a clear replacement path if writing is intentionally unavailable.
- `apply_patch` returning `Success` should mean the target file changes are visible to later `read`, `glob`, and `git status` calls in the same worktree.

## Actual Behavior

- `tool_loader` returned: `ERROR — tools not found: write`.
- `apply_patch` returned success for files such as:
  - `/home/pkcs12/projects/warroom/plans/ai_anomaly-grafana-llm/design.md`
  - `/home/pkcs12/projects/warroom/plans/ai_anomaly-grafana-llm/tasks.md`
  - `/home/pkcs12/projects/warroom/plans/ai_anomaly-grafana-llm/implementation-spec.md`
  - `/home/pkcs12/projects/warroom/docs/events/event_20260526_ai_anomaly_grafana_llm.md`
- Later `read` on `/home/pkcs12/projects/warroom/plans/ai_anomaly-grafana-llm/README.md` returned file not found.
- `glob` for `plans/*` under `/home/pkcs12/projects/warroom` returned no files.
- `git status --short` in `/home/pkcs12/projects/warroom` showed unrelated pre-existing changes but none of the plan/event files reported as created by `apply_patch`.

## Reproduction Outline

1. In `/home/pkcs12/projects/warroom`, call `specbase_plan_create` for slug `ai/anomaly-grafana-llm`.
2. Use `apply_patch` to add/update plan files under `/home/pkcs12/projects/warroom/plans/ai_anomaly-grafana-llm/`.
3. Observe `apply_patch` success responses.
4. Call `read` or `glob` for the same paths.
5. Observe missing files.
6. Run `git status --short`; observe no corresponding plan/event changes.

## Impact

- The agent may falsely believe plan artifacts or docs were written.
- Validation and final reporting become unreliable because tool success does not match filesystem state.
- Work may continue based on stale or non-existent files.

## Evidence Snippets

- `tool_loader({"tools":["write"]})` returned `tools not found: write`.
- `read` returned `File not found` for `/home/pkcs12/projects/warroom/plans/ai_anomaly-grafana-llm/README.md` after previous plan creation and patch success messages.
- `git status --short` did not list the expected plan/event files.

## Severity

High for coding/planning reliability. A success response from a file mutation tool must be durable and immediately observable.

## Suggested Investigation

- Check whether `apply_patch` is executing in an overlay/sandbox different from `read`/`glob`/`bash`.
- Check whether absolute path patching outside the session cwd is being acknowledged but discarded.
- Check whether `specbase_plan_create` returns a textual path while writing to a different backing store.
- Clarify tool registry expectations: if `write` is deprecated or unavailable, `tool_loader` should advertise the supported replacement.

## Observing Notes

- If only `write` remains unavailable but `apply_patch` remains durable/read-observable, open a separate tool contract issue rather than reopening this persistence issue.
