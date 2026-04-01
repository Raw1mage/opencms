# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Build/implementation agent must not resume from discussion memory alone when this plan package is available.
- User-visible progress and decision prompts must reuse the same planner-derived todo naming.
- Build/implementation agent must recover one slice at a time in the exact order recorded in `tasks.md` unless the planner is updated first.
- Historical branches and SHAs are evidence sources only; they are not merge authority.

## Required Reads

- `proposal.md` (including original requirement wording, revision history, and effective requirement description)
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from `implementation-spec.md`.
- Return to plan mode before coding if a new implementation slice is not represented in planner artifacts.
- Do not create a brand-new sibling plan unless the user explicitly requests it, or explicitly approves an assistant proposal to branch.
- Stop immediately if a slice appears to require broad branch merge, destructive git operations, or authority assumptions not backed by the rewritten beta-workflow contract.

## Current State

- Recovery inventory is complete.
- Restored already: codex websocket / WS-HTTP / llm packet main path, `模型提供者` provider-list UI slice, and `claude-cli` provider registration fix.
- Claude Native / `claude-provider` minimum slice is now complete on `beta/provider-list-commit`, including beta bootstrap, source scaffold, auth bridge/loader wiring, minimum activation validation, and local commit `2a293ce5e` (`recovery(claude-native): restore native auth bridge scaffold`).
- `6.1` runtime/context hardening reconstruction is now complete; the remaining work in this group is decomposed into `6.2a` lazy tool loading/adaptive auto-load, `6.2b` small-context compaction truncation, and `6.2c` toolcall schema/error-recovery guidance.
- `6.2a` lazy tool loading / adaptive auto-load is now complete on `beta/provider-list-commit`, including the follow-up correctness fixes for always-present tool IDs and in-place `tool_loader` description mutation.
- `6.2b` small-context compaction truncation safeguards are now complete on `beta/provider-list-commit`, with focused test coverage in `packages/opencode/src/session/compaction.test.ts`.
- `6.2c` toolcall schema / error-recovery guidance is now complete on `beta/provider-list-commit`; together with `6.2a` and `6.2b`, the `6.x` runtime/context optimization hardening group is functionally complete.
- `7.1` reconstruction shows the first still-missing session-hardening gap is not the whole continuation stack but the narrower rebind checkpoint durability + safe checkpoint injection path (`compaction.ts` + `prompt.ts`).
- `7.2a` rebind checkpoint durability + safe checkpoint injection is now complete on `beta/provider-list-commit`, with focused checkpoint metadata/injection/prune tests passing; `7.2b` currently has no remaining proven gap and stays deferred unless new evidence appears.
- Remaining high-value backlog is now prioritized as: provider-manager closure remediation (`8.4*`), re-validation (`8.5`), and retrospective closure (`9.2`/`9.3`).
- `8.1` provider-manager reconstruction identified model-manager visibility/favorites semantics as the first remaining webapp gap, and `8.2a` is now completed on `beta/provider-list-commit`.
- `8.2b` dialog reopen geometry cleanup is intentionally deferred by default and should resume only when new reopen-geometry defect evidence appears.
- `8.3` focused validation completed, but closure evidence was insufficient for finalize: app typecheck failed, and direct execution coverage for the hidden-provider localStorage path is still missing.
- User approved remediation instead of finalize, so plan closure now requires `8.4a`/`8.4b`/`8.5` before `9.2`, `9.3`, and the approval-gated finalize recommendation path in `10.x`.
- Deferred Claude Native backlog is explicit: native refresh/login/logout lifecycle, native ↔ `accounts.json` two-way sync, and DD-9/full native transport revival.

## Build Entry Recommendation

- If resuming build work instead of finalize, start at `8.4a` in `tasks.md`: remediate target `dialog-select-model.tsx` readiness/type issues.
- Then run `8.4b` to add direct hidden-provider execution coverage, and `8.5` to re-run focused provider/webapp validation before returning to `9.2` / `9.3` / `10.1`.
- Reuse the existing admitted beta surface (`beta/provider-list-commit`) only if authority is re-verified and the user explicitly wants to continue on the same beta branch; otherwise stop for a new beta decision.
- Treat Claude Native as functionally restored for the narrow auth-init path; do not reopen deferred native lifecycle/full-transport backlog unless the user explicitly reprioritizes it.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
