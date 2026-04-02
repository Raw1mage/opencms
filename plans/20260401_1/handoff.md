# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- The workstream should be treated as a shared Google token refresh enhancement, not a Gmail-only patch.
- The implementation should use daemon-start background sweep semantics, not a long-lived polling loop.

## Required Reads

- `proposal.md`
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from `implementation-spec.md`.
- Return to plan mode before coding if the implementation needs a new lifecycle hook or a broader auth contract change.
- Do not create a brand-new sibling plan unless the user explicitly requests it, or explicitly approves an assistant proposal to branch.
- Fail fast if the daemon-start hook cannot be located without introducing a new fallback mechanism.

## Current State

- Beta admission completed.
- Authoritative main surface remains `/home/pkcs12/projects/opencode` on branch `main`.
- Disposable implementation surface is `/home/pkcs12/projects/opencode-worktrees/google-mcp-refresh-daemon-sweep` on branch `beta/google-mcp-refresh-daemon-sweep`.
- Planning/docs remain dirty only in the authoritative main worktree and were intentionally not copied into the beta worktree.

## Build Entry Recommendation

- Start implementation inside `/home/pkcs12/projects/opencode-worktrees/google-mcp-refresh-daemon-sweep`.
- Read plan/docs from `/home/pkcs12/projects/opencode/plans/20260401_1/` and keep `docs/events/` / `specs/architecture.md` updates anchored to `/home/pkcs12/projects/opencode`.
- First code slice: add serialized shared refresh coordination in `packages/opencode/src/mcp/apps/gauth.ts`, then wire daemon-start sweep from `packages/opencode/src/mcp/index.ts`.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
