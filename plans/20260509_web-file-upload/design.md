# Design

## Context

OpenCMS already has a desktop WebApp File tab backed by server file routes and project-boundary helpers. This design evolves that surface into a safer desktop File Explorer while preserving server-authoritative path resolution, explicit operation results, and fail-fast error behavior.

## Goals / Non-Goals

### Goals

- Provide desktop File Explorer interactions for metadata browsing, selection, context menus, CRUD, upload/download, copy/cut/paste, recoverable delete, and pop-out windows.
- Keep all filesystem mutations behind explicit backend contracts and stable error codes.
- Reuse existing FileTree, file context, Hono route, ContextMenu, and project-boundary infrastructure where possible.
- Reconcile affected tree folders, open file tabs, and source panes after mutations or pop-outs.

### Non-Goals

- Do not implement mobile/touch gestures in the initial plan.
- Do not add silent overwrite, auto-rename, fallback destination, or archive/zip directory download.
- Do not implement external writable paste without canonical destination preflight and explicit user-visible permission result.
- Do not stage, commit, or otherwise mutate git state as part of file operations.

## Existing Evidence

- `specs/architecture.md` marks `packages/app/src/pages/session/file-tabs.tsx` as the file-tab authority surface.
- `packages/opencode/src/server/routes/file.ts` currently exposes file list, create-directory, stat, read, and status routes; no upload/write route exists.
- `packages/opencode/src/file/index.ts` already contains project-boundary helpers based on `Instance.directory`, realpath, and parent-realpath checks.
- `packages/app/src/context/file.tsx` owns file tree loading/refreshing via `sdk.client.file.list`.
- `packages/app/src/components/file-tree.tsx` already renders file and directory rows and owns row-level click/drag behavior; it is the natural context-menu attachment point.
- `packages/ui/src/components/context-menu.tsx` and `context-menu.css` already wrap Kobalte context menus, so desktop right-click menus can reuse existing UI infrastructure.
- `packages/app/src/pages/session.tsx` gates desktop file tree behavior with `isDesktop()` and `layout.fileTree.opened()`; mobile file-pane rendering is a separate path and is out of scope for this plan.
- `packages/app/src/pages/session/session-side-panel.tsx` already has an active-file download implementation using loaded file content and `Blob`, but it is tab-scoped, not tree-row-scoped.
- `packages/app/src/components/dialog-select-directory.tsx` already implements an absolute directory picker and create-directory flow for opening projects; it is useful evidence for writable destination UX but not sufficient as-is for hidden paste writes.

## Decisions

