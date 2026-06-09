# Handoff

## Execution Contract

- Build in **implementation order** (tasks.md): event index → query surface → refresh → AGENTS.md wiring → MEMORY.md migration → empty-last. Do not reorder; the destructive step (empty MEMORY.md) is gated on migration verification.
- Engine changes land in the **specbase repo** (`/home/pkcs12/projects/specbase/`); AGENTS.md / UNIFIED-stub / event records land in **opencode**. Commit per-repo, PR default off unless the user asks.
- Reuse the specbase engine; **never** mix events into the spec FTS table. Separate `events.sqlite` only.
- Record progress conversation-native: `spec_tick_task` per task, `spec_record_event` per RCA/milestone, `spec_record_decision` for any new decision.

## Required Reads

1. `proposal.md` — why / scope / resolved decisions.
2. `design.md` — architecture, share-engine/separate-store, retirement taxonomy, DD-1..DD-9, Critical Files.
3. `spec.md` — BDD requirements + AC1..AC9.
4. specbase engine: `/home/pkcs12/projects/specbase/packages/lib/src/{indexer,schema,query,parser}.ts`, `packages/mcp/src/index.ts`.
5. Project `AGENTS.md` + `CLAUDE.md` (XDG backup, daemon lifecycle, PR-default-off).
6. Event log shape: `docs/events/` (912, no frontmatter, filename-date) + `plans/**/events/` (81, yaml frontmatter).

## Stop Gates In Force

- **G0**: No code before P0-1 XDG backup is done.
- **G1**: Separate `events.sqlite` only (DD-2); after Phase 1 re-verify spec index counts unchanged (AC2).
- **G2**: Do NOT mass-edit the 912 `docs/events` files (DD-3); filename-date only; new-event frontmatter (DD-9) for new files only.
- **G3**: specbase is a SEPARATE repo; commit separately; PR default off both repos.
- **G4**: Never self-spawn/kill/restart the daemon; only `webctl` / `system-manager:restart_self`. None expected here.
- **G5**: Do NOT empty MEMORY.md (P6-2) until P5-4 verification passes — every migrated item proven findable via its tool.

## Execution-Ready Checklist

- [ ] XDG backup taken (P0-1).
- [ ] specbase repo clean, branch noted (P0-2).
- [ ] Baseline spec-index counts recorded for AC2 (P0-3).
- [ ] Required Reads 1–6 read.
- [ ] Stop gates G0–G5 understood.

## Notes

- Rendered diagrams: `idef0.a0.svg`, `grafcet.svg`; supplementary runtime sequences in `grafcet.indexing.json`, `grafcet.migration.json`.
- The "3R" term is itself a migration item (procedure → `/3r` skill); source content is the existing memory entry `project_3r_deploy_term.md`.
