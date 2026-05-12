# Tasks: maintenance/release-gc

> Conventions:
> - `[ ]` pending · `[x]` done · `[~]` SUSPECT (skip in Phase 1, human review) · `[!]` blocked
> - Evidence format: `- [ ] <path>:<line> — <symbol or fragment> — <note>`
> - Phase 1 commits one per category; revert = `git revert <Cn-sha>`

## Phase 0 — Discovery (dream-mode)

- [x] P0.0 — Verification commands confirmed (typecheck/test/build); see design.md §Verification
- [ ] P0.1 — Set up knip config with all entry points (DEFERRED — present cheap-grep findings first)
- [ ] P0.2 — Run C1 scan (knip) — deferred
- [ ] P0.3 — Run C2 scan (depcheck) — deferred
- [x] P0.4 — C3 scan complete (4 MEMORY candidates checked)
- [x] P0.5 — C4 scan complete
- [x] P0.6 — C5 scan complete (scope-limited)
- [x] P0.7 — C6 scan complete
- [x] P0.8 — C7 scan complete
- [ ] P0.9 — Present taxonomy + evidence summary to user; await confirmation

## C1 — Mechanical dead code (knip / ts-prune)

Discovery: `bunx knip --reporter json` after P0.1 setup. Cross-check with `bunx ts-prune` for unused exports.

Evidence:
- _(populated during P0.2)_

Commit: `chore(gc/c1): remove mechanically-unreachable code`

## C2 — Unused dependencies

Discovery: `bunx knip --dependencies` + `bunx depcheck` cross-check. Manual review for runtime-only deps (e.g. peer of plugins).

Evidence:
- _(populated during P0.3)_

Commit: `chore(gc/c2): drop unused dependencies`

## C3 — Superseded features (MEMORY-driven)

Phase 0 results:

- [x] **CUSTOM_LOADER** — `rg CUSTOM_LOADER packages/` → 0 hits. **Already fully removed.** Nothing to do.
- [x] **Stage 5 drain-on-stop / drainGovernor** — `rg 'drain.?on.?stop|Stage5|drainGovernor'` → 0 hits. **Already fully removed.**
- [x] **Inline agent switch** — `rg 'inlineAgentSwitch|InlineAgentSwitch'` → 0 hits. **Already shelved + cleaned.**
- [x] **SameProviderRotationGuard candidate-filter path** — MEMORY says "diagnostic-only since 2026-05-07". Re-verified during P5: all 3 consumption sites at lines 461/517/527 are inside `log.warn(...)` / `debugCheckpoint(...)` calls (pure telemetry, no decision logic). MEMORY entry is accurate; nothing to remove.

Net result: C3 is **empty for execution**. The 4 MEMORY-listed superseded features are either already removed or still load-bearing.

Commit: ~~C3 commit~~ — nothing to remove; close category.

## C4 — Commented-out blocks / `// removed` residue

Phase 0 results (low scope — only 4 `// removed/deprecated` line markers in non-test code):

