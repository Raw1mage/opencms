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
- Remaining high-value backlog is still prioritized as: Claude Native / `claude-provider` -> runtime/context optimization hardening -> rebind/continuation/session hardening -> remaining provider-manager completion work.
- The original Claude Native first slice was too large for a bounded patch and has now been decomposed into beta bootstrap -> source scaffold -> auth bridge/loader wiring -> minimum viable activation.

## Build Entry Recommendation

- Start at `2.1` in `tasks.md`: restate and verify the beta authority tuple, then create the disposable beta branch/worktree before any code-bearing work.
- After beta bootstrap, continue with the narrower Claude Native sub-stages in Sections 3–5.
- Do not touch later runtime/session/provider-manager slices until the Claude Native sub-plan is either restored or returned to plan mode with a concrete blocker.

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