- **DD-1** Replace the upload-only concept with a file-operation contract covering create, rename, move, copy, delete, upload, and download.
- **DD-2** Keep server-side path resolution authoritative for every operation; the UI may propose targets but cannot decide final paths.
- **DD-3** The server rejects path traversal and symlink escapes using the existing project-boundary model.
- **DD-4** The frontend refreshes only affected directories after successful mutations: source parent, destination parent, or active target folder depending on operation.
- **DD-5** Same-name collisions are rejected by default; no auto-rename or overwrite fallback is allowed unless a later explicit overwrite-confirmation phase is approved.
- **DD-6** Right-click context menu is the primary entry for row-scoped operations; toolbar/empty-state controls may expose create/upload/paste for the current folder.
- **DD-7** Copy/cut is modeled as in-app pending operation state, not as OS clipboard mutation. Paste executes through the server API with explicit source and destination paths.
- **DD-8** Delete is destructive and requires confirmation. Rename/move/copy/upload fail fast on conflicts instead of silently changing names.
- **DD-9** Delete moves targets into repo-local `recyclebin/` with restore metadata instead of immediately unlinking files.
- **DD-10** User wants paste to any path the current user can write; this supersedes strict active-project-only paste and requires a separate explicit destination/permission model before implementation.
- **DD-11** This feature targets desktop WebApp only. Mobile/touch context-menu and gesture design are explicitly deferred.
- **DD-12** File-operation routes should follow the existing Hono + `hono-openapi` route pattern in `packages/opencode/src/server/routes/file.ts`: `describeRoute`, `validator`, `resolver`, and stable `operationId` values under the `file.*` namespace so SDK methods remain predictable.
- **DD-13** Mutation responses return a normalized operation result instead of raw filesystem output: operation kind, source path when applicable, destination path when applicable, affected directories to refresh, and optional node metadata.
- **DD-14** Writable external paste is not part of the first mutation endpoint set. It requires a separate preflight endpoint that returns canonical destination and write permission result, followed by an explicit execute request using that preflight result.
- **DD-15** File rows should expose size and modified date; directory size should not be recursively calculated in the first implementation unless explicitly approved.
- **DD-16** File and folder row body activation changes from single-click to double-click. Single-click becomes select/focus. Explicit expand/collapse controls remain single-click.
- **DD-17** Batch selection is a first-class mode for multi-item copy, cut, paste, and recoverable delete. Mixed selections must be validated before enabling batch actions.
- **DD-18** File Explorer and file-view tabs need pop-out-to-independent-window controls with shared session/project context.
- **DD-19** Terminal pop-out must reclaim the original terminal tab/pane footprint in the main layout and render a terminal-focused window without duplicating the app sidebar or top header.
- **DD-20** File Explorer layout uses a dense table/list by default with columns for name, size, and modified date.
- **DD-21** Batch selection uses an always-visible checkbox column plus Shift-click range selection and Ctrl-click item toggling.
- **DD-22** After successful file-view or terminal pop-out, the source tab/pane is removed or collapsed without leaving a placeholder in the main app.
- **DD-23** The durable frontend design contract is recorded in `plans/20260509_web-file-upload/frontend-design.md`.

## Feasibility Assessment

- **Overall**: feasible, but it should be treated as a medium-to-large feature rather than a small FileTree patch.
- **Low-risk foundations**: FileTree row rendering, tree refresh state, tab opening/loading, Kobalte ContextMenu wrappers, and active-file download behavior already exist.
- **Backend gap**: current File API only supports list/read/stat/status/create-directory. It lacks create-file, rename, move, copy, recoverable delete, restore, upload, and row-scoped download endpoints.
- **Frontend gap**: FileTree has row-level click and drag but no context-menu action model, no selected target state, no clipboard operation state, no inline rename/create dialogs, and no tree-background target surface.
- **State gap**: mutations must reconcile tree nodes, expanded directories, loaded file content cache, active file tabs, comments/selection state, review diff markers, and file freshness polling.
- **Security gap**: active project boundary is already modeled, but user-writable external paste needs a new canonicalization + permission-probe contract and must not become a silent path escape.
- **Desktop-only simplification**: because `session.tsx` already separates desktop file tree from mobile file pane, first implementation can stay behind the desktop FileTree/sidebar path and skip touch gestures.

## Gap List

