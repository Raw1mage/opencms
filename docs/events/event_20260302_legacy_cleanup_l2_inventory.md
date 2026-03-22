# Event: legacy cleanup L2 — repo .opencode inventory and action plan

Date: 2026-03-02
Status: Done

## Goal

- Inventory repo `.opencode/` artifacts and classify keep/remove/migrate candidates.
- Avoid deleting active runtime dependencies before replacement paths are in place.

## Inventory Summary

- Tracked files under repo `.opencode/` (before L2): **18**
- Runtime dependency before L2B: project instruction loader read `.opencode/AGENTS.md`.

## Classification

### A) Keep for now (active runtime) — superseded by L2B

1. `.opencode/AGENTS.md`
   - (Historical) previously active dependency in `session/instruction.ts`.

### B) Migrate then remove (legacy payload, not runtime-loaded)

1. `.opencode/command/*.md` (5 files)
2. `.opencode/agent/*.md` (4 files)
3. `.opencode/tool/*` (4 files)
4. `.opencode/themes/mytheme.json`
5. `.opencode/opencode.jsonc`
6. `.opencode/env.d.ts`

Notes:

- No direct runtime source references to these concrete files were found under `packages/opencode/src`.
- Some historical references exist in docs/events and archived records only.

## Proposed L2 Execution Plan

1. **L2A (safe structural migration)**
   - Move reusable examples from repo `.opencode/*` into `templates/**` (or `docs/examples/**`) as explicit template assets.
   - Update docs to point to new canonical template paths.

2. **L2B (runtime loader migration)**
   - Change instruction loader from `<project>/.opencode/AGENTS.md` to canonical `<project>/AGENTS.md` and migrate project policy file accordingly.

3. **L2C (deletion pass)**
   - Delete migrated `.opencode/*` payload files after references/docs are updated.

## L2A Execution Result (applied)

- Migrated non-runtime repo payload from root `.opencode/` to template examples:
  - New canonical example path: `templates/examples/project-opencode/**`
  - Migrated categories:
    - `command/*.md`
    - `agent/*.md`
    - `tool/*`
    - `themes/mytheme.json`
    - `opencode.jsonc`, `env.d.ts`
- After migration, root `.opencode/` tracked content is reduced to:
  - `.opencode/AGENTS.md` (runtime-active)

This keeps active loader contract intact while removing legacy payload from repo-root runtime surface.

## L2B Execution Result (applied)

- Migrated project policy file path:
  - `.opencode/AGENTS.md` -> `AGENTS.md`
- Updated runtime instruction loader:
  - `packages/opencode/src/session/instruction.ts` now reads `<project-root>/AGENTS.md`.
- Updated related tests:
  - `packages/opencode/test/session/instruction.test.ts`
- Updated migrated examples README to reflect new canonical project instruction path.

Post-L2B state:

- Root `.opencode/` runtime dependency removed.
- Remaining repo `.opencode/` tracked files: **0**.

## L2C Documentation Alignment (applied)

- Updated active governance/spec docs to canonical project instruction path:
  - `AGENTS.md` runtime-sync checklist now references `$XDG_CONFIG_HOME/opencode/skills/**` instead of `.opencode/skills/**`.
  - `specs/system-prompt/hooks.md` updated project AGENTS path to `<project-root>/AGENTS.md`.

## Guardrail

- L2B guardrail satisfied: `.opencode/AGENTS.md` deletion is now safe after validation.
