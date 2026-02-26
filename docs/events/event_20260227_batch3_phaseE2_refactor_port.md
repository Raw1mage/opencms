# Event: Batch-3 Phase E2 rewrite-port (mid-risk stability)

Date: 2026-02-27
Status: Done (4 ported, 3 integrated)

## Scope

- `93615bef2` fix(cli): missing plugin deps cause TUI black screen
- `ac0b37a7b` fix(snapshot): respect info exclude in snapshot staging
- `241059302` fix(github): support variant in github action and github run
- `0042a0705` fix: Windows path support and canonicalization
- Terminal trio: `4e9ef3ecc`, `e70d2b27d`, `9f4fc5b72`

## Decision summary

- Integrated/no-op on current `cms`:
  - `93615bef2` (dependency install failure logging + plugin load error handling already integrated)
  - `ac0b37a7b` (snapshot add path already syncs `.git/info/exclude` via `add()/syncExclude()`)
  - `241059302` (`VARIANT` already plumbed through `github/action.yml` and github run prompt path)
- Ported in this phase:
  - `0042a0705` (Windows path/canonicalization deltas across patch/apply_patch/snapshot/bash)
- Terminal trio handling:
  - `e70d2b27d` behavior is already present in current `cms` (wrapper identity token in `Pty.connect(..., identity)` and route pass-through)
  - `9f4fc5b72` is a revert of the above and is intentionally **not** adopted
  - `4e9ef3ecc` app-side pieces are partially integrated already (terminal panel active-terminal rendering), remaining `ws.close(1000)` tweak deferred as low-value behavior difference

## Changes

- `packages/opencode/src/patch/index.ts`
  - parse patch headers via `slice("*** X File:".length)` instead of `split(":", 2)` to avoid Windows drive-letter truncation risks.
- `packages/opencode/src/tool/apply_patch.ts`
  - normalize displayed/permission relative paths to POSIX separators (`\\` -> `/`) for metadata, summaries, and diagnostic labels.
- `packages/opencode/src/snapshot/index.ts`
  - normalize `Snapshot.patch().files` paths to forward slashes for cross-platform stable comparisons.
- `packages/opencode/src/tool/bash.ts`
  - preserve POSIX-looking absolute directories (`/x/...`) when building external-directory permission globs on win32-like shells.

## Validation

- `bun test packages/opencode/test/tool/apply_patch.test.ts packages/opencode/test/pty/pty-output-isolation.test.ts` ✅
- `bun turbo typecheck --filter=opencode` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