1. **API contract gap**: add explicit operation endpoints and response/error schema rather than ad-hoc route additions.
2. **Filesystem safety gap**: expose or refactor project-boundary helpers for mutation operations; add writable external destination probing for the later paste phase. Symlink escape rejection is a named requirement (`spec.md`); tests must exercise it explicitly.
3. **Recyclebin gap**: define repo-local tombstone naming, metadata format, restore conflict behavior, and whether `recyclebin/` is hidden or shown in the tree. **Resolved in `spec.md`**: hidden by default, exposed via toggle, added to git-ignore on first delete where writable.
4. **Tree action gap**: add context menu target modeling for file rows, directory rows, and current-folder/background area.
5. **Dialog/input gap**: add compact create/rename/delete confirmation flows; reuse existing Dialog primitives but avoid mixing project-open directory picker semantics with file-operation semantics.
6. **Clipboard gap**: model copy/cut source, mode, project/directory scope, target validity, and stale-source handling.
7. **Tab reconcile gap**: rename/move/delete must update or close open file tabs that reference changed paths; stale content cache entries must be invalidated.
8. **Download gap**: active-tab Blob download exists, but tree-row download should be server-backed or explicitly load row content before download; directory archive download remains out of scope.
9. **Validation gap**: needs backend file-operation tests plus desktop browser verification of context-menu placement, disabled states, mutation refresh, and conflict errors.
10. **Metadata display gap**: `File.Node` currently does not document size or modified-date fields in this plan; either list responses must grow metadata or the UI needs a dedicated metadata-loading strategy.
11. **Activation gap**: existing row click behavior is intentionally too eager for explorer semantics; double-click activation and single-click selection/focus need separate state transitions.
12. **Batch selection gap**: current action model is row-scoped; multi-selection needs selected-set state, range/checkbox behavior, action validation, and batch confirmation UX.
13. **Pop-out window gap**: independent windows need route/state identity, session/project context propagation, and cleanup rules for the source pane. **Reuse evidence**: `terminal-panel.tsx` already implements `popoutWindow` via `window.open` against the `terminal-popout` route registered in `app.tsx`. New pop-out surfaces must mirror this pattern, not invent new routing.
14. **Terminal layout gap**: terminal pop-out needs a minimal chrome mode and main-layout vacancy behavior rather than duplicating the full app shell. The existing pop-out opens correctly but does **not** vacate the source pane; that's the actual delta to ship.
15. **Upload size limit gap**: `FILE_UPLOAD_TOO_LARGE` is named in `errors.md` but has no enforcement code, no enum entry, and no default size value. Phase 2.5 must define and enforce the limit (see `spec.md` Requirement: Enforce upload size limit).
16. **Observability wiring gap**: `observability.md` enumerates Bus events (`file.operation.requested`/`rejected`/`completed`/...), but no `Bus.publish` site exists yet. Phase 2.6 wires them; until then, the events spec is documentation-only.
17. **Drag-and-drop gap**: existing `file-tree.tsx` has row-level drag with legacy semantics. V1 explicitly does not repurpose it for move/copy/upload (see `spec.md` §Out of Scope). Recorded so future plan increments do not silently re-introduce drag behaviour while the new selection model is being built.

## Risks / Trade-offs

- **Filesystem safety risk**: expanding from read/list to mutation endpoints increases blast radius. Mitigation: server-authoritative path guards, basename validation, stable errors, and no fallback destinations.
- **External writable paste risk**: user-requested writable destinations can escape active project semantics. Mitigation: keep this behind a separate preflight/execute model and do not include it in the first active-project mutation set.
- **State reconcile risk**: rename/move/delete can invalidate open tabs, cached file content, comments, and tree expansion state. Mitigation: normalized mutation responses include affected directories and old/new paths for targeted reconciliation.
- **Interaction regression risk**: changing single-click open behavior could surprise existing users. Mitigation: keep expand/collapse controls explicit and document single-click as select/focus, double-click as activation.
- **Pop-out lifecycle risk**: independent windows require coherent session/project context and source-pane cleanup. Mitigation: treat pop-out as a dedicated layout state, not a duplicated full app shell.

## Backend API Contract Draft

### Route style

- Add routes in `packages/opencode/src/server/routes/file.ts` using the existing Hono chain style.
- Each route must define `describeRoute({ operationId: "file.<verb>" })`, request validation via `validator`, and response schemas via `resolver`.
- Filesystem behavior should live in `packages/opencode/src/file/index.ts` under the `File` namespace so routes remain thin.
- Error responses should use stable error codes from `errors.md`; implementation should avoid string-matching thrown `Error` messages as the API contract.

### Shared schemas

- `FileOperationResult`: `{ operation, source?, destination?, node?, affectedDirectories }`.
- `operation`: one of `create-file`, `create-directory`, `rename`, `move`, `copy`, `delete-to-recyclebin`, `restore-from-recyclebin`, `upload`.
- `source`: normalized relative project path when an existing item is the input.
- `destination`: normalized relative project path for newly created, moved, copied, uploaded, deleted tombstone, or restored item.
- `node`: optional `File.Node` for operations that create or reveal a project-tree item.
- `affectedDirectories`: normalized relative directory paths the frontend should refresh after success.

### Endpoint candidates

