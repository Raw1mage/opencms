# Frontend Design Package

## Design Brief

Upgrade the desktop WebApp File tab from a simple project tree into a dense, operator-grade file explorer for code work. The interface prioritizes fast scanning, low accidental activation, explicit batch operations, and focused independent windows for file and terminal work.

## Aesthetic Direction

- **Mode**: pure-spec, no-template-selected.
- **Tone**: compact engineering workstation, closer to a desktop file manager than a document browser.
- **Density**: dense table/list by default.
- **Interaction feel**: deliberate, low-latency, keyboard-friendly, with minimal visual chrome.

## Design Token Intent

- **Row height**: compact; enough for filename, status icon, size, and modified date without wrapping.
- **Column rhythm**: fixed utility columns for checkbox, expander, icon/type, size, and modified date; flexible name/path column.
- **Selection color**: distinct from hover and focus. Multi-selected rows should remain readable under context-menu overlays.
- **Destructive accent**: reserved for delete/recyclebin confirmation only.
- **Pop-out chrome**: minimal, surface-specific title bars. Terminal pop-out must not inherit global app sidebar or top header.

## Layout Map

### File Explorer Embedded Surface

- **Toolbar zone**: current folder label, refresh, create, upload, paste state, pop-out button.
- **Selection/action strip**: appears when one or more rows are selected; shows selected count and batch actions.
- **Table header zone**: checkbox-all, name, size, modified date, optional status marker.
- **File list zone**: dense rows with checkbox, expander, file/folder icon, name, size, modified date.
- **Status/footer zone**: current folder, pending copy/cut summary, last operation result or error.

### File Explorer Pop-out Window

- **Title bar**: project/session identity, current folder, close control.
- **Toolbar + table**: same action model as embedded File Explorer.
- **No global app shell duplication**: no left app sidebar and no global top header.

### File View Pop-out Window

- **Title bar**: file path, viewer mode, close control.
- **Viewer body**: existing file viewer content.
- **Status strip**: staleness/modified indicator when available.
- **Main app behavior**: original file tab is removed/closed after successful pop-out; no placeholder remains.

### Terminal Pop-out Window

- **Title bar**: terminal title/session name, running/connected status, close control.
- **Terminal body**: terminal content only.
- **Main app behavior**: original terminal tab/pane is removed/collapsed after successful pop-out; no placeholder remains and no layout footprint is retained.

## Component Inventory

- `FileExplorerToolbar`: folder context, create/upload/paste/refresh/pop-out actions.
- `FileExplorerTable`: dense table/list renderer for rows and metadata columns.
- `FileExplorerRow`: checkbox, expander, icon, name, size, modified date, status markers.
- `SelectionActionStrip`: selected count, copy, cut, delete, clear selection.
- `FileContextMenu`: row/folder/background context menus with grouped actions.
- `BatchDeleteDialog`: destructive confirmation for selected-set recyclebin delete.
- `RenameDialog` / inline rename control: basename-only rename input.
- `CreateItemDialog`: create file/folder input with target folder visible.
- `UploadControl`: file picker scoped to current folder.
- `PopOutButton`: shared action trigger for File Explorer, file view, and terminal surfaces.
- `MinimalPopOutShell`: title-bar-only shell for independent windows.

## Interaction Map

### Dense File Browsing

- Single-click row body: focus/select row only.
- Double-click row body: open file or enter/open folder.
- Single-click expander: expand/collapse folder without opening it.
- Right-click row: open context menu and set context target.
- Right-click background/current folder: open folder/background context menu.

### Batch Selection

- Checkbox column is always visible.
- Header checkbox selects/clears all visible rows in the current folder.
- Shift-click extends range from the anchor row.
- Ctrl-click toggles individual rows.
- Selected-set actions operate on all selected valid items.
- Mixed selections disable invalid actions with a visible reason instead of silently filtering items.

### Clipboard and Paste

- Copy/cut state is in-app and shows selected item count plus operation mode.
- Paste is enabled only when the destination folder is valid and conflicts are prechecked or handled by explicit error.
- External writable paste remains a separate explicit flow requiring resolved destination and permission preflight.

### Pop-out Behavior

- File Explorer pop-out opens the same project/folder context in an independent window.
- File view pop-out opens the current file in an independent window and removes the original main-app file tab after success.
- Terminal pop-out opens a minimal terminal-only window and removes/collapses the original terminal tab/pane after success.
- Pop-out failures leave the original embedded surface unchanged.

## Motion Spec

- Row hover/focus/selection transitions should be short and functional; no decorative motion.
- Selection action strip appears/disappears with a small vertical collapse/expand transition.
- Context menus open immediately with standard menu positioning; avoid delayed flourish.
- Pop-out success should use a brief state transition only if it clarifies that the embedded surface was removed.

## Implementation Slices

1. Inspect and split existing row click behavior into focus/select, double-click activation, and expander click.
2. Extend file listing data contract for `size` and `modifiedAt` or add a metadata-loading path.
3. Convert FileTree rendering to dense table/list with checkbox, name, size, modified date columns.
4. Add selected-set state with checkbox, Shift-click range, Ctrl-click toggle, and selection action strip.
5. Add context-menu actions that understand single row, folder/background, and selected-set targets.
6. Add pop-out route/window model for File Explorer, file view, and terminal minimal shells.
7. Wire pop-out success cleanup so source file tabs and terminal panes are removed/collapsed without placeholder.

## Template Database Hints

- **Candidate family**: dense-operator-file-explorer.
- **Reusable pattern**: table-backed file explorer with deliberate double-click activation and explicit batch action strip.
- **Reuse boundary**: developer tools, admin consoles, artifact browsers, log/archive explorers.
- **Non-reuse boundary**: consumer media galleries or touch-first mobile file pickers.
- **Accessibility notes**: checkbox selection must be keyboard reachable; double-click activation needs keyboard equivalent; context menu must support keyboard trigger.

## Open Implementation Checks

- Confirm whether existing FileTree virtualization or scrolling assumptions constrain table column rendering.
- Confirm exact app route/window mechanism for independent windows before implementation.
- Confirm terminal lifecycle ownership so pop-out does not duplicate terminal process/session ownership.
