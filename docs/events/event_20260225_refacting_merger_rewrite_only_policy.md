# Event: refacting-merger rewrite-only policy hardening

Date: 2026-02-25
Status: Done

## Decision

- Harden `refacting-merger` MCP policy to **strictly forbid** direct upstream code transfer methods:
  - `git cherry-pick`
  - `git merge`
  - direct patch transplant
- Standardize execution mode to **rewrite-only refactor-port**:
  - analyze upstream commit behavior intent
  - re-implement behavior on cms architecture
  - validate with focused tests

## Changes

- Updated `packages/mcp/refacting-merger/src/index.ts`:
  - bumped server version to `0.1.1`
  - added strict policy metadata (`rewrite-only`, forbidden actions)
  - changed planning markdown generation to include policy guardrails
  - changed execution queue wording from "integrate" to rewrite/refactor-port semantics
  - updated wizard execution hints to explicitly prohibit cherry-pick/merge
  - adjusted default decision recommendation toward `ported|skipped` (instead of recommending direct integration)
  - clarified ledger meaning: `integrated` = behavior already present in cms, not merge/cherry-pick
  - added hard guard in `refacting_merger_update_ledger`: reject inputs containing `git cherry-pick` or `git merge` text in `roundTitle` / `entries.note`

## Validation

- `bun run packages/mcp/refacting-merger/src/index.ts --help`
- `bun test packages/opencode/test/project/project.test.ts`
