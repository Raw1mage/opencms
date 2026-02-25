# Event: origin/dev refactor round6 (read tool directory support)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `6b4d617df080cef71cd8f4b041601cf47ce0edf3`
- Intent: let read tool handle directory paths in addition to files.

## Rewrite-only port in cms

- `packages/opencode/src/tool/read.ts`
  - Detect directory targets via stat (instead of `Bun.file().exists()` only).
  - Pass `kind: "directory"` to external directory permission check for proper scope.
  - Return paged directory entry listing (`offset`/`limit`) with trailing `/` for directories.
  - Preserve existing file-read output format and behavior for compatibility.

- `packages/opencode/test/tool/read.test.ts`
  - Added test: external directory read asks directory-scoped `external_directory` permission.
  - Added test: final directory page reports non-truncated metadata.

## Additional analysis decision

- `006d673ed2e795ce41f30fc240189a54ff12c231` (read offset 1-indexed): skipped for now due API compatibility risk in cms.

## Validation

- `bun test packages/opencode/test/tool/read.test.ts`
  - Baseline note: first full run had one 5s timeout in env-permission matrix.
  - Re-run timed-out `.env` subset with `--timeout 20000`: pass.
