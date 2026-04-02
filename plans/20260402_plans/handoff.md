# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Implementation must preserve the distinction between local semantic context and provider-issued remote continuity.
- No silent fallback may preserve stale remote refs across identity change.

## Required Reads

- `proposal.md`
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`
- `docs/events/event_20260402_legacy_session_stateless_replay.md`
- `docs/events/event_20260402_text_part_live_instrumentation.md`

## Current State

- Root cause investigation has already identified Codex/OpenAI-style Responses as the active failing surface.
- Replay gate account-aware fix exists for `message-v2`, but broader continuation/flush lifecycle is not yet formalized.
- This plan packages the next-step architecture so implementation can extend beyond one bug fix into a provider-aware identity-change framework.

## Stop Gates In Force

- Stop if implementation requires checkpoint schema changes not represented in this plan.
- Stop if a provider cleanup path would silently discard local semantic context instead of only remote continuity.
- Stop if a non-Codex provider needs behavior that conflicts with the shared lifecycle contract.
- Return to plan mode if rollout expands beyond Codex/OpenAI first-slice scope.

## Build Entry Recommendation

- Start from Task 1.1–1.3 to lock the lifecycle contract.
- Then implement Codex/OpenAI-specific provider hook + sticky-state cleanup before touching generalized provider adapters.
- Treat checkpoint warm-start composition as a distinct slice after the remote flush boundary is explicit.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review implementation against the proposal’s effective requirement description.
- Confirm account-switch continuation no longer reuses invalid remote refs.
- Report what remains provider-specific and what became lifecycle-framework generic.
- Do not expose raw chain-of-thought; report auditable conclusions, tests, and observed runtime evidence only.
