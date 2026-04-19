# Handoff: mandatory-skills-preload

## Execution Contract

Executor (human engineer or autonomous build agent) acting on this handoff must:

1. **Read before touch** — load this handoff, `proposal.md`, `spec.md`, `design.md`, `tasks.md` into context. Also scan `specs/architecture.md` for existing skill-layer / instruction / prompt architecture.
2. **Backup first** — AGENTS.md 第二條 強制要求。`bun run` 或實作前必須先 `cp -a ~/.config/opencode/ ~/.config/opencode.bak-<timestamp>-mandatory-skills-preload/`. 不可跳過。
3. **Follow tasks.md phase order** — §16 of plan-builder: one phase's items loaded into TodoWrite at a time. Phase rollover is atomic (summary → next-phase TodoWrite → first task start). No self-deemed "good stopping point" that is not in §Stop Gates.
4. **No silent fallback** — AGENTS.md 第一條. Any lookup / file / parse miss MUST log loudly with context.
5. **Cross-check every file edit** — verify imports / exports / type signatures exist in the actual code before writing. Do not trust documentation alone.
6. **Sync after each task** — run `bun run ~/.claude/skills/plan-builder/scripts/plan-sync.ts specs/mandatory-skills-preload/` after every checkbox toggle.

## Required Reads

Before the first line of implementation code is written:

- `packages/opencode/src/session/instruction.ts` (entire file — 118 lines)
- `packages/opencode/src/session/skill-layer-registry.ts` (entire file)
- `packages/opencode/src/session/skill-layer-seam.ts` (entire file)
- `packages/opencode/src/session/prompt.ts` lines ~1630-1700 (system[] assembly region) AND lines ~970-1060 (loop boundary where skill-layer decay tick happens)
- `packages/opencode/src/agent/prompt/coding.txt` (entire file)
- `packages/opencode/AGENTS.md` (repo-root)
- `templates/AGENTS.md` (release variant)
- `templates/skills/agent-workflow/SKILL.md` (source of §5 debug contract to migrate)
- `templates/skills/code-thinker/SKILL.md` (destination for debug contract)
- `packages/opencode/src/session/prompt/enablement.json` + `templates/prompts/enablement.json`
- `specs/mandatory-skills-preload/data-schema.json` (contracts for parser outputs + events)
- `specs/mandatory-skills-preload/sequence.json` (runtime flow diagrams)

Skip verification shortcuts: re-read after every significant edit. The relevant files change often.

## Scope Boundaries (do NOT do)

- Do NOT add other skills to the initial mandatory list (keep `plan-builder` only for main + `code-thinker` only for coding — per DD-10). Future additions go through a new spec or an `extend` mode revision of this one.
- Do NOT modify runloop continuation logic (`workflow-runner.ts planAutonomousNextAction` etc.). This spec is prompt-layer only.
- Do NOT attempt to make subagents consume AGENTS.md. The existing instruction.ts:48-53 skip is intentional (2026-02-16 `instruction_simplify` decision).
- Do NOT delete the `opencode.bak-*` backup folder. The user decides cleanup timing (AGENTS.md 第二條).
- Do NOT batch multiple task checkboxes into one commit — §16.3 of plan-builder requires immediate per-task sync.
- Do NOT rename existing exports that other code depends on (`SkillLayerRegistry.pin`, `SkillLayerRegistry.recordLoaded`, etc.). Only add `unpin`.

## Stop Gates In Force

The executor MUST stop and request user decision when any of the following occur:

1. **Backup step fails** — `~/.config/opencode/` is unreadable / disk full / permissions error. Do not proceed without a valid backup.
2. **Debug contract migration diff conflicts** — `agent-workflow/SKILL.md §5` content conflicts with existing `code-thinker/SKILL.md` guidance in a way that cannot be mechanically merged. User to arbitrate.
3. **Cache semantics change request** — if DD-6's integration with `systemCache` turns out to require restructuring the cache shape (not just adding fields), user approval needed before breaking the 10s TTL contract.
4. **Unit tests reveal unexpected `skill-layer-seam` behavior** — if existing tests fail after your changes in ways not covered by this spec, stop and ask.
5. **Risk R4 materializes** — residual `skill({name: "agent-workflow"})` calls cause session crashes rather than graceful degradation. Surface immediately; may require `skill` tool hardening outside this spec's scope.
6. **Initial list expansion pressure** — user or other stakeholder asks to add more skills before this spec ships. Deflect to an extend-mode follow-up spec.
7. **Destructive operation need** — any `git rm -r` of `templates/skills/agent-workflow/` MUST be preceded by a visible-to-user confirmation that the directory is tracked in git (not uncommitted work).

## Execution-Ready Checklist

Before the very first task (1.1 Backup) fires, verify:

- [ ] Current branch state is understood and clean (`git status` shows expected uncommitted / tracked state)
- [ ] `specs/mandatory-skills-preload/.state.json` is at `planned` state (NOT `designed` or `implementing`)
- [ ] Acceptance plan from §10 of tasks.md is understood end-to-end
- [ ] User has confirmed whether this is a direct-main build or beta-workflow build (AGENTS.md suggests beta for non-hotfix)
- [ ] `bun run --version` reports a working runtime
- [ ] Backup destination is writable: `touch ~/.config/opencode.bak-test && rm ~/.config/opencode.bak-test`
- [ ] miatdiagram MCP tool availability already verified during designed-state plan build (not re-required here since no new diagrams are produced in implementation phase)

## Per-Task Ritual (pulled from plan-builder §16.3)

After EACH task checkbox toggle:

1. Mark `- [x]` immediately in `specs/mandatory-skills-preload/tasks.md`
2. Run `bun run ~/.claude/skills/plan-builder/scripts/plan-sync.ts specs/mandatory-skills-preload/`
3. Inspect sync output:
   - `clean` → proceed
   - `warned drift` → consult §16.3 decision tree (code-only / amend / extend / refactor)
4. Update corresponding TodoWrite item to `completed`
5. If this is a phase-boundary task: write phase summary entry into `docs/events/event_<YYYYMMDD>_mandatory_skills_preload.md`

## Phase-Summary Structure (for §16.4)

Each phase close emits a block in the event log with these fields:

- **Phase**: `N — <name>` from tasks.md
- **Done**: comma-separated task IDs completed this phase
- **Key decisions**: new DD-N added to design.md during this phase (if any)
- **Validation**: linter / bun test / manual verification output snippets
- **Drift**: any sync warnings and their resolution mode
- **Remaining**: what's before next state promotion

## State Promotion Plan

| Transition | Trigger |
|---|---|
| planned → implementing | first `- [x]` toggle on tasks.md (e.g. 1.1 Backup completed) |
| implementing → implementing | history-only (sync entries); every task closure |
| implementing → verified | all tasks.md checkboxes done + §10.1-10.8 evidence captured in event log |
| verified → living | merge to `main` (direct) or fetch-back from beta-workflow succeeds |

No `revise` / `extend` / `refactor` anticipated during normal execution. Any of these fires means this handoff has been superseded and requires a fresh planning round.

## Rollback

If the implementation is mid-stream and must be reverted:

1. Revert any committed edits via `git revert` (never `git reset --hard` on pushed commits)
2. Restore `~/.config/opencode/` from the backup folder — ONLY on explicit user request (第二條)
3. Roll state back via `plan-promote.ts --mode refactor` if scope needs restart, or `plan-promote.ts --to planned` if only execution stalled
4. Log rollback reason in the event file
