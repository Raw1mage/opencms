# Bug: File Explorer pinned folder `..` jumps to repo root instead of pinned folder parent

**Date**: 2026-06-04
**Area**: Web UI / File Explorer / pinned folders
**Severity**: Medium
**Status**: CLOSED (2026-06-11, soak passed since 2026-06-05, no recurrence) — was OBSERVING — fix deployed/restarted 2026-06-05; pinned chips reset file-tree history and absolute pinned paths remain their own navigation/display authority.
**Observing since**: 2026-06-05
**Exit → closed/**: no recurrence after soak / user confirms behavior remains correct.
**Regress → open**: pinned folder parent navigation again jumps to repo root or another unrelated fallback root.

## Symptom

File Explorer can display a pinned folder correctly, but using the `..` parent navigation from inside that pinned folder jumps back to `~/projects/<repo>/` instead of the pinned folder's actual parent directory.

Example behavior:

1. Pin or open a folder outside the active repo root.
2. File Explorer shows the pinned folder contents correctly.
3. Click `..` / parent directory.
4. File Explorer navigates to `~/projects/<repo>/`.
5. Expected parent should be the real filesystem parent of the pinned folder.

## Expected behavior

When the File Explorer is rooted at or currently viewing a pinned folder, `..` should resolve relative to the currently displayed pinned path, not relative to the active repo/workspace root.

If policy intentionally restricts parent traversal outside the pinned subtree, the UI should fail loud or disable `..`; it should not silently jump to an unrelated repo root.

## Actual behavior

`..` appears to be resolved through the session/workspace root fallback, causing navigation to `~/projects/<repo>/` regardless of the pinned folder's real parent.

## Impact

- Breaks file browsing for pinned folders outside the repo.
- Makes the File Explorer path model inconsistent: direct pinned-folder display uses the pinned path, while parent navigation uses repo-root semantics.
- Can confuse users into thinking the pinned folder belongs under the active repo.

## Likely root cause

The parent-directory action likely uses the workspace/repo root as the base path or fallback authority instead of preserving the current explorer root/path authority for pinned folders.

The fix should distinguish at least two path contexts:

- **Workspace explorer context**: paths are relative to the active repo/workspace root.
- **Pinned folder explorer context**: paths are relative to the pinned folder's actual filesystem path.

## Suggested fix direction

- Store the pinned folder's absolute path as the explorer root/path authority.
- Resolve `..` against the currently displayed absolute path.
- Apply traversal policy after resolution:
  - allow parent traversal if pinned folders are intended as filesystem shortcuts;
  - or disable/fail parent traversal if pinned folders are intended as bounded roots.
- Avoid falling back to `~/projects/<repo>/` unless the current explorer context is truly workspace-root based.

## Acceptance criteria

- From a pinned folder, clicking `..` goes to the pinned folder's actual parent path, or is explicitly blocked with a clear UI state.
- It never silently jumps to `~/projects/<repo>/` unless that is actually the current path's parent.
- Existing workspace-root file explorer navigation remains unchanged.
- Add regression coverage for pinned folder parent navigation.
