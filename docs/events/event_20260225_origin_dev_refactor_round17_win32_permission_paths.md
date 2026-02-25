# Event: origin/dev refactor round17 (win32 permission path normalization)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `ee754c46f992dd4024e56e93246421246d16d13f`
- Intent: make permission-boundary matching reliable on Windows path forms.

## Rewrite-only port in cms

- `packages/opencode/src/tool/external-directory.ts`
  - Normalize generated external-directory glob from backslash to slash form.

- `packages/opencode/src/util/wildcard.ts`
  - Normalize both `str` and `pattern` to slash form before glob matching.
  - Use case-insensitive regex mode on win32 (`si`) and preserve case-sensitive mode on non-win32 (`s`).
  - Tightened typing for `all` / `allStructured` to return `T | undefined`.

- `packages/opencode/test/tool/read.test.ts`
  - Updated assertions to expect slash-normalized external_directory patterns.

- `packages/opencode/test/util/wildcard.test.ts`
  - Added cross-platform slash normalization and win32 case-insensitive matching tests.

## Validation

- `bun test packages/opencode/test/util/wildcard.test.ts --timeout 20000` ✅
- `bun test packages/opencode/test/tool/read.test.ts --timeout 20000` ✅
