# WebApp File Tab Explorer Operations

## Why

The current WebApp File tab is closer to a project tree than a file explorer. Users need desktop-grade file management directly inside OpenCMS so common project operations do not require leaving the WebApp, switching to a shell, or relying on hidden browser/OS clipboard behavior. The feature must improve operator speed while preserving explicit filesystem safety boundaries.

## What Changes

Upgrade the existing WebApp File tab / project file-tree surface into a desktop File Explorer surface. The plan adds richer metadata display, safer activation semantics, batch selection, context menus, common filesystem operations, upload/download, recoverable delete, and independent pop-out windows for the File Explorer, file viewers, and terminal surfaces.

## Capabilities

- Right-click context menus on file rows, directory rows, and current-folder/background surfaces.
- Explorer-style operations: create file, create folder, rename, move, copy, cut, paste, delete, upload, download, and restore from recyclebin where applicable.
- Dense file list metadata with file size and modified date columns.
- Single-click select/focus and double-click open/enter behavior, with explicit expand/collapse controls remaining single-click.
- Batch selection with always-visible checkbox column, Shift range selection, Ctrl toggle selection, selected-set copy/cut/paste/delete, and batch confirmation UX.
- In-app clipboard operation state rather than implicit OS clipboard mutation.
- Recoverable delete via repo-local `recyclebin/` with tombstone naming and restore metadata.
- File Explorer, file-view tab, and terminal pop-out windows with source-pane cleanup semantics.
- Explicit writable-destination preflight model for any future paste outside the active project boundary.

## Impact

- **Frontend**: FileTree row rendering, selection state, context-menu target modeling, metadata columns, dialogs, toasts, tab reconcile behavior, and pop-out route/layout state will change.
- **Backend**: File routes and File namespace operations need new mutation/download/upload contracts, normalized results, stable errors, and safety guards.
- **Security**: Every operation must keep server-side path resolution authoritative, reject path traversal, avoid overwrite/auto-rename fallbacks, and expose external writable destinations before execution.
- **Validation**: Requires backend file-operation safety tests plus desktop browser verification for context menus, metadata, selection, mutations, upload/download, and pop-out behavior.

## Scope In

- Add a right-click context menu on file-tree rows and relevant empty-folder/background surfaces.
- Support explorer-style operations: create file, create folder, rename, move, copy, cut, paste, delete, upload, and download.
- Preserve explicit filesystem safety enforcement for every read/write operation; project-boundary writes remain the default, while user-requested writable destinations outside the active project require a separately designed permission/path model.
- Refresh affected file-tree folders after successful mutations.
- Keep upload/download as first-class operations in the same explorer interaction model.
- Make destructive operations explicit and confirmable.
- Show file size and file modified date in the file list.
- Change row open behavior from single-click to double-click for files and folders, while keeping expand/collapse controls single-click.
- Add a batch selection mode for multi-file copy, cut, paste, and delete operations.
- Add pop-out-to-independent-window controls for the File Explorer surface and individual file-view tabs.
- When Terminal is popped out, automatically collapse or vacate the original terminal tab area so it no longer consumes main layout space.
- Terminal pop-out windows should render as focused terminal windows with only a terminal title bar, not duplicate the app sidebar or top header.

## Scope Out

- No silent overwrite / merge / rename fallback.
- No silent global filesystem operation outside the active project boundary.
- No cloud storage or long-term transfer history.
- No automatic git staging/commit behavior.
- No hidden cross-project clipboard behavior; any writable-location paste must expose the resolved destination and permission outcome.
- No mobile/touch context-menu or gesture behavior in the initial implementation.
- No archive/zip directory download unless explicitly approved later.

## User Decision

- 2026-05-09: MVP behavior is "upload to current File tab folder; reject overwrite by default".
- 2026-05-09 revision: user expanded the feature into an advanced file-explorer-like File tab upgrade with context-menu CRUD, upload/download, copy/paste/cut/move/rename behavior.
- 2026-05-09 decision: delete should move targets into repo-local `recyclebin/` and support later restore rather than immediately unlinking files.
- 2026-05-09 open requirement: paste should be allowed to any destination the current user can write. This is intentionally recorded as high-risk and needs a concrete path/permission model before implementation.
- 2026-05-09 revision: File Explorer must also improve list metadata, double-click activation, multi-select batch operations, and pop-out independent window behavior for File Explorer, file-view tabs, and terminal.
- 2026-05-09 frontend decision: dense table/list layout, always-visible checkbox column, Shift/Ctrl multi-select, and source tab/pane removal after successful pop-out.

## Constraints

- Must reuse existing file/project boundary infrastructure where possible.
- Must fail fast with explicit errors for path escape, directory target mismatch, duplicate file, invalid operation, locked/busy resource, and oversized payload.
- Must not introduce fallback behavior that silently changes operation target or destination.
- Must model clipboard state explicitly in the UI; copy/cut must not be inferred from hidden browser clipboard side effects.
- Must distinguish reversible low-risk operations from destructive operations requiring confirmation.
- Must route delete through a recoverable recyclebin operation with collision-safe tombstone naming and metadata sufficient for restore.