- [~] [packages/opencode/src/session/status.ts:35,80](packages/opencode/src/session/status.ts#L35) — `// deprecated` for `Event.Idle` / `session.idle` publish. **NOT dead**: consumed by [packages/app/src/context/notification.tsx:290,294](packages/app/src/context/notification.tsx#L290) AND documented as public plugin API in `packages/web/src/content/docs/plugins.mdx`. Either un-deprecate (remove `// deprecated`) or do a real deprecation cycle. SUSPECT — needs product decision.
- [ ] [packages/opencode/src/session/llm.ts:808-829](packages/opencode/src/session/llm.ts#L808) — 19-line explanatory `// removed. v6 (...)` comment describing the deleted attachment-drain-after-preface logic. Per CLAUDE.md no-`// removed`-comment rule, qualifies for stripping. BUT contains historical design rationale (why FIFO over drain). Recommendation: **strip the "removed" preface, keep the v6 rationale as a normal comment** (or extract to design doc).
- [ ] [packages/opencode/src/session/shared-context.ts:441](packages/opencode/src/session/shared-context.ts#L441) — similar `// removed. Compaction now reads from message-stream anchors and the ...` — need to read context to decide strip vs keep.
- [ ] `@deprecated` tags: 68 hits across `packages/`. Most likely SDK public-API deprecations (intentional). Sampling needed before declaring any of them dead. **DEFER** — separate sweep.

Commit: `chore(gc/c4): strip "// removed" prefaces, keep design rationale comments`

Scope is small (≤3 sites) — atomic commit is trivial.

## C5 — Rebrand opencode → opencms dual-write residue

Phase 0 results:

- 50+ files reference `OpenCode` (just packages/, excluding tests). Top hits are i18n locale files: `packages/console/app/src/i18n/{en,de,fr,ja,zht,zh,ko,...}.ts` with 66-77 hits each.
- Sampled `i18n/en.ts`: hits are **legitimate marketing/product copy** (`"home.what.title": "What is OpenCode?"`, `"temp.title": "opencode | AI coding agent built for the terminal"`). Per MEMORY `project_rebrand_opencms`: rebrand is **opportunistic**, not mass-rename.
- No "dual-write" pattern observed in samples (i.e. no `"OpenCode / OpenCMS"` side-by-side strings).

Net result: **C5 is empty for this sweep.** The 50+ files are intentional product copy waiting for the formal rebrand event. Closing category for release-gc; recommend a separate `branding/opencms-migration` plan when rebrand is greenlit.

Commit: ~~C5 commit~~ — close category, no-op.

## C6 — Legacy `~/.local/share/opencode/` migration code

**Major MEMORY correction**: `Global.Path.data` is NOT legacy. It's still the **active data root** for auth.json, session storage (DBs), snapshots, worktree state, attachments, etc. 36 hits in `packages/` are all live usage.

The actual legacy-migration code candidates are narrow:

- [~] [packages/opencode/src/account/index.ts:1163-1227](packages/opencode/src/account/index.ts#L1163) — `auth.json` → `auth.json.migrated` backup migration logic. Need: git-log to see when this migration shipped; if >6 months ago and all users on new layout, removable. SUSPECT.
- [~] [packages/opencode/src/cli/cmd/maintenance/migrate-strip-diffs.ts](packages/opencode/src/cli/cmd/maintenance/migrate-strip-diffs.ts) — CLI subcommand `maintenance:migrate-strip-diffs`. Still wired in [index.ts:37](packages/opencode/src/index.ts#L37). One-shot migration; if everyone has run it, the command can retire. SUSPECT.
- [~] [packages/opencode/src/server/migration-boot-guard.ts](packages/opencode/src/server/migration-boot-guard.ts) — `assertMigrationApplied` called on server boot ([cli/cmd/serve.ts:7](packages/opencode/src/cli/cmd/serve.ts#L7)). This is a guard that prevents serving until migration has applied — removable only when migration is mandatory-done. SUSPECT.

Net result: **C6 is all SUSPECT, no clean wins.** Each removal needs (a) git-log timestamp on when migration shipped, (b) confidence that no users remain on old layout. Recommendation: **defer C6 to a separate spec** (`maintenance/data-migration-retirement`) with explicit deprecation window declared.

Commit: ~~C6 commit~~ — defer.

## C7 — Deprecated planner skill remnants

Phase 0 results:

- [x] `templates/skills/planner/` exists with `SKILL.md` + `scripts/plan-init.ts` (430 LOC) + `scripts/plan-validate.ts` (665 LOC). This is the **shipped template** for the deprecated `planner` skill (bundled to users' `~/.claude/skills/` during install). Live skill at `templates/skills/plan-builder/` supersedes it.
- [x] `plans/` directory has 8 packages; **2 of them are legacy slug-only format** (no underscore, no `.state.json`):
  - [plans/daemon-agent/](plans/daemon-agent/) — only `proposal.md` + `tasks.md`
  - [plans/subagent-taxonomy/](plans/subagent-taxonomy/) — only `proposal.md` + `tasks.md`
  These need plan-builder peaceful migration (skill §9 on-touch) before retiring legacy planner is safe — they may still be using legacy validator format.
- [ ] grep for callers of `templates/skills/planner/scripts/*` — pending; if no `bun .../planner/scripts/plan-init.ts` direct invocation anywhere, safe to drop the template.

Sub-tasks (order matters):

- [x] C7a — `plans/daemon-agent/` migrated → `specs/daemon-agent/` (commit ea2e1a90f)
- [x] C7b — `plans/subagent-taxonomy/` migrated → `specs/subagent-taxonomy/` (commit 2578ed938)
- [x] C7-P3a — sync-config-back.sh excludes `planner/` (commit f79d3001a)
- [!] C7-P3c — BLOCKED: `templates/skills/` is a submodule (github.com/Raw1mage/skills); push gated on `synology_nginx/SKILL.md` containing internal LAN IPs + Synology reverse-proxy entries. User decision pending (move / generalize / archive).
- [x] C7-P3d — `docs/sdd_framework.md` rewritten as historical note (commit 83346020b)
- [x] C7-P3b — `OPENCODE_PLAN_BUILDER_TEMPLATE_DIR` alias added (commit 58bb4ec7a)
- [ ] C7-P3e — `templates/prompts/session/plan.txt` retire planner script references (deferred; needs /plan-mode live test)
- [~] C7-P3f — delete local `~/.claude/skills/planner/`, `~/.config/opencode/skills/planner/`, `~/.local/share/opencode/skills/planner/` (user decision; sync-back exclude prevents resurrection regardless)

Recommendation: **C7 stays in scope** but split into 4 sub-commits, NOT one atomic commit. Each sub-commit is independently revertible.

Commits:
- `chore(gc/c7a): migrate daemon-agent plan to plan-builder format`
- `chore(gc/c7b): migrate subagent-taxonomy plan to plan-builder format`
- `chore(gc/c7c): drop templates/skills/planner shipped template`
- `chore(gc/c7d): stop bundling legacy planner skill in install`

## Phase 1+ — Execution

(Filled in order C1 → C2 → C4 → C6 → C5 → C3 → C7 after P0.9 confirmation.)

For each category:
- [ ] Cn.exec — apply removals, single commit
- [ ] Cn.verify — typecheck/test/build pass
- [ ] Cn.event — spec_record_event with SHA + evidence resolved
