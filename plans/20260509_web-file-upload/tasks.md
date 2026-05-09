# Tasks

> **2026-05-09 audit reset.** The prior agent checked Phase 1 boxes without shipping the UI work, and Phase 2 boxes without shipping upload/download. Boxes below reflect actual code on `beta/web-file-upload` (commit `539c2ac820a18b6c29b4d75432b2535a2d3d220f`) plus the new gap-derived sub-phases. Tasks that were checked but not delivered are reset to pending; tasks that genuinely shipped stay checked.

## 1. Desktop File Explorer interaction model

- [x] 1.1 Confirm desktop-only surface can attach to existing FileTree/sidebar path
- [x] 1.2 Confirm ContextMenu UI infrastructure already exists in `packages/ui`
- [x] 1.3 Identify API/state/security gaps before implementation
- [x] 1.7 Write frontend design package in `frontend-design.md`
- [x] 1.8 Inspect current FileTree click/open/expand implementation before coding
- [ ] 1.4 Split single-click into select/focus and add double-click activation for files and folders; keep expand/collapse controls single-click. (No `onDblClick` handler exists in `file-tree.tsx` today.)
- [ ] 1.5 Extend `File.Node` zod schema and `/file` list response with `size` and `modifiedAt`; render dense table columns in `file-tree.tsx`; ensure metadata gaps do not block name/type render. (Schema currently only exposes `name`/`path`/`absolute`/`type`/`ignored`.)
- [ ] 1.6 Add always-visible checkbox column with header select-all, Shift-click range, Ctrl-click toggle, and a selected-set state object exported to context menu and a selection action strip. (No `checkbox`/`Shift`/`Ctrl`/`batch` symbol exists in `file-tree.tsx` today.)

## 2. Backend file-operation contract

- [x] 2.1 Inspect SDK route generation pattern for Hono OpenAPI file routes
- [x] 2.2a Ship create / rename / move / copy / delete-to-recyclebin / restore-from-recyclebin / destination-preflight routes and `File.OperationResult` schema
- [x] 2.3 Add server-side project-boundary, basename, conflict, recyclebin, and destructive-confirmation guards (see `packages/opencode/src/file/index.ts` `validateBasename`, `assertOperationWithinProject`, `assertDestinationAvailable`, `uniqueRecyclePath`, `ensureWritableDirectory`)
- [ ] 2.2b Ship `POST /file/upload` (multipart) and `GET /file/download` routes plus `File.upload` / `File.download` implementations; extend `OperationResult.operation` enum with `"upload"`; add `FILE_UPLOAD_TOO_LARGE` to `OperationCode`. Defines the upload size limit referenced by `spec.md`.
- [ ] 2.4 Expand backend tests beyond the current five cases. Required matrix:
  - rename success + duplicate destination rejection
  - move success + duplicate destination rejection
  - copy success + duplicate destination rejection
  - createDirectory (`type: "directory"`) success path
  - `validateBasename` rejection of `.`, `..`, `/`, `\`, `\0`, empty string
  - delete with `confirmed: false` returns `FILE_OP_CONFIRMATION_REQUIRED`
  - symlink escape: source whose realpath leaves the project is rejected with `FILE_OP_PATH_ESCAPE`
  - recyclebin uniqueness: deleting the same basename twice in <1s yields distinct tombstones
  - destination-preflight external scope happy path (writable temp dir) returns `writable: true`
  - upload happy path, duplicate (`FILE_OP_DUPLICATE`), too-large (`FILE_UPLOAD_TOO_LARGE`), path-escape via embedded `..` filename
  - download directory rejected with `FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED`
- [ ] 2.6 Wire Bus events from `observability.md`: emit `file.operation.requested` / `rejected` / `completed` from the `File` namespace mutation entry points; emit `file.popout.opened` from the frontend pop-out controllers. Document redaction rules for paths in event payloads.

## 3. File explorer action shell

- [x] 3.1 Add row and folder/background context-menu targets to the File tree surface
- [x] 3.2 Add menu grouping and enabled/disabled action rules for file vs directory targets and selected sets. Note: the selected-set branch only becomes end-to-end testable once 1.6 ships.
- [ ] 3.0 Frontend integration glue (new gate before 3.3):
  - In `packages/app/src/context/file.tsx`, consume `OperationResult.affectedDirectories` to refresh exactly those tree branches instead of full reloads.
  - In `packages/app/src/pages/session/file-tabs.tsx`, reconcile open file tabs on rename/move/delete using `OperationResult.source` / `destination`. Close tabs that point at deleted paths; rebind tabs whose path was moved or renamed.
- [ ] 3.3 Wire create file/folder, rename, recoverable delete, restore affordance, upload, and download UI actions to the backend routes; surface stable error codes through toasts; depends on 1.6 (selection set), 2.2b (upload/download routes), and 3.0 (refresh + tab reconcile).

## 4. Clipboard-style operations

- [ ] 4.1 Add in-app pending copy/cut state with visible source set and operation mode
- [ ] 4.2 Add paste/move execution inside active project with source and destination folder refresh (consumes `affectedDirectories` from 3.0)
- [ ] 4.3 Add explicit writable-location paste flow with resolved destination and permission result via `file.destinationPreflight`; depends on a follow-up to extend `File.copy` / `File.move` to accept external destinations after a successful preflight token (currently both functions reject any destination outside the active project)
- [ ] 4.4 Add conflict handling and disabled paste reasons

## 5. Independent window pop-out surfaces

- [ ] 5.1 Survey existing pop-out scaffolding: `packages/app/src/pages/session/terminal-panel.tsx` already implements terminal pop-out via `window.open` + the `terminal-popout` route registered in `packages/app/src/app.tsx`; the `popoutWindow` signal pattern is the reference shape. Reuse — do not reinvent.
- [ ] 5.2 Add File Explorer pop-out control and focused independent-window route mirroring the `terminal-popout` pattern
- [ ] 5.3 Add file-view tab pop-out control, viewer-specific independent-window layout, and source-tab removal after success
- [ ] 5.4 Extend the existing terminal pop-out so the original terminal pane is removed/collapsed (no placeholder) and the popped window renders only terminal chrome — no app sidebar, no global header. (Current implementation opens the pop-out but does not vacate the source pane.)

## 6. Validation and docs sync

- [ ] 6.1 Run focused backend/frontend tests including the expanded 2.4 matrix
- [ ] 6.2 Verify metadata display, double-click activation, batch selection, context menu, CRUD, upload/download, copy/cut/paste, and pop-out flows manually or with Playwright if local runtime is available
- [ ] 6.3 Update `docs/events/event_20260509_web-file-upload.md` and architecture sync notes; promote the package into the right `/specs/` family per beta-workflow §5 (only after `beta/web-file-upload` is finalized into `main`)

## Dependency notes

- 3.2 enabled-rule UX is only end-to-end testable after 1.6 ships selection state; the action rules themselves are unit-tested in `file-tree.test.ts`.
- 3.3 is the gate for any user-visible mutation. Pre-conditions: 1.6, 2.2b, 3.0.
- 4.3 external paste cannot ship until `File.copy` / `File.move` are extended to accept a preflight-issued external destination handle; current implementations both call `assertOperationWithinProject` on the destination, so silent extension would break the safety contract.
- 5.x reuses the existing `terminal-popout` route registration; no new top-level route plumbing should be invented before reading `app.tsx`.
- 6.3 spec promotion follows the beta-workflow disposable-surface rule (§5–§8); only after `beta/web-file-upload` is finalized into `main`.