| Method | Path                          | operationId                  | Request                                                      | Response                               | Notes                                                                         |
| ------ | ----------------------------- | ---------------------------- | ------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------- |
| `POST` | `/file/create`                | `file.create`                | `{ parent, name, type }` where type is `file` or `directory` | `FileOperationResult`                  | Supersedes adding more type-specific create routes; duplicate names rejected. |
| `POST` | `/file/rename`                | `file.rename`                | `{ path, name }`                                             | `FileOperationResult`                  | `name` must be basename only; parent is preserved.                            |
| `POST` | `/file/move`                  | `file.move`                  | `{ source, destinationParent }`                              | `FileOperationResult`                  | Active-project only in Phase 1/3; duplicate destination rejected.             |
| `POST` | `/file/copy`                  | `file.copy`                  | `{ source, destinationParent }`                              | `FileOperationResult`                  | Active-project only in Phase 1/3; duplicate destination rejected.             |
| `POST` | `/file/delete`                | `file.deleteToRecyclebin`    | `{ path, confirmed }`                                        | `FileOperationResult`                  | Requires `confirmed: true`; moves to repo-local `recyclebin/`.                |
| `POST` | `/file/restore`               | `file.restoreFromRecyclebin` | `{ tombstonePath }`                                          | `FileOperationResult`                  | Reads restore metadata; rejects restore conflicts.                            |
| `POST` | `/file/upload`                | `file.upload`                | multipart form: `parent`, `file`                             | `FileOperationResult`                  | Uses browser filename basename only; duplicate rejected.                      |
| `GET`  | `/file/download`              | `file.download`              | query `{ path }`                                             | bytes stream                           | File only; directory returns `FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED`.           |
| `POST` | `/file/destination/preflight` | `file.destinationPreflight`  | `{ destinationParent, scope }`                               | `{ canonicalPath, writable, reason? }` | Required before any approved external writable paste.                         |

### Non-fallback rules

- No route may auto-rename, overwrite, or silently switch destination on conflict.
- No route may silently expand active-project mutation into external filesystem mutation.
- No route may treat an invalid basename as a relative path; names containing path separators, `.` or `..` are invalid.
- No delete route may permanently unlink in the initial implementation; delete means move to recyclebin only.

## Frontend Design Guidance

### Workflow: Dense table/list browsing

- **Entry point**: File tab desktop sidebar or File Explorer pop-out.
- **Visible fields**: checkbox, expander, icon/type, name/path, size, modified date, optional git/status marker.
- **Primary action**: double-click opens files or enters folders.
- **Secondary actions**: right-click context menu, copy path, refresh folder, pop out explorer.
- **Menu groups**: navigation; create/upload; clipboard; rename/move; destructive.
- **Layout zones**: toolbar, selection/action strip, table header, dense rows, status/footer strip.
- **States**: loading metadata, metadata partial, focused row, selected row, multi-selected rows, action pending, action rejected.

### Workflow: Row context actions

- **Entry point**: right-click or keyboard context-menu action on a file-tree row.
- **Visible fields**: item name, item type, relative path, file size, modified date, git/modified marker if already shown, disabled actions with reason where possible.
- **Primary action**: double-click opens files or enters/opens folders. Single-click selects/focuses the row. Dedicated expand/collapse controls remain single-click.
- **Secondary actions**: rename, duplicate/copy, cut, delete, download, reveal/open, copy relative path.
- **Menu groups**: navigation; create/upload/download; clipboard; rename/move; destructive.
- **States**: idle, focused, selected, multi-selected, menu open, action pending, action success, action rejected, confirmation required.

### Workflow: Batch selection and multi-file operations

- **Entry point**: always-visible checkbox column, Shift-click range selection, Ctrl-click item toggling, or header select-all checkbox in the desktop File Explorer.
- **Visible fields**: selected count, representative paths, current target folder, pending copy/cut mode, and disabled action reasons for invalid mixed selections.
- **Primary action**: perform copy/cut/delete on the selected set, or paste the pending selected set into a valid folder.
- **Secondary actions**: clear selection, select all in folder, invert selection if later approved, copy selected paths.
- **Menu groups**: selection management; clipboard; destructive.
- **States**: selection off, selection empty, partial selection, all-visible selected, batch action pending, batch conflict, batch confirmation required.

### Workflow: Folder/background actions

