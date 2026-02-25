# Event: origin/dev refactor round24 (snapshot win32 git compatibility flags)

Date: 2026-02-25
Status: Done

## Round goal

Improve snapshot behavior reliability on Windows path/symlink environments.

## Candidate & assessment

- Candidate: `13cabae29f7ed2bd658037c0c676f7807d63d8b3`
- Decision: **Port**
- Rationale:
  - High value for cross-platform correctness in snapshot lifecycle operations.
  - Low architectural risk: localized to snapshot command invocation options.

## Rewrite-only port in cms

- `packages/opencode/src/snapshot/index.ts`
  - Added centralized git compatibility flags (`core.autocrlf=false`, `core.longpaths=true`, `core.symlinks=true`).
  - Applied flags consistently to snapshot git operations (`diff`, `restore`, `revert`, `diffFull`, `add`).
  - On snapshot repo initialization, set `core.longpaths=true`, `core.symlinks=true`, `core.fsmonitor=false`.

- `packages/opencode/test/preload.ts`
  - Added `rmSync` retry options (`maxRetries`, `retryDelay`) for test cleanup robustness.

## Validation

- `bun test packages/opencode/test/snapshot/snapshot.test.ts --timeout 30000` ✅ (43 pass, 1 skipped)
- `bun run packages/opencode/src/index.ts --help` ✅

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before commit.
- Result: **No architecture doc update required** (behavioral hardening within existing snapshot subsystem boundaries).
