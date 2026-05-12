# Proposal: branding_rebrand-opencms-userfacing

## Why

- Long-term rebrand "opencode" → "opencms" (Open Code Management System) requires user-facing strings to start carrying the new brand. Internal identifiers (CLI binary, npm packages, XDG paths, opencode.json filename, upstream URLs) stay until a formal rebrand release.

## Original Requirement Wording (Baseline)

- "Opportunistically drop 'OpenCode' from user-facing strings when already editing the file. Internal identifiers / storage keys stay until formal rebrand."

## Requirement Revision History

- 2026-05-12: initial draft created via plan-init.ts
- 2026-05-12: scope tightened to a single batch sweep landing on main as 6c66af0fd

## Effective Requirement Description

1. Replace user-facing "OpenCode" text in CLI/TUI, i18n bundles, server OpenAPI descriptions, SDK regen output, and template/skill prompt files with "OpenCMS".
2. Preserve all programmatic identifiers and product sub-brands ("OpenCode Zen").
3. No new typecheck regressions vs main baseline.

## Scope

### IN
- packages/opencode TUI strings, server route OpenAPI descriptions
- packages/app/src/i18n/* (16 language files)
- packages/sdk/js + packages/sdk regen output
- install.sh, scripts/install/install
- templates/system/*, CONFIG-README, skill SKILL.md, prompts

### OUT
- CLI binary name (`opencode`)
- npm package names (`@opencode-ai/*`)
- XDG paths (`~/.config/opencode/`)
- opencode.json filename, shell-profile.sh marker, mainBinaryName
- "OpenCode Zen" product brand
- Upstream URLs

## Non-Goals

- Renaming runtime state directories or migrating configuration.
- Touching internal identifier surface.

## Constraints

- Must not break upstream merge surface (paths, identifiers).
- Must preserve all `@opencode-ai/*`-anchored protocol expectations.

## What Changes

- 6 batch commits land on main via test branch (test/rebrand-opencms), merged in commit 6c66af0fd.
- 44 files modified across CLI/TUI, i18n, server, SDK, install scripts, and templates.

## Capabilities

### New Capabilities
- None — this is a presentation-layer rebrand.

### Modified Capabilities
- User-facing surfaces (TUI banners, dialog labels, server OpenAPI descriptions, install prompts, skill/template prompts) now display "OpenCMS".

## Impact

- Affected: TUI users, API consumers reading OpenAPI descriptions, install scripts output, anyone reading skill/template docs.
- Unaffected: scripted users (binary name unchanged), library consumers (package names unchanged), on-disk config (paths unchanged).
