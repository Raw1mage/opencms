# Behavioral Spec

## Purpose

Define observable behavior for the desktop WebApp File Explorer upgrade. The spec covers user-visible file browsing, metadata display, selection, context actions, backend file-operation behavior, safety enforcement, recoverable delete, upload/download, and pop-out surfaces.

## Requirements

### Requirement: Provide File tab context menu operations

#### Scenario: user opens valid context menu

- **GIVEN** the user can see the current repo file tree in the WebApp File tab surface
- **WHEN** the user right-clicks a file, directory, or current-folder background
- **THEN** the UI shows a context menu containing only operations valid for that target
- **AND** unavailable operations are either hidden or disabled with an understandable reason

### Requirement: Display file metadata in the file list

- **GIVEN** the user views the desktop File Explorer surface
- **WHEN** a directory listing is loaded
- **THEN** each visible file row shows file size and modified date when available
- **AND** the default presentation is a dense table/list with name, size, and modified date columns
- **AND** directory rows may show a directory marker or aggregate-neutral placeholder rather than inventing recursive size
- **AND** metadata loading must not block basic name/type rendering indefinitely

### Requirement: Use double-click activation for files and folders

- **GIVEN** the user interacts with a file or folder row
- **WHEN** the user single-clicks the row body
- **THEN** the row is selected or focused without opening the file or toggling the folder
- **WHEN** the user double-clicks the row body
- **THEN** files open and folders enter/open according to the File Explorer behavior
- **AND** explicit expand/collapse controls remain single-click targets

### Requirement: Support batch selection mode

- **GIVEN** the user views the desktop File Explorer surface
- **WHEN** the file list is rendered
- **THEN** a checkbox column is always visible for batch selection
- **WHEN** the user selects multiple files or directories
- **THEN** copy, cut, paste, and delete actions operate on the selected set where valid
- **AND** Shift-click extends a selection range
- **AND** Ctrl-click toggles individual rows
- **AND** invalid mixed selections show disabled actions or explicit reasons
- **AND** destructive batch delete requires confirmation that lists the selected count and representative paths

### Requirement: Pop File Explorer to an independent window

- **GIVEN** the user is using the File Explorer surface
- **WHEN** the user clicks the pop-out control
- **THEN** an independent window opens with the File Explorer focused on the same project/folder context
- **AND** selection, pending copy/cut state, and refresh behavior remain coherent with the main session

### Requirement: Pop file-view tabs to independent windows

- **GIVEN** the user has a file open in a File view tab
- **WHEN** the user clicks the file-view pop-out control
- **THEN** an independent window opens showing that file view
- **AND** the original main-app file tab is removed after successful pop-out
- **AND** no placeholder is left behind in the main app

### Requirement: Terminal pop-out removes terminal footprint from main layout

- **GIVEN** the user pops a terminal out to an independent window
- **WHEN** the pop-out succeeds
- **THEN** the original terminal tab/pane automatically collapses or vacates so it no longer consumes main layout space
- **AND** no placeholder is left behind in the main layout
- **AND** the terminal pop-out window does not render the app sidebar or top header bar
- **AND** the terminal pop-out window shows only the terminal-specific title bar and terminal content

### Requirement: Create files and directories

- **GIVEN** the user invokes create-file or create-folder on a target directory
- **WHEN** the user provides a valid basename
- **THEN** the server creates the item inside that exact directory
- **AND** the affected folder listing refreshes
- **AND** duplicate names are rejected without overwriting existing content
- **AND** the mutation response identifies the created item and affected parent directory

### Requirement: Rename files and directories

- **GIVEN** the user invokes rename on a file or directory
- **WHEN** the user provides a valid new basename
- **THEN** the item is renamed inside its current parent directory
- **AND** open file tabs and tree state reconcile to the new path where applicable
- **AND** duplicate names are rejected without overwriting existing content
- **AND** the mutation response identifies the old path, new path, and affected parent directory

### Requirement: Copy, cut, paste, and move items inside active project

- **GIVEN** the user copies or cuts a file or directory from the File tab
- **WHEN** the user pastes into a target directory
- **THEN** the server performs the corresponding copy or move inside the project boundary
- **AND** source and destination folders refresh as needed
- **AND** collisions are rejected unless a later explicit overwrite mode is approved
- **AND** the mutation response identifies the operation mode and affected source/destination directories

### Requirement: Paste to user-writable destinations outside active project

- **GIVEN** the user has a pending copy or cut operation
- **WHEN** the user chooses an explicit destination path outside the active project
- **THEN** the UI must show the resolved destination path before execution
- **AND** the server must verify the current user can write the destination before mutating bytes
- **AND** the operation must fail fast if permission probing or canonicalization is ambiguous
- **AND** execution is not allowed until an explicit destination preflight has succeeded

### Requirement: Move deleted items to recyclebin with restore metadata

- **GIVEN** the user invokes delete on a file or directory
- **WHEN** the user confirms the destructive action
- **THEN** the server moves the target into repo-local `recyclebin/` using collision-safe naming
- **AND** the server writes metadata sufficient to restore the original path later
- **AND** affected tabs/tree state are reconciled
- **AND** cancellation leaves the filesystem unchanged
- **AND** permanent unlink is not available in the initial implementation phase

### Requirement: Upload file to current File tab folder