- **Entry point**: right-click on a directory row or empty tree/background area representing the current folder.
- **Visible fields**: target folder path and pending clipboard source if any.
- **Primary action**: create new file/folder or upload into this folder.
- **Secondary actions**: paste, refresh, copy folder path, download folder if later approved.
- **States**: no clipboard, copy pending, cut pending, paste disabled due to conflict or invalid destination.

### Workflow: Recoverable delete and restore

- **Entry point**: Delete from context menu.
- **Input interface**: confirmation dialog showing source path and recyclebin destination behavior.
- **Output interface**: item disappears from original tree, `recyclebin/` refreshes if visible, toast offers a restore affordance if practical.
- **State changes**: original item is moved to `recyclebin/` using collision-safe naming; restore metadata records original path, deleted-at timestamp, item type, and tombstone path.
- **Non-goal**: no permanent unlink in the first implementation phase.

### Workflow: Writable-location paste

- **Entry point**: Paste action after copy/cut.
- **Input interface**: destination picker or explicit path field if destination is outside the currently visible project tree.
- **Output interface**: confirmation/error surface showing resolved destination and whether the current user can write there.
- **State changes**: paste is blocked until destination canonicalization and permission probing succeed.
- **Open design issue**: this flow expands beyond active project file-tree semantics and must not be implemented as silent path escape from the current tree.

### Workflow: Rename/move dialogs

- **Input interface**: compact inline rename for simple rename; modal/dialog for move destination if browsing/searching target folders is required.
- **Output interface**: refreshed file tree and toast with exact operation result.
- **Configuration interface**: no overwrite toggle in MVP; conflict rejection is explicit.

### Workflow: File Explorer pop-out

- **Entry point**: pop-out button in the File Explorer toolbar/sidebar header.
- **Visible fields**: project/session identity, current folder, selected count, pending clipboard state if applicable.
- **Primary action**: open File Explorer in an independent window focused on the same folder context.
- **Secondary actions**: refresh, clear selection, close pop-out.
- **Layout zones**: compact window title bar, folder/action toolbar, file list, optional status/footer strip.
- **States**: main-only, pop-out opening, pop-out active, pop-out closed, context sync error.

### Workflow: File-view tab pop-out

- **Entry point**: pop-out button on each file-view tab or file-view toolbar.
- **Visible fields**: file path, dirty/staleness state if available, file type/viewer mode, project/session identity.
- **Primary action**: open the current file viewer in an independent window.
- **Secondary actions**: close pop-out, download.
- **Layout zones**: minimal file-view title bar, viewer content, optional status strip.
- **States**: embedded, pop-out opening, popped out with source tab removed, stale file, closed.

### Workflow: Terminal pop-out minimal window

- **Entry point**: pop-out button on a terminal tab/pane.
- **Visible fields**: terminal title/session name, connection/running status, close/rejoin controls.
- **Primary action**: move the terminal surface into an independent window and reclaim the original terminal layout space.
- **Secondary actions**: close terminal, copy title/path if already supported.
- **Layout zones**: terminal-specific title bar and terminal content only. No app sidebar and no global top header.
- **States**: embedded, pop-out opening, popped out with source pane removed/collapsed, pop-out closed, terminal ended.

## Frontend Design Artifact

- See `plans/20260509_web-file-upload/frontend-design.md` for the design brief, aesthetic direction, design token intent, layout map, component inventory, interaction map, motion spec, implementation slices, and template database hints.

## Phasing

> 2026-05-09 audit revision. The phase list below is the authoritative ordering. `tasks.md` mirrors it with concrete checkboxes and dependency notes.

- **Phase 1** — Desktop File Explorer interaction model: metadata columns (1.5), double-click activation and single-click select/focus (1.4), and batch-selection state (1.6).
- **Phase 2** — Backend file-operation API contracts and safety:
  - **2.2a** create / rename / move / copy / delete-to-recyclebin / restore / destination-preflight (shipped on `beta/web-file-upload`).
  - **2.2b** upload (multipart) and download routes plus `FILE_UPLOAD_TOO_LARGE` enum entry and `OperationResult.operation = "upload"` extension.
  - **2.4** expanded test matrix (rename/move/copy duplicate, basename rejection, symlink escape, recyclebin uniqueness, preflight external happy path, upload/download cases).
  - **2.6** observability: emit `file.operation.requested`/`rejected`/`completed` Bus events from the `File` namespace.
