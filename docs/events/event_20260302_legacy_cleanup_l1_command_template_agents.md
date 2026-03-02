# Event: legacy cleanup L1 — remove orphan command template AGENTS

Date: 2026-03-02
Status: Done

## Background

- `packages/opencode/src/command/template/AGENTS.md` was suspected legacy/orphan artifact.
- Runtime command loader (`packages/opencode/src/command/index.ts`) only imports:
  - `template/initialize.txt`
  - `template/review.txt`

## Decision

- Remove `packages/opencode/src/command/template/AGENTS.md` in L1 cleanup.

## Validation

- Searched runtime references to `command/template/AGENTS.md` and found no code-path dependency.
- Remaining command template files (`initialize.txt`, `review.txt`) are unchanged.

## Next

- Continue L2 inventory for repo `.opencode/` artifacts (keep/remove/compat categories).
