# Branch Strategy

## Purpose

- Provide a phased test-branch strategy for reconstructing missing functionality on latest `HEAD`.
- Reduce blast radius by aligning branches to reconstruction waves instead of mixing unrelated slices.

## Branching Principles

- Base every phase branch on the latest authoritative `main` at the moment the phase starts.
- Prefer one test branch per wave unless an analysis gate or high-risk slice needs its own isolated branch.
- Branches are execution surfaces, not long-lived truth. After fetch-back / merge-back, disposable test branches should be removed.
- `reconstruction-map.md` is the source of truth for default wave order.

## Beta Authority Fields

- `mainRepo`: `/home/pkcs12/projects/opencode`
- `mainWorktree`: `/home/pkcs12/projects/opencode`
- `baseBranch`: `main`
- `implementationRepo`: `/home/pkcs12/projects/opencode`
- `implementationWorktree`: `/home/pkcs12/projects/opencode-worktrees/beta-restore-missing-commits`
- `implementationBranch`: `beta/restore-missing-commits`
- `docsWriteRepo`: `/home/pkcs12/projects/opencode`
- Admission status: passed
- Branch origin: created from `main` at `58d217116c808014ba5a5aba2d22ebddb6c73a9a`
- Known blocker for later fetch-back/finalize: authoritative `mainWorktree` currently has dirty files under `docs/events/event_20260401_cms_codex_recovery.md` and `plans/20260402_commits/`

## Suggested Branch Naming

- `test/reconstruct-wave0-analysis`
- `test/reconstruct-wave1-shell-tooling`
- `test/reconstruct-wave2-runtime-stability`
- `test/reconstruct-wave3-init-onboarding`
- `test/reconstruct-wave4-claude-chain`
- `test/reconstruct-wave5-docs-final-state`

If a wave needs finer isolation:

- `test/reconstruct-r2-session-stability`
- `test/reconstruct-r4-marketplace-residue`
- `test/reconstruct-r5-transport-audit`

## Wave Contracts

### Wave 0 — Analysis Gates / Shared Setup

- Default branch: `test/reconstruct-wave0-analysis`
- Entry criteria:
  - latest `main` baseline refreshed
  - plan artifacts aligned
- Work:
  - resolve `analysis_gate` and `dedup_gate` items
  - write supersession conclusions
  - decide any `keep_deprecated_candidate`
- Exit criteria:
  - each gate item has a written conclusion
  - `reconstruction-map.md` updated
- Fetch-back condition:
  - only after conclusions are reflected in plan artifacts

### Wave 1 — Shell / Tooling / Copilot

- Default branch: `test/reconstruct-wave1-shell-tooling`
- Entry criteria:
  - Wave 0 gates relevant to R1/R3/R6 closed
- Work:
  - R1 branding
  - R3 tool loading/schema ergonomics
  - R6 Copilot reasoning variants
- Exit criteria:
  - visible regressions fixed
  - no conflict with current shell/tooling direction
- Fetch-back condition:
  - validation evidence for shell/tooling/coplayout completed

### Wave 2 — Runtime Stability

- Default branch: `test/reconstruct-wave2-runtime-stability`
- Entry criteria:
  - core session/rebind decisions stable
- Work:
  - R2.1-R2.4, R2.6
  - R7.1 observability checkpoints
- Exit criteria:
  - targeted runtime evidence collected
  - no regression against latest session architecture
- Fetch-back condition:
  - runtime validation / tests / event evidence updated

### Wave 3 — Init / Onboarding / Marketplace

- Default branch: `test/reconstruct-wave3-init-onboarding`
- Entry criteria:
  - `db1050f06` dedup split closed
- Work:
  - R4.1-R4.4
- Exit criteria:
  - init / onboarding / marketplace residues isolated and reconstructed on current `HEAD`
- Fetch-back condition:
  - UX / flow evidence and any environment-side caveats are documented

### Wave 4 — Claude Capability Chain

- Default branch: `test/reconstruct-wave4-claude-chain`
- Optional sub-branches when needed:
  - `test/reconstruct-r5-transport-audit`
  - `test/reconstruct-r5-merge-residue`
- Entry criteria:
  - refs/support baseline decided
  - transport/residue analysis gates closed or explicitly deferred
- Work:
  - R5.1-R5.9 latest workable chain reconstruction
- Exit criteria:
  - newest workable Claude capability chain achieved or justified keep-deprecated decisions recorded
- Fetch-back condition:
  - end-to-end Claude validation and docs/spec sync completed

### Wave 5 — Docs Final State

- Default branch: `test/reconstruct-wave5-docs-final-state`
- Entry criteria:
  - preceding implementation waves settled enough to know final outcomes
- Work:
  - R8.1-R8.5
- Exit criteria:
  - docs/specs/plans/events aligned with final chosen reconstruction outcomes
- Fetch-back condition:
  - artifact coherence verified

## Branch Cleanup Rule

- Any `test/*` branch created for a wave is disposable.
- After fetch-back / merge-back to the authoritative line, delete the corresponding test branch and disposable worktree before declaring that wave complete.

## Replan Triggers

- A wave uncovers a new mixed bucket not represented in `reconstruction-map.md`
- A supposed rebuild slice becomes a keep-deprecated candidate
- A later wave invalidates an earlier supersession conclusion
- A branch accumulates too many unrelated slices and must be split
