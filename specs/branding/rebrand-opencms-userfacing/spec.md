# Spec: branding/rebrand-opencms-userfacing

## Purpose

Surface-only rebrand of user-visible "OpenCode" strings to "OpenCMS" while keeping every programmatic identifier intact. This is the first wave of the long-term opencode → opencms rebrand.

## Requirements

### Requirement: User-facing text shows "OpenCMS"

User-facing strings (TUI, dialogs, i18n, server OpenAPI descriptions, install scripts, prompts/templates) must display "OpenCMS" instead of "OpenCode".

#### Scenario: TUI startup banner

- GIVEN a user launches `opencode` (binary name unchanged)
- WHEN the TUI renders its status/welcome surfaces
- THEN visible product name is "OpenCMS"

#### Scenario: i18n string lookup

- GIVEN any of the 16 locale bundles under packages/app/src/i18n/
- WHEN a UI consumer reads a localized brand string
- THEN the value contains "OpenCMS" (except keys explicitly tied to "OpenCode Zen")

#### Scenario: OpenAPI description

- GIVEN a client fetches /openapi.json or reads packages/sdk/openapi.json
- WHEN it inspects route descriptions previously naming "OpenCode"
- THEN descriptions name "OpenCMS"

### Requirement: Programmatic identifiers unchanged

Identifier-class strings must not be touched.

#### Scenario: CLI binary

- GIVEN the installed CLI
- WHEN the user invokes it
- THEN the binary name is still `opencode`

#### Scenario: Config paths and filenames

- GIVEN an existing install
- WHEN the runtime resolves config
- THEN `~/.config/opencode/`, `opencode.json`, `auth.json`, `@opencode-ai/*` package imports, and `mainBinaryName` are unchanged

#### Scenario: "OpenCode Zen" preserved

- GIVEN any string referencing the sub-brand "OpenCode Zen"
- WHEN inspected after rebrand
- THEN the literal "OpenCode Zen" is intact

### Requirement: No new typecheck regressions

`bun turbo typecheck` after the merge must produce no new failures relative to the pre-merge main baseline.

## Acceptance Checks

- [x] `git log --oneline 6c66af0fd~7..6c66af0fd` shows 6 rebrand batch commits + merge.
- [x] `bun turbo typecheck` parity vs main baseline (pre-existing console-function SST + compaction.ts errors unchanged; no new failures).
- [x] Spot-check on TUI, install.sh, openapi.json: visible text shows "OpenCMS", identifiers unchanged.
- [x] i18n grep confirms "OpenCode Zen" preserved verbatim across all 16 locales.
