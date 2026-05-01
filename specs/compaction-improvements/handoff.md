# Handoff: compaction-improvements

## Execution Contract

- Execute phase-by-phase from `tasks.md`; keep TodoWrite aligned with the current phase only.
- After each task completion, update the matching checkbox, run plan-sync, and record validation evidence.
- Do not add fallback mechanisms. Prefer explicit errors, explicit telemetry, and durable evidence.
- Read `specs/architecture.md` before modifying compaction/session/provider boundaries.

## Required Reads

- `specs/architecture.md`
- `specs/compaction-improvements/proposal.md`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/prompt.ts`
- Relevant tests under `packages/opencode/test/session/`

## Stop Gates In Force

- Provider request path for codex Mode 1 contradicts the proposed request shape.
- A change would require silent fallback for provider/account/model identity.
- Big-content storage requires destructive migration of existing session data.
- Validation reveals compaction loop/retry behavior that cannot be bounded by existing cooldown/anchor semantics.

## Validation Plan

- Focused unit tests for changed compaction/session files.
- Typecheck for touched packages when implementation reaches cross-package boundaries.
- Event log records commands, outcomes, and architecture sync status.

## Execution-Ready Checklist

- [x] Proposal records user requirement and scope.
- [x] Design artifacts identify boundaries and risks.
- [x] Tasks are phase-scoped and dependency ordered.
- [x] Validation plan is defined before implementation.
