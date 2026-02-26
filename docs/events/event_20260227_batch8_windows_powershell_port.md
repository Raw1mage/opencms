# Batch8 Windows PowerShell Open Path Port (rewrite-only)

Date: 2026-02-27
Source: `origin/dev`
Target: `cms`

## Scope

- Followed `refacting-merger` recommendation set for low-risk, high-value Windows/Desktop fixes.
- Reimplemented upstream intent from commit `6b021658a` (`fix(app): open in powershell`) using rewrite-only strategy.

## Decisions

1. `34495a70` and `3201a7d3` are treated as **integrated** in cms (equivalent behavior already present).
2. Port `6b021658a` now as low-risk desktop behavior fix.
3. Defer large desktop refactor `fc6e7934` to dedicated batch due wider surface/risk.

## Changes

1. Added new desktop Tauri command:
   - `open_in_powershell(path: String)` in `packages/desktop/src-tauri/src/lib.rs`
   - Windows-only implementation that opens PowerShell with `-NoExit` in target directory.
2. Exposed command in TS bindings:
   - `commands.openInPowershell(path)` in `packages/desktop/src/bindings.ts`
3. Updated Windows path-open behavior:
   - In `packages/desktop/src/index.tsx`, detect PowerShell app target and route to `openInPowershell` instead of opener plugin.

## Validation

- Ran `bun run typecheck` in `packages/desktop`.
- Result: fails on pre-existing baseline error in `src/index.tsx` about `window.__OPENCODE__.serverPassword` typing (not introduced by this batch).

## Notes

- This batch intentionally avoids provider/account/rotation3d/admin logic and remains desktop-open-path scoped.
- Next step: assess whether to split `fc6e7934` into smaller rewrite-only slices for safer landing.
