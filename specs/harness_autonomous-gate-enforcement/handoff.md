# Handoff: harness_autonomous-gate-enforcement

## Execution Contract

Implement the four DDs in dependency order: DD-3 (remove false gate, lowest risk,
independent) → DD-1 + DD-2 (core gate enforcement + the key, shared suspend
machinery) → DD-4 (paralysis backstop). Reuse the EXISTING suspend primitives
(`waiting_user` + `NON_RESUMABLE_WAITING_REASONS` + the `RejectedError → blocked`
path) — do not invent a new subsystem. This is a sensitive change to the
autonomous supervisor loop: every phase ships with tests before moving on.

## Required Reads

- `proposal.md` — the three stacked defects + the R5 spec-vs-code divergence.
- `design.md` — DD-1..DD-4, verified code anchors, resolved design questions.
- `spec.md` — requirements + scenarios (the acceptance surface).
- `harness/autonomous-opt-in` R5 (`specs/harness/autonomous-opt-in/proposal.md:55`,
  `spec.md:114`) — the owning requirement this implements.
- `packages/opencode/src/session/workflow-runner.ts:267-277,393-408,568-646,637-640`
- `packages/opencode/src/session/todo.ts:61-94,258,299`; `tool/todo.ts`
- `packages/opencode/src/session/prompt.ts:468-483,2586-2960`
- `packages/opencode/src/session/index.ts:196,427`

## Stop Gates In Force

- Back up `~/.config/opencode/` (repo CLAUDE.md whitelist) BEFORE the first code
  edit. Backup ≠ restore — never overwrite live config without explicit request.
- Daemon lifecycle ONLY via `system-manager:restart_self` / `webctl.sh restart`.
  No manual `serve`/`kill`/`systemctl`.
- No `rm` without `git ls-files` first; no destructive tool calls unprompted.
- This change alters how autonomous sessions stop — verify against the original
  failure shape (doc todo mentioning "architecture") before declaring done.

## Execution-Ready Checklist

- [ ] Config backed up
- [ ] Phase 1 (DD-3) lands + tests green
- [ ] Phase 2 (DD-1+DD-2) lands + tests green
- [ ] Phase 3 (DD-4) lands + tests green
- [ ] Full session suite green; daemon restarted via restart_self; end-to-end check

## Validation

- Unit: `workflow-runner.test.ts`, `session-autonomous.test.ts`,
  `model-orchestration.test.ts`, todo tests, paralysis/prompt tests.
- Scenario coverage maps 1:1 to `spec.md` `#### Scenario:` blocks.
- E2E: reproduce the original stuck shape → confirm clean suspend, no false halt;
  confirm a genuine no-gate spin still halts (backstop preserved).
