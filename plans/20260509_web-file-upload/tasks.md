# Tasks

> **2026-05-09 audit reset.** The prior agent checked Phase 1 boxes without shipping the UI work, and Phase 2 boxes without shipping upload/download. Boxes below reflect actual code on `beta/web-file-upload` (commit `539c2ac820a18b6c29b4d75432b2535a2d3d220f`) plus the new gap-derived sub-phases. Tasks that were checked but not delivered are reset to pending; tasks that genuinely shipped stay checked.

## 1. Desktop File Explorer interaction model

- [x] 1.1 Confirm desktop-only surface can attach to existing FileTree/sidebar path
- [x] 1.2 Confirm ContextMenu UI infrastructure already exists in `packages/ui`
- [x] 1.3 Identify API/state/security gaps before implementation
- [x] 1.7 Write frontend design package in `frontend-design.md`
- [x] 1.8 Inspect current FileTree click/open/expand implementation before coding
- [x] 1.4 Split single-click into select/focus and add double-click activation for files and folders; keep expand/collapse controls single-click. File rows: `onClick` selects, `onDblClick` calls `onFileClick`. Folder rows: row body `onClick` selects + `onDblClick` toggles expand; the chevron is now a discrete `Collapsible.Trigger` button with `stopPropagation` so single-click on the chevron alone toggles. Shipped on `beta/web-file-upload` commit `e370ec683`.
- [x] 1.5 Extend `File.Node` zod schema and `/file` list response with `size` and `modifiedAt`; render dense table columns in `file-tree.tsx`. Backend on commit `8d71362cd` (Promise.all stat + optional fields, files only carry size). Frontend on commit `e370ec683` adds Size + Modified cells per row plus an opt-in header row (`showHeader` prop, default off so legacy callers stay unchanged). Metadata gaps render as empty cells instead of blocking the name column.
- [x] 1.6 Add always-visible checkbox column with header select-all, Shift-click range, Ctrl-click toggle, and a selected-set state object exported to context menu and a selection action strip. Selection signal lives at the root `FileTree` and threads into nested levels via `_selection` / `_setSelection` / `_pathTypes` plumbing. 18 unit tests / 30 expects in `file-tree-selection.test.ts` cover the click-modifier matrix, header toggle, prune, and identity preservation. Effective `contextSelection` auto-builds from the internal set when callers do not pass one, so the existing `fileTreeContextMenuActionGroups` enabled-rule logic sees multi-selection without caller changes. Action-strip component itself is deferred to Phase 4 (it is the natural home for batch action UX); for now selection is exposed via context menu. Commit `e370ec683`.

## 2. Backend file-operation contract

