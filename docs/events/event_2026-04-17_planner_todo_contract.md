# event_2026-04-17 Planner skill: Runtime Todo ↔ tasks.md Contract

## Summary

Added §11 to `templates/skills/planner/SKILL.md` (and synced runtime copy) that defines the runtime todo contract between the planner artifacts (`tasks.md`) and the `todowrite`/`todoread` runtime tools.

## Motivation

Observed incident (2026-04-17): `todowrite` silently discarded LLM-provided todos because the default `mode = "status_update"` combined with an empty current list fell through to `applyStatusOnlyUpdate([], ...)` which returns `[]`. AGENTS.md 第一條 violation.

Follow-up analysis showed two separate problems:

1. **Code-level (fixed earlier today)** — [packages/opencode/src/tool/todo.ts](../../packages/opencode/src/tool/todo.ts) now auto-promotes `status_update + empty current + structure change` to `replan_adoption`, avoiding silent discard.
2. **Contract-level (this event)** — the AI had no clear discipline for when to use which `mode`, and no explicit relationship between `tasks.md` and runtime todos. Build agents saw an empty sidebar for non-delegation flows because the "todo-first gate" only triggers before `task()` delegation.

## What changed

- `§4.5 tasks.md` — added a rule stating `tasks.md` is the canonical structure source; build agents update status via `todowrite`, not by editing `tasks.md` directly.
- `§11 Runtime Todo ↔ tasks.md Contract` (new) — defines:
  - Two todo classes: `canonical` (`plan_<N>`, projected from `tasks.md`) vs `ad-hoc` (`ad_<slug>`, discovered mid-execution).
  - Three AI-facing modes: `progress` (default), `extend`, `rebuild`. Rebuild is rejected when session is plan-backed-executing.
  - Build agent discipline sequence (7 steps from session start to replan handling).
  - Drift detection: runtime auto-re-projects when `tasks.md` mtime advances.
  - UI separation between canonical and ad-hoc todos.
  - What the contract is NOT (not a tasks.md editor, not a deletion API, not a conversational state store).
  - `handoff.md` requirement: every planner-generated handoff must include a `## Build Agent Todo Discipline` subsection.

## Files touched

- `templates/skills/planner/SKILL.md` (+85 lines → 725 total)
- `~/.local/share/opencode/skills/planner/SKILL.md` (mirror)

## Not yet done (follow-ups)

- The three-mode schema described in §11.2 (`progress` / `extend` / `rebuild`) is AI-facing naming. The underlying runtime currently uses `status_update` / `plan_materialization` / `replan_adoption`. A future schema refactor should either rename the runtime enum to match or add a translation layer. Tracked separately.
- `tasks.md` mtime-based drift detection is described in §11.4 but the runtime currently only re-projects on GET `/session/:id/todo`. Adding the same projection on `todowrite` entry is a small follow-up.
- Build agent system prompt (either `agent.ts` build agent description or a new `build.txt`) does not yet reference §11.3 discipline. `SYSTEM.md` still gates `todowrite` only on `task()` delegation. To be revised separately.

## AGENTS.md compliance

- 第一條 (no silent fallback) — contract explicitly forbids silent discard; `cancelled` status is mandated instead of deletion.
- Release checklist — templates/** and runtime synced; this event log created. `specs/architecture.md` not affected. `templates/AGENTS.md` and `templates/prompts/SYSTEM.md` reviewed for contradictions (none; SYSTEM.md's `todowrite` gating is narrower than §11 but not contradictory).
