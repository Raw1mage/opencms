# Event: Batch-5 Phase E5-B rewrite-port (Windows/test stability)

Date: 2026-02-27
Status: Done (5 ported, 2 skipped, 1 deferred)

## Scope

- `a292eddeb` fix(test): harden preload cleanup against Windows EBUSY
- `06f25c78f` fix(test): use path.sep in discovery test
- `3d379c20c` fix(test): replace Unix-only assumptions in tool tests
- `32417774c` fix(test): replace structuredClone with spread for process.env
- `36197f5ff` fix(win32): add 50ms NTFS mtime tolerance in FileTime assert
- `fce811b52` fix: reduce Windows Bun segfaults

## Decision summary

- Ported:
  - `a292eddeb` (preload cleanup retry strategy)
  - `3d379c20c` (bash/external-directory test cross-platform assertions)
  - `32417774c` (IDE test env clone)
  - `36197f5ff` (FileTime 50ms tolerance)
- Skipped (target file missing in current cms tree):
  - `06f25c78f` (`packages/opencode/test/skill/discovery.test.ts` not present)
  - `3d379c20c` partial (`packages/opencode/test/tool/write.test.ts` not present)
- Deferred:
  - `fce811b52` (larger runtime/UI behavior set; keep for dedicated stability batch)

## Changes

- `packages/opencode/test/preload.ts`
  - switched cleanup to async GC+retry remove loop for EBUSY resilience.
- `packages/opencode/test/tool/bash.test.ts`
  - external workdir test now uses `os.tmpdir()` and platform-safe expected glob.
  - small-output assertion accepts platform EOL.
- `packages/opencode/test/tool/external-directory.test.ts`
  - normalize expected patterns to forward slashes for cross-platform stability.
- `packages/opencode/test/ide/ide.test.ts`
  - replaced `structuredClone(process.env)` with spread clone.
- `packages/opencode/src/file/time.ts`
  - allow 50ms mtime tolerance before throwing stale-read assertion.

## Validation

- `bun test packages/opencode/test/tool/bash.test.ts packages/opencode/test/tool/external-directory.test.ts packages/opencode/test/ide/ide.test.ts packages/opencode/test/preload.ts` ✅
- `bun turbo typecheck --filter=opencode` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
