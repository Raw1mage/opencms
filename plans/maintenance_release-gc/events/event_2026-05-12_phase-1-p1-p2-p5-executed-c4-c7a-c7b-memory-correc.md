---
date: 2026-05-12
summary: "Phase 1 P1+P2+P5 executed (C4, C7a, C7b, memory corrections)"
---

# Phase 1 P1+P2+P5 executed (C4, C7a, C7b, memory corrections)

**Commits applied (atomic per-category, revertible):**

- `8263c1842` — `docs(plans): seed maintenance/release-gc plan package` (baseline)
- `75665d8ce` — `chore(gc/c4): strip "// removed" prefaces and misleading deprecation markers` (3 sites: llm.ts attachment-lifecycle comment 22→6 lines; shared-context.ts regex-extraction "removed" → positive doc; status.ts `// deprecated` markers removed since Event.Idle is actively used + public plugin API)
- `ea2e1a90f` — `chore(gc/c7a): migrate plans/daemon-agent to plan-builder format` (on-touch migration via plan-state.ts; also swept pre-staged subagent-taxonomy renames)
- `2578ed938` — `chore(gc/c7b): finalize plans/subagent-taxonomy migration` (added .state.json + .archive/ left over from C7a)

**Phase 0 closeout findings:**

- C3 superseded-features: all 4 MEMORY-listed candidates either already removed (CUSTOM_LOADER / Stage 5 governor / inline-agent-switch — 0 grep hits) or correctly diagnostic-only (SameProviderRotationGuard — re-verified at P5, all 3 consumption sites are in log.warn/debugCheckpoint).
- C5 rebrand: 50+ OpenCode mentions are intentional product copy (i18n locales). Defer to formal opencms rebrand event.
- C6 Global.Path.data: NOT legacy — actively used. Memory entry corrected at P5. Real legacy-migration code (auth.json.migrated backup, migrate-strip-diffs CLI, migration-boot-guard) needs separate spec with deprecation window.

**Phase 0 deferred:**

- C1 (knip) / C2 (depcheck) — not invested per dream-mode 125 selection.
- C7c (drop templates/skills/planner) / C7d (stop bundling) — not in 125 scope; need caller verification first.

**Memory corrections (P5):**

- Updated MEMORY.md Key Architecture section: Global.Path.user vs Global.Path.data are both-active with different roles (config vs runtime data), NOT primary-vs-legacy.

**Revert recipe:**

- Each commit is independently revertible via `git revert <sha>`.
- C7a+C7b are coupled (file moves) — revert C7b first, then C7a.
- Plan package commit (`8263c1842`) can be reverted to fully undo this sweep.</body>
</invoke>