- [x] 2.1 Inspect SDK route generation pattern for Hono OpenAPI file routes
- [x] 2.2a Ship create / rename / move / copy / delete-to-recyclebin / restore-from-recyclebin / destination-preflight routes and `File.OperationResult` schema
- [x] 2.3 Add server-side project-boundary, basename, conflict, recyclebin, and destructive-confirmation guards (see `packages/opencode/src/file/index.ts` `validateBasename`, `assertOperationWithinProject`, `assertDestinationAvailable`, `uniqueRecyclePath`, `ensureWritableDirectory`)
- [x] 2.2b Ship `POST /file/upload` (multipart) and `GET /file/download` routes plus `File.upload` / `File.download` implementations; extend `OperationResult.operation` enum with `"upload"`; add `FILE_UPLOAD_TOO_LARGE` to `OperationCode`. Defines the upload size limit referenced by `spec.md`. (Default cap 64 MiB via `OPENCODE_FILE_UPLOAD_MAX_BYTES` env; `tweaks.cfg` key promotion deferred to a follow-up. SDK regen completed.)
- [x] 2.4 Expand backend tests beyond the current five cases. Required matrix (all 22 tests / 72 expects pass on `beta/web-file-upload` commit `261051164`):
  - [x] rename success + duplicate destination rejection
  - [x] move success + duplicate destination rejection
  - [x] copy success + duplicate destination rejection
  - [x] createDirectory (`type: "directory"`) success path
  - [x] `validateBasename` rejection of `.`, `..`, `/`, `\`, `\0`, empty string
  - [x] delete with `confirmed: false` returns `FILE_OP_CONFIRMATION_REQUIRED`
  - [x] symlink escape: source whose realpath leaves the project is rejected with `FILE_OP_PATH_ESCAPE`
  - [x] recyclebin uniqueness: deleting the same basename twice in <1s yields distinct tombstones
  - [x] destination-preflight external scope happy path (writable temp dir) returns `writable: true`
  - [x] upload happy path, duplicate (`FILE_OP_DUPLICATE`), too-large (`FILE_UPLOAD_TOO_LARGE`), path-escape via embedded `..` filename — shipped with 2.2b
  - [x] download directory rejected with `FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED` — shipped with 2.2b
- [x] 2.6 Wire Bus events from `observability.md` (server side): `file.operation.requested` / `completed` / `rejected` are emitted by every `File` namespace mutation + `File.download`. Implemented via `withTelemetry` wrapper in `packages/opencode/src/file/index.ts`. Blob inputs are redacted to `{ kind, size, type }` so upload bytes never enter the event payload. `Bus.publish` is fire-and-forget; a failed publish only logs at warn and never breaks the operation. Frontend `file.popout.opened` is deferred to Phase 5.x where the pop-out controller lives.

## 3. File explorer action shell

- [x] 3.1 Add row and folder/background context-menu targets to the File tree surface
- [x] 3.2 Add menu grouping and enabled/disabled action rules for file vs directory targets and selected sets. Note: the selected-set branch only becomes end-to-end testable once 1.6 ships.
- [x] 3.0 Frontend integration glue (gate before 3.3):
  - [x] `useFile().applyOperationResult(result)` exposed in `packages/app/src/context/file.tsx`. Walks `result.affectedDirectories` and force-refreshes exactly those branches via `tree.listDir(dir, { force: true })`.
  - [x] Tab reconcile lives in `packages/app/src/context/file/reconcile.ts` (pure, unit-tested) and is invoked by `applyOperationResult`. Tabs themselves stay owned by `layout.tabs(...)`; `file-tabs.tsx` still just renders whatever the layout provides — no edits needed there. rename/move rebind source + descendant tabs, including active. delete-to-recyclebin closes source + descendants and picks the left-neighbor (or right) as new active, matching `tabs.close()` UX.
  - [x] Store + content-cache reconcile: rename/move walks `store.file` keys matching the source (prefix-aware for directories), rebinds them to the destination, and drops the LRU bytes; delete clears matching keys and bytes.
  - [x] 12 unit tests in `reconcile.test.ts` cover the rebind/close/no-op matrix; 40 expects all green.
- [x] 3.3 Wire create file/folder, rename, recoverable delete, restore affordance, upload, and download UI actions to the backend routes; surface stable error codes through toasts. Shipped on `beta/web-file-upload` commit `3e9723b8b`.
  - `runAction(id, target)` dispatch in `file-tree.tsx` covers all action ids from `fileTreeContextMenuActionGroups`. Each successful mutation calls `useFile().applyOperationResult(result)` so Phase 3.0 reconcile fires automatically.
  - delete honours multi-row selection: clicking delete on a row that is itself part of the active selection batches over the whole selection; otherwise acts only on the clicked row.
  - upload triggers a programmatic click on a hidden multi-file `<input type="file">` rendered at the FileTree root; per-file results aggregate into one batch toast and the target folder refreshes once at the end.
  - download issues a `sdk.fetch` against `/api/v2/file/download?directory=&path=` and saves the resulting Blob via a programmatic `<a download>` anchor.
  - errors surface stable codes via `surfaceError`, extracting `err.data.code` / `err.data.message` from the hey-api error envelope.
  - copy / cut / paste are deferred to Phase 4 — selecting them shows a friendly "Not available yet" info toast.
  - V1 UX limitation: name prompt + delete confirm use `window.prompt` / `window.confirm`; Phase 7 polish replaces with in-app dialogs.

## 4. Clipboard-style operations

- [x] 4.1 Add in-app pending copy/cut state with visible source set and operation mode. Shipped on `beta/web-file-upload` commit `c9aab97bc`. `ClipboardState` signal lives at the root `FileTree` and threads via `_clipboard`/`_setClipboard` plumbing; `runClipboard(target, mode)` honours multi-row selection, surfaces a confirm toast, and dims cut rows via `data-filetree-cut="true"` + `opacity-60`.
- [x] 4.2 Add paste/move execution inside active project with source and destination folder refresh. Same commit. `runPaste` dispatches `sdk.client.file.move` (cut) or `sdk.client.file.copy` (copy), iterates entries, and feeds each result into `useFile().applyOperationResult` so the Phase 3.0 reconcile fires per item. Cut clears the clipboard on success; copy persists for repeated paste.
- [x] 4.3 Add explicit writable-location paste flow with resolved destination and permission result via `file.destinationPreflight`. Shipped on `beta/web-file-upload` commit `ba35a6f91`. `File.copy` / `File.move` accept an optional `scope: "active-project" | "external"` parameter; default preserves V1 behaviour byte-equivalent. External scope canonicalizes via `path.resolve`, requires an existing writable directory, and bypasses `assertOperationWithinProject` only for the destination — source must still live inside the active project. Frontend adds a `paste-external` context-menu action that runs `destinationPreflight` first, shows the canonical path via `window.confirm`, then dispatches per-entry `move`/`copy` with `scope: "external"`. SDK regen exposes the new field on `FileMoveData` / `FileCopyData`.
- [x] 4.4 Add conflict handling and disabled paste reasons. `effectiveHasPendingClipboard` memo merges the new internal clipboard with the existing `props.hasPendingClipboard` so the existing `fileTreeContextMenuActionGroups` paste-disable rule flips state automatically when copy/cut lands. Per-entry SDK errors (e.g. `FILE_OP_DUPLICATE`) surface via `surfaceError` as a stable-code toast.

## 5. Independent window pop-out surfaces

- [x] 5.1 Survey existing pop-out scaffolding: `packages/app/src/pages/session/terminal-panel.tsx` already implements terminal pop-out via `window.open` + the `terminal-popout` route registered in `packages/app/src/app.tsx`; the `popoutWindow` signal pattern is the reference shape. Reused in 5.2 / 5.3.
- [x] 5.2 Add File Explorer pop-out control and focused independent-window route mirroring the `terminal-popout` pattern. Shipped on `beta/web-file-upload` commit `2ce4ba89b`. New page `pages/session/file-explorer-popout.tsx` renders `<FileTree showHeader>` with the same minimal title-bar chrome contract (no SessionHeader, no app sidebar). New route `/:dir/session/:id?/file-explorer-popout` registered in `app.tsx`. Pop-out trigger lives in the tool sidebar header strip (`session-side-panel.tsx`, files mode) and uses a centered `window.open`. V1 caveat: double-click in the popped window doesn't open files cross-window — single-row mutations all work.
- [x] 5.3 Add file-view tab pop-out control, viewer-specific independent-window layout, and source-tab removal after success. Same commit. New page `pages/session/file-view-popout.tsx` reads `?path=` and renders text / code / SVG / image / binary fallback via `useFile().load`. New route `/:dir/session/:id?/file-view-popout`. Pop-out button added to `FileTabMenu` (the active-tab dot-grid menu); on success the source tab is closed via `layout.tabs.close(activeTab)`. Rich PDF / HTML / Markdown rendering paths fall back to a "use the docked tab" message — reusing FileTabContent inside the popout would drag in many session-bound deps, deferred.
- [x] 5.4 Extend the existing terminal pop-out so the original terminal pane is removed/collapsed (no placeholder) and the popped window renders only terminal chrome — no app sidebar, no global header. Shipped on `beta/web-file-upload` commit `dfae4ced0`. `terminal-panel.tsx` switches the panel's inline height to `auto` while popped (only the tabs row remains visible, hosting the re-dock toggle); the prior "Terminal popped out" placeholder body is removed. `terminal-popout.tsx` drops `SessionHeader` and renders an `h-8` minimal title bar with session title + terminal label + a × close button that calls `window.close()`.

## 6. Validation and docs sync

- [x] 6.1 Run focused backend/frontend tests including the expanded 2.4 matrix. Final tally on `beta/web-file-upload` after 4.3: backend `operations.test.ts` 30 tests / 98 expects; frontend `file-tree.test.ts` + `file-tree-selection.test.ts` + `context/file/reconcile.test.ts` 38 tests / 98 expects. Total 68 tests / 196 expects, all green. tsgo --noEmit reports 0 plan-related TS errors (commit `588928d8b` cleaned up the only two: download error path needed the same `c.json` shim cast `fileOperationResponse` already uses, and the clipboard "Copied"/"Cut" toast variant `"info"` is not in `ToastVariant`, switched to `"default"`). The 42 remaining `opencode` package TS errors are all pre-existing baseline (`session/message-v2`, `session/resolve-tools`, `console-function`) flagged in `handover.md` and are not from this plan.
- [ ] 6.2 Verify metadata display, double-click activation, batch selection, context menu, CRUD, upload/download, copy/cut/paste, and pop-out flows manually or with Playwright if local runtime is available
- [ ] 6.3 Update `docs/events/event_20260509_web-file-upload.md` and architecture sync notes; promote the package into the right `/specs/` family per beta-workflow §5 (only after `beta/web-file-upload` is finalized into `main`)

## Dependency notes

- 3.2 enabled-rule UX is only end-to-end testable after 1.6 ships selection state; the action rules themselves are unit-tested in `file-tree.test.ts`.
- 3.3 is the gate for any user-visible mutation. Pre-conditions: 1.6, 2.2b, 3.0.
- 4.3 external paste cannot ship until `File.copy` / `File.move` are extended to accept a preflight-issued external destination handle; current implementations both call `assertOperationWithinProject` on the destination, so silent extension would break the safety contract.
- 5.x reuses the existing `terminal-popout` route registration; no new top-level route plumbing should be invented before reading `app.tsx`.
- 6.3 spec promotion follows the beta-workflow disposable-surface rule (§5–§8); only after `beta/web-file-upload` is finalized into `main`.