- **Phase 3** — File explorer action shell:
  - **3.0** frontend integration glue in `context/file.tsx` (`affectedDirectories` consumption) and `pages/session/file-tabs.tsx` (tab reconcile on rename/move/delete).
  - **3.1 / 3.2** context-menu targets and enabled-rule model (shipped).
  - **3.3** wire create / rename / recoverable-delete / restore / upload / download UI actions to the routes.
- **Phase 4** — In-app clipboard state with multi-item copy/cut/paste/move inside active project. External writable paste (4.3) requires extending `File.copy` / `File.move` to accept a preflight-issued external destination handle; current implementations both reject external destinations.
- **Phase 5** — Pop-out surfaces:
  - **5.1** survey existing `terminal-popout` route and `popoutWindow` pattern in `terminal-panel.tsx` / `app.tsx`.
  - **5.2** File Explorer pop-out mirroring the same pattern.
  - **5.3** file-view tab pop-out with source-tab removal on success.
  - **5.4** terminal pop-out source-pane vacancy + minimal chrome (delta on the existing implementation).
- **Phase 6** — Explicit writable-location paste design and implementation if approved (depends on 4.3 mutation-side changes).
- **Phase 7** — Polish: keyboard accessibility, disabled menu reasons, conflict messaging, E2E coverage.

## Critical Files

- `packages/opencode/src/file/index.ts` — `File` namespace: schema, operation codes, mutation entry points, project-boundary helpers, recyclebin manager.
- `packages/opencode/src/server/routes/file.ts` — Hono routes; mutation surface for the SDK.
- `packages/app/src/context/file.tsx` — file-tree state, refresh, content cache. Phase 3.0 consumes `affectedDirectories` here.
- `packages/app/src/components/file-tree.tsx` — row rendering, click/drag, context-menu attachment.
- `packages/app/src/pages/session/file-tabs.tsx` — open file tabs; Phase 3.0 reconciles them on rename/move/delete using `OperationResult.source` / `destination`.
- `packages/app/src/pages/session/terminal-panel.tsx` — existing terminal pop-out via `window.open` and `popoutWindow` signal. Reuse pattern in Phase 5.2 / 5.3; modify in 5.4 to vacate the source pane.
- `packages/app/src/app.tsx` — independent-window route registration (`terminal-popout` lives here). Phase 5.2 / 5.3 add sibling routes.
- SDK generated/client types in `packages/sdk/js/src/v2/gen/` — regenerated when routes land.

## Reconnaissance evidence (2026-05-09 audit)

- Terminal pop-out is already wired: `terminal-panel.tsx:35` (`popoutWindow` signal), `:53-61` (URL composition + `window.open`), `app.tsx:35` (`TerminalPopout` lazy import), `app.tsx:272` (route registration). Treating Phase 5.4 as greenfield work — as the prior agent did — would have duplicated this scaffolding.
- `packages/app/src/pages/session/session-side-panel.tsx:131` already uses `URL.createObjectURL(blob)` + `window.open` for active-tab download. This is tab-scoped, not row-scoped, so Phase 2.2b still needs a server-backed download route, but the UX pattern for triggering a download is established.
- `packages/app/src/components/dialog-select-directory.tsx` is the existing absolute-directory picker. Useful evidence for the writable-paste UX (Phase 4.3 / 6) but must not be silently reused as the file-operation path picker — its semantics are project-open, not file-mutation.

## Security Notes

- Browser-provided filenames are untrusted input.
- Destination directory is untrusted input.
- File bytes may be binary; implementation must preserve bytes and avoid text decoding unless explicitly required by platform APIs.
- Upload must reject absolute/relative paths embedded in filenames; only the basename is accepted.
- Any paste outside the active project boundary must expose canonical destination and permission result to the user before writing.
- Recyclebin restore metadata must not allow path traversal on restore.
