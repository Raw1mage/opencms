# Handoff: provider_apply-patch-metadata-strip

## Execution Contract

This is a **hotfix-class shape change**, not a refactor. Three surgical edits:

1. `apply_patch.ts` — drop `before` / `after` from `ApplyPatchFileMetadata` type + return-value construction.
2. `message-part.tsx` — three sites switch UI diff feed from `before/after` contents to hunk-format `diff`; plus remove two dead `filediff.before/after` references left over from the 2026-04-23 edit-tool migration.
3. `dreaming.test.ts` — one fixture stays as legacy-shape coverage; add a clarifying comment.

No new modules. No new tools. No SQLite schema change. No prompt-construction change. No public API change. Implementation MUST stay confined to the files listed in design.md "Critical Files"; any cross-cutting refactor is out of scope and should split into a separate spec.

Code lands on a beta worktree per `beta-workflow` skill (suggested branch: `beta/apply-patch-metadata-strip`); main repo only receives the fetch-back after M4 verification. Daemon restart only after user consent (memory rule).

## Required Reads

Before writing any patch, the implementer MUST read:

- `packages/opencode/src/tool/apply_patch.ts` (entire file — ~430 lines; focus on `ApplyPatchFileMetadata` type at L27-37 and return statement at L406-415).
- `packages/ui/src/components/message-part.tsx` — the apply_patch rendering blocks around L1769-1810 and the edit-tool block around L1620-1635; observe how `edit`/`write` parts already feed the diff component without before/after, and replicate that shape.
- `packages/opencode/src/snapshot/index.ts:191-196` — the 2026-04-23 precedent comment explaining why `write`/`edit` removed these fields; same rationale applies here.
- ~~`packages/opencode/src/session/storage/dreaming.ts:223-233` — the `pruneToolMetadata()` function; understand that it remains in place for legacy-session support and is NOT touched by this plan.~~ **[SUPERSEDED 2026-06-20 — `dreaming-legacy-teardown`]** `dreaming.ts` was deleted with the DreamingWorker + legacy dual-track teardown; the pruner no longer exists (legacy migration complete, new payloads omit before/after).
- `packages/opencode/src/session/message-v2.ts:1062-1069` — the `toModelMessages` serialization site; confirms metadata never reaches LLM. This is an invariant the change preserves.
- This package's `spec.md` Requirements + Acceptance Checks, `design.md` DD-1..DD-5, and `tasks.md` M1..M5.

## Stop Gates In Force

- **AGENTS.md no-silent-fallback**: if any UI render path silently no-ops on absent `file.diff`, treat as bug — diff field must always be populated by the tool, and UI MUST render visible diffs not blank panels.
- **Memory rule "Restart Daemon Requires User Consent"**: do NOT auto-restart the daemon after the patch; ask the user before invoking `system-manager:restart_self`.
- **Memory rule "Commit All Means Split Code From Docs"**: code commit (in beta worktree) and plan-doc commit (in main repo) MUST be separate commits.
- **Memory rule "Always Commit Submodule Pointer Bumps"**: none expected; flag if any submodule changes appear in the diff.
- **Memory rule beta-workflow §7.1**: fetch-back into `~/projects/opencode` (not a worktree).
- **AGENTS.md zone contract**: do NOT call `plan_graduate` — the verified→living transition is user-only.

## Execution-Ready Checklist

- [ ] Beta worktree branch created (suggested: `beta/apply-patch-metadata-strip`)
- [ ] M1-1..M1-4 (narrow tool type) implemented
- [ ] M2-1..M2-5 (UI migration + dead code removal) implemented
- [ ] M3-1..M3-2 (dreaming test fixture) updated and passing
- [ ] M4-1..M4-5 (live verification on real session, both new and legacy) captured under `events/`
- [ ] M5-1..M5-3 (AC ticks, event log, plan_advance to verified) done
- [ ] User triggers `plan_graduate` to move into `/specs/provider/apply-patch-metadata-strip/`

## Non-Obvious Things to Watch

- **Solid.js signal accessors**: `message-part.tsx` mixes `file.X` (loop iterator) and `file().X` (signal accessor). When migrating L1808-1809 use `file().diff`, not `file.diff`. Check surrounding lines.
- **`movePath` for rename patches**: when a patch renames a file (`type === "move"`), the existing code uses `file.movePath ?? file.filePath` for the "after" name. The hunk renderer still needs filename(s); pass `movePath` for the rename label, not `filePath`.
- **Test fixture intent**: M3-1's clarifying comment is load-bearing. Without it, a future reader will think the legacy-shape fixture is broken and try to "fix" it by dropping `before`/`after`, which would silently delete pruner-backwards-compat test coverage.
- **The `dreaming.ts:223-233` pruner stays**. It is no longer hot for new sessions but it covers legacy sessions. Removing it is a separate decision (would belong to a follow-up plan that vacuums legacy DBs).
- **No data migration script in this plan**. Resist the temptation to "while we're at it, rewrite all session DBs." DD-4 explicitly defers this.
