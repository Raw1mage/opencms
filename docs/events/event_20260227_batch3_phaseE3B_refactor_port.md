# Event: Batch-3 Phase E3-B rewrite-port (desktop/win32)

Date: 2026-02-27
Status: Done

## Scope

- `659068942` fix(win32): handle CRLF line endings in markdown frontmatter parsing
- `392a6d993` fix(desktop): remove interactive shell flag from sidecar spawn
- `bb8a1718a` fix(desktop): restore shell path env for desktop sidecar

## Changes

- `packages/opencode/src/config/markdown.ts`
  - frontmatter line split now supports CRLF (`split(/\r?\n/)`).
- `packages/opencode/test/config/markdown.test.ts`
  - markdown-header assertion normalizes CRLF to LF for stable cross-platform expectations.
- `packages/desktop/src-tauri/src/cli.rs`
  - sidecar spawn switched from `-il` to `-l` shell mode to avoid interactive-shell hangs.
  - added shell env probe/merge helpers (`parse_shell_env`, `load_shell_env`, `merge_shell_env`) and applied merged env for sidecar spawn.

## Validation

- `bun test packages/opencode/test/config/markdown.test.ts` ✅
- `bun turbo typecheck --filter=opencode --filter=@opencode-ai/desktop` ⚠️ failed on existing desktop baseline issue: `src/index.tsx(460,33) Property 'serverPassword' does not exist...` (not introduced by this round)

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
