# Event: origin/dev refactor round20 (text vs binary classification hardening)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `8ebdbe0ea2bbf4b2ca7499d59ff9549d3e291557`
- Intent: prevent common text files from being misclassified as binary by extension-based fast paths.

## Rewrite-only port in cms

- `packages/opencode/src/file/index.ts`
  - Added `textExtensions` + `textNames` allowlists for common source/script/config file types.
  - Added `isTextByExtension` / `isTextByName` checks.
  - Updated binary extension short-circuit to honor text allowlist (`binary && !text`).
  - Updated encode decision to skip binary encoding path for allowlisted text files.

- `packages/opencode/test/file/path-traversal.test.ts`
  - Added integration coverage:
    - `.sh` script read remains text
    - `Dockerfile` read remains text

## Validation

- `bun test packages/opencode/test/file/path-traversal.test.ts --timeout 20000` ✅
- `bun run packages/opencode/src/index.ts --help` ✅
