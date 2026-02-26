# Batch8B FC6 UI Loading State Slice (rewrite-only)

Date: 2026-02-27
Source: `origin/dev`
Target: `cms`

## Scope

- Follow-up of deferred upstream commit `fc6e7934b` (`feat(desktop): enhance Windows app resolution and UI loading states`).
- This batch ports only the **session header open-action loading UX** slice.

## Why this slice

- Low-risk, user-facing feedback improvement.
- No change to cms core invariants:
  - multi-account management
  - rotation3d model rotation
  - `/admin` behavior
  - provider split (`antigravity` / `gemini-cli` / `google-api`)

## Changes

1. `packages/app/src/components/session/session-header.tsx`
   - Added `Spinner` visual state when opening project path in external app.
   - Added in-flight guard (`openRequest`) to prevent duplicate open requests.
   - Disabled open button and dropdown trigger/menu items while opening.
   - Keep selected app icon sizing consistent through existing `openIconSize` helper.

## Validation

- Typecheck run in `packages/app` failed due pre-existing baseline warnings/errors unrelated to this slice.
- No provider/auth/account/admin-path code touched.

## Deferred

- Remaining `fc6e7934b` desktop tauri refactor (large `windows.rs` architecture movement) remains deferred to dedicated batch.
