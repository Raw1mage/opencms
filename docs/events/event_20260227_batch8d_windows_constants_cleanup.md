# Batch8D Windows Constants Cleanup (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (fc6/6b related windows style)
Target: `cms`

## Scope

- Continue low-risk desktop slice work.
- Replace magic Windows creation flag literals with named `windows-sys` constants.

## Changes

1. `packages/desktop/src-tauri/src/lib.rs`
   - `resolve_windows_app_path`: use `CREATE_NO_WINDOW` (instead of `0x08000000`) for hidden `where` probing.
   - `open_in_powershell`: use `CREATE_NEW_CONSOLE` (instead of `0x00000010`) for dedicated PowerShell window launch.
2. `packages/desktop/src-tauri/Cargo.toml`
   - Expanded `windows-sys` features to include `Win32_System_Threading`.

## Validation

- `cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml` ✅
- Existing warning remains unrelated (`check_linux_app(app_name)` unused argument).

## Safety

- Pure desktop windows flag readability/maintainability cleanup.
- No impact to cms multi-account / rotation3d / admin / provider split domains.
