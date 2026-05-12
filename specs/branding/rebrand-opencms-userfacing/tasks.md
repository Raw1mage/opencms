# Tasks

## 1. Batch sweeps on test/rebrand-opencms

- [x] 1.1 Batch 1 — install.sh, scripts/install/install, TUI components (aa926df0d)
- [x] 1.2 Batch 2a — packages/app/src/i18n/* 16 locales, preserve "OpenCode Zen" (c2fd36c09)
- [x] 1.3 Batch 2b — packages/desktop (superseded; package removed pre-merge) (eecbd5b1b)
- [x] 1.4 Batch 3 — server route OpenAPI descriptions + SDK regen (895f14dd0)
- [x] 1.5 Batch 6 — templates/system/*, CONFIG-README, skill SKILL.md, prompts (604bd89e9)

## 2. Validation

- [x] 2.1 Run `bun turbo typecheck` on test/rebrand-opencms
- [x] 2.2 Confirm parity vs main baseline (pre-existing console-function SST + compaction.ts errors unchanged)
- [x] 2.3 Spot-check preservation allowlist (CLI name, `@opencode-ai/*`, opencode.json, XDG, "OpenCode Zen")

## 3. Land on main

- [x] 3.1 Merge test/rebrand-opencms → main as 6c66af0fd
- [x] 3.2 Graduate plan package to /specs/branding/rebrand-opencms-userfacing/

## Follow-up (out of this plan, tracked as separate work)

- Track remaining user-facing strings discovered during normal editing; sweep opportunistically.
- Plan a formal rebrand release for identifier-class surfaces (binary, npm packages, XDG paths).
