# Batch8E FC6 OS Module Extraction (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`fc6e7934b` split-port track)
Target: `cms`

## Scope

- Continue low-risk partial porting of `fc6e7934b`.
- This batch is structure-only refactor: extract Windows resolver/open helpers from `lib.rs` into dedicated `os` module.

## Changes

1. Added module files:
   - `packages/desktop/src-tauri/src/os/mod.rs`
   - `packages/desktop/src-tauri/src/os/windows.rs`
2. Moved Windows logic to `os::windows`:
   - `check_windows_app`
   - `resolve_windows_app_path`
   - `open_in_powershell`
3. Updated `lib.rs` routing:
   - `check_app_exists` windows branch -> `os::windows::check_windows_app`
   - `resolve_app_path` windows branch -> `os::windows::resolve_windows_app_path`
   - `open_in_powershell` windows branch delegates to `os::windows::open_in_powershell`

## Validation

- `cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml` ✅
- `bun run typecheck` (`packages/desktop`) ❌ baseline known TS typing issue on `window.__OPENCODE__.serverPassword` (pre-existing).

## Safety

- Behavior-preserving extraction only; no provider/account/admin/rotation3d domain changes.
- Prepares follow-up incremental desktop slices with lower merge risk.
