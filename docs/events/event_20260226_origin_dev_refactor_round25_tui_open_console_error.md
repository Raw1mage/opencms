# Event: origin/dev refactor round25 (tui open-console-on-error)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Avoid unexpected debug-console takeover on TUI runtime errors; keep failure handling within the existing in-app ErrorBoundary UX.

## 2) Candidate

- Upstream commit: `c0814da785d40273f36eda835c4cfd583cf20d75`
- Subject: `do not open console on error (#13374)`

## 3) Decision + rationale

- Decision: **Port (rewrite-only)**
- Rationale:
  - Small, localized runtime option change.
  - Preserves current cms UI flow (error rendering via `ErrorComponent`) and reduces disruptive fallback behavior.

## 4) File scope

- `packages/opencode/src/cli/cmd/tui/app.tsx`
  - Set render option `openConsoleOnError: false`.

## 5) Validation plan

- `bun run packages/opencode/src/index.ts tui --help`
- `bun run packages/opencode/src/index.ts admin --help`

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before commit.
- Expected result: no architecture doc update required (runtime option toggle only).
