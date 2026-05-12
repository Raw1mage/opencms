# Design: branding/rebrand-opencms-userfacing

## Context

The opencode project is being rebranded long-term to "opencms" (Open Code Management System). A full rename across binary names, npm packages, XDG dirs, and storage keys is out of scope until a formal rebrand release — these constitute upgrade/compat surface. This change therefore implements the *user-facing-only* wave, sweeping visible strings while keeping every programmatic identifier intact.

## Goals / Non-Goals

### Goals
- Replace user-visible "OpenCode" → "OpenCMS" across TUI, i18n, server OpenAPI, install scripts, and templates/prompts.
- Preserve "OpenCode Zen" product sub-brand verbatim.
- Land in batches small enough to review; merge to main once typecheck is parity.

### Non-Goals
- Rename CLI binary, npm packages, XDG paths, opencode.json filename, mainBinaryName, shell-profile marker, or any upstream URL.
- Migrate runtime state, storage keys, or auth tokens.
- Change behavior — pure text substitution at surfaces.

## Decisions

1. **Six-batch landing.** Sweep is partitioned by surface (1: install/TUI · 2a: i18n · 2b: desktop superseded · 3: server/SDK · 6: templates/prompts). Each batch is reviewable in isolation.
2. **Test branch + fetch-back.** Implementation lives on `test/rebrand-opencms` until typecheck baseline parity is confirmed, then merged to main as a single merge commit (6c66af0fd).
3. **Preservation allowlist enforced by grep.** "OpenCode Zen", `@opencode-ai/`, `opencode.json`, `~/.config/opencode/`, `mainBinaryName`, install marker, and upstream URLs verified by post-batch grep before each commit.
4. **No SDK regen drift.** packages/sdk/js + packages/sdk/openapi.json regenerated in batch 3 from updated server route descriptions, not hand-edited.

## Risks / Trade-offs

- **Risk:** A user-facing string accidentally tied to an identifier path is rebranded.
  - *Mitigation:* Preservation allowlist + typecheck.
- **Risk:** External tooling parses TUI/OpenAPI text and expects literal "OpenCode".
  - *Trade-off accepted:* Surface text is documented as cosmetic; the rebrand is exactly what consumers need to migrate.
- **Risk:** i18n translations drift in tone (16 locales).
  - *Mitigation:* Direct token-level substitution only; no translation rewriting.

## Critical Files

- install.sh, scripts/install/install
- packages/opencode/src/cli/cmd/tui/app.tsx + component/* + routes/*
- packages/opencode/src/server/routes/*.ts (OpenAPI descriptions)
- packages/app/src/i18n/{ar,br,bs,da,de,en,es,fr,ja,ko,no,pl,ru,th,zh,zht}.ts
- packages/sdk/js/openapi.json, packages/sdk/js/src/v2/gen/sdk.gen.ts, packages/sdk/openapi.json
- templates/system/*, CONFIG-README, skill SKILL.md, prompts
