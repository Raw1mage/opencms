# Event: origin/dev refactor round19 (file.status path normalization)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `190d2957eb34246ac942b1e082ea79fd151ea973`
- Intent: normalize `file.status` output paths relative to instance directory consistently, regardless of absolute/relative internal path forms.

## Rewrite-only port in cms

- `packages/opencode/src/file/index.ts`
  - In `File.status()`, each changed file path now:
    1. resolves to absolute path when needed (`path.join(Instance.directory, x.path)`),
    2. then converts to stable relative path using `path.relative(Instance.directory, full)`.

## Validation

- `bun test packages/opencode/test/file/path-traversal.test.ts --timeout 20000` ✅
- `bun run packages/opencode/src/index.ts --help` ✅