- **GIVEN** the user is viewing a project folder in the WebApp file surface
- **WHEN** the user selects a local file to upload
- **THEN** the file is written into that exact project folder
- **AND** the folder listing refreshes after success
- **AND** only the uploaded file basename is accepted as the target filename

### Requirement: Download files

- **GIVEN** the user invokes download on a file
- **WHEN** the file is inside the active project boundary
- **THEN** the browser downloads the exact file bytes
- **AND** directories are not downloaded unless a later archive-download phase is approved

### Requirement: Reject duplicate target filename

- **GIVEN** a file with the same name already exists in the selected target folder
- **WHEN** the user uploads a file with that name
- **THEN** the server rejects the upload
- **AND** the UI shows an explicit duplicate-file error
- **AND** the existing file remains unchanged

### Requirement: Enforce filesystem safety for every operation

- **GIVEN** the client sends any source path, target directory, new name, or filename that would escape the active project directory
- **WHEN** the server receives the file-operation request
- **THEN** the operation is rejected before mutating or streaming bytes

- **GIVEN** the operation is an explicitly approved writable-location paste outside the active project
- **WHEN** the server receives the destination path
- **THEN** the operation is rejected unless canonicalization and write-permission probing succeed

### Requirement: Reject symlink escape

- **GIVEN** a source path inside the active project whose realpath resolves outside the project root
- **WHEN** the server receives a rename, move, copy, delete, or download request for that path
- **THEN** the operation is rejected with `FILE_OP_PATH_ESCAPE` before any mutation or read of bytes
- **AND** the rejection check uses realpath resolution, not just lexical path comparison

### Requirement: Enforce upload size limit

- **GIVEN** a configured upload size limit (default 64 MiB; tunable via `/etc/opencode/tweaks.cfg`)
- **WHEN** the user uploads a file whose payload exceeds the limit
- **THEN** the server rejects the upload with `FILE_UPLOAD_TOO_LARGE`
- **AND** the server does not retain partial bytes on disk
- **AND** the limit value is reported in the error payload `data` so the UI can surface it
- **AND** rejection happens before the full payload is buffered into memory where the runtime supports streaming size checks

### Requirement: Recyclebin visibility and project-tree behavior

- **GIVEN** repo-local `recyclebin/` exists inside the active project directory
- **WHEN** the user views the desktop File Explorer
- **THEN** the `recyclebin/` directory is hidden from the default tree by default
- **AND** an explicit "show recyclebin" toggle reveals it for restore browsing
- **AND** `recyclebin/` and any sidecar `*.opencode-recycle.json` metadata files are added to the project's git ignore via the operator's existing ignore mechanism on first delete; if the project has no writable git ignore the operation still succeeds and the absence is logged but not surfaced as an error
- **AND** restore reads metadata only from sidecar files inside `recyclebin/`; metadata pointing at paths outside the project is rejected with `FILE_RECYCLEBIN_METADATA_INVALID`

## Acceptance Checks

- Desktop File Explorer shows dense rows with name, size, and modified-date columns without blocking basic row rendering on delayed metadata.
- Single-click selects/focuses row bodies; double-click opens files or enters folders; expand/collapse controls remain single-click.
- Context menus expose only valid operations for file, directory, current-folder/background, and selected-set targets.
- Create, rename, copy, move, recoverable delete, restore, upload, and download routes return normalized operation results and stable error codes.
- Duplicate targets, invalid basenames, path traversal, ambiguous destinations, unsupported directory download, and unconfirmed destructive deletes fail fast without mutating bytes.
- Delete moves targets into repo-local `recyclebin/` with restore metadata; initial implementation does not permanently unlink.
- Batch selection supports checkbox selection, Shift range selection, Ctrl toggle selection, selected-set operations, and explicit destructive confirmation.
- File Explorer, file-view tab, and terminal pop-out flows preserve session/project context and remove or collapse the source pane without leaving a placeholder.
- Symlink-targeted operations whose realpath leaves the project boundary fail fast with `FILE_OP_PATH_ESCAPE`.
- Uploads exceeding the configured size limit fail with `FILE_UPLOAD_TOO_LARGE` and leave no partial bytes on disk.
- `recyclebin/` is hidden by default in the file tree, exposed via an explicit toggle, and added to git-ignore on first delete where the project has a writable ignore file.

## Out of Scope (V1)

The following are explicitly **not** part of the first implementation. Each is a deliberate decision recorded so future contributors do not silently re-introduce ambiguity.

- **Drag-and-drop within the tree.** The current `file-tree.tsx` already implements row-level drag for legacy purposes. V1 keeps that behavior unchanged and does **not** repurpose drag for move/copy. Reason: drag interaction collides with the new single-click select / double-click activate / Shift+Ctrl multi-select model and would require a separate gesture-disambiguation design. Re-scope to a follow-on phase.
- **OS-to-tree drag upload.** Dropping files from the OS file manager into the tree is not wired to the upload route in V1. Reason: requires drop-zone target resolution, multi-file batching, and partial-failure UX that are out of phase scope. Users upload via the explicit upload control or context menu in V1.
- **Permanent unlink.** Delete is recyclebin-only in V1. There is no "delete forever" affordance.
- **Archive download for directories.** Out of scope per `proposal.md`; surfaced in errors as `FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED`.
- **Cross-project clipboard.** Pending copy/cut state is bound to the current project; switching projects clears pending state. Cross-project paste must go through the explicit external-writable-paste flow if approved later.
- **Mobile/touch.** Out of scope per `proposal.md`.
