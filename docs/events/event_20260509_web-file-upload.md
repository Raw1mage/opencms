# Event: WebApp File Tab Explorer Operations

## Requirement

User first requested a WebApp feature to upload files through the project File tab, then expanded the requirement into an advanced File tab file-explorer surface with right-click context menus and filesystem-like operations.

Later, user clarified that the current file explorer also needs file metadata display, less-sensitive double-click activation, batch selection, and independent pop-out windows for File Explorer, file-view tabs, and terminal.

## Scope

### IN

- Right-click context menu on file-tree rows and current-folder/background surfaces.
- CRUD-style file operations: create file/folder, rename, move, copy, cut, paste, recoverable delete, and restore.
- Upload files into the current File tab / file-tree folder.
- Download files from the active project boundary.
- Reject same-name overwrites by default.
- Enforce explicit filesystem safety server-side for every operation; active project remains default, user-writable external paste requires explicit destination and permission probing.
- Refresh affected file tree folders after successful mutations.
- Display file size and modified date in the file list.
- Use double-click to open files/folders while keeping expand controls single-click.
- Support batch selection for multi-file copy, cut, paste, and delete.
- Support independent pop-out windows for File Explorer and file-view tabs.
- Terminal pop-out should reclaim the original terminal tab/pane footprint and render without duplicate sidebar/header chrome.

### OUT

- Silent overwrite, auto-rename fallback, silent global filesystem operations, cloud storage, upload history, automatic git staging/commit.
- Directory download via implicit archive generation unless explicitly approved later.
- Hidden cross-project clipboard behavior.
- Mobile/touch File tab gestures and touch context-menu UX; desktop WebApp only for this plan.

## Decisions

- MVP target: current folder from the File tab.
- Collision behavior: reject same-name file, no silent overwrite.
- Revised scope: File Explorer operations upgrade rather than upload-only feature.
- Clipboard model: in-app pending copy/cut state, not OS clipboard side effects.
- Delete moves items into repo-local `recyclebin/` with restore metadata rather than immediately unlinking.
- Paste to user-writable external destinations is desired, but must expose resolved destination and permission result before writing.
- Desktop-only decision: implement against existing desktop FileTree/sidebar path first; mobile/touch UX is deferred.
- Backend contract decision: new mutation routes should follow the existing Hono + `hono-openapi` pattern with stable `file.*` operation IDs for SDK generation.
- Backend contract decision: mutation endpoints return normalized operation results with affected directories instead of requiring the frontend to infer refresh scope.
- Backend contract decision: external writable paste requires preflight before execution; no silent escape from active project mutation endpoints.
- Interaction decision: row body single-click selects/focuses; row body double-click opens files/folders; explicit expand controls remain single-click.
- Interaction decision: File Explorer uses dense table/list presentation with name, size, and modified date columns.
- Interaction decision: batch selection uses an always-visible checkbox column plus Shift-click range selection and Ctrl-click row toggling.
- Layout decision: terminal pop-out is a minimal terminal window, not a full duplicated app shell.
- Layout decision: after successful file-view or terminal pop-out, the source tab/pane is removed or collapsed with no placeholder left in the main layout.
- Plan root: `plans/20260509_web-file-upload/`.
- XDG whitelist backup: `/home/pkcs12/.config/opencode.bak-20260509-1457-web-file-upload/`.

## Evidence

- `specs/architecture.md` identifies file tabs as the authority for file/rich content surfaces.
- `packages/opencode/src/server/routes/file.ts` currently has list/create-directory/stat/read/status but no upload/write endpoint.
- `packages/opencode/src/file/index.ts` has project-boundary checks that should inform upload path validation.
- `packages/ui/src/components/context-menu.tsx` provides existing Kobalte ContextMenu infrastructure.
- `packages/app/src/pages/session.tsx` separates desktop FileTree/sidebar behavior from mobile file-pane behavior via `isDesktop()`.
- `packages/app/src/pages/session/session-side-panel.tsx` has active-tab Blob download behavior that can inform row-scoped download design.
- `packages/opencode/src/server/routes/file.ts` uses `describeRoute`, `validator`, `resolver`, and operation IDs such as `file.list`, `file.createDirectory`, `file.stat`, `file.read`, and `file.status`.
- `packages/opencode/src/file/index.ts` keeps file behavior in the `File` namespace and has reusable project-root realpath checks that mutation APIs should build on.

## Feasibility Assessment

- Feasible for desktop WebApp, but not a small patch.
- Existing stable foundations: FileTree row rendering, tree refresh store, file tab loading, context-menu component wrappers, active-file download code.
- Main gaps: missing backend mutation APIs, missing FileTree action/clipboard state, tab/cache reconciliation after mutations, recoverable recyclebin design, and explicit writable-location paste safety model.

## Tasks

- See `plans/20260509_web-file-upload/tasks.md`.

## Backend Contract Checkpoint

- Completed task 1.1 by inspecting existing Hono OpenAPI File route style and SDK-facing operation IDs.
- Drafted task 1.2 API contract in `plans/20260509_web-file-upload/design.md` covering create, rename, move, copy, recoverable delete, restore, upload, download, and destination preflight.
- Added error codes for external preflight and file-only download target validation.

## Frontend Interaction Revision Checkpoint

- Revised plan scope to include metadata columns, double-click activation, batch selection, File Explorer pop-out, file-view tab pop-out, and terminal minimal pop-out layout.
- Reordered `tasks.md` so desktop File Explorer interaction model precedes backend/API implementation details.
- Deferred resuming backend guard design until the updated frontend operating model is reconciled with FileTree and layout evidence.

## Frontend Design Checkpoint

- User confirmed frontend operation requirements are complete and asked to proceed with design.
- User selected dense table/list as the primary File Explorer layout.
- User selected always-visible checkbox column with Shift/Ctrl multi-select for batch selection.
- User selected source tab/pane removal after pop-out, with no placeholder retained in the main app.
- Wrote durable design package to `plans/20260509_web-file-upload/frontend-design.md`.

## Implementation Checkpoint: 1.8 FileTree Activation Recon

- Promoted plan state from `planned` to `implementing` after planned-state validation passed.
- Completed task 1.8 by inspecting current FileTree activation and expand behavior before coding.
- Evidence: `packages/app/src/components/file-tree.tsx` directory rows are wrapped by `Collapsible.Trigger`, so the entire directory row currently toggles expand/collapse on click.
- Evidence: `packages/app/src/components/file-tree.tsx` file rows render as `button` and call `props.onFileClick?.(node)` on single click.
- Evidence: `packages/app/src/pages/session/session-side-panel.tsx` maps `onFileClick` to `props.openTab(props.file.tab(node.path))`.
- Evidence: `packages/app/src/pages/session/tool-page.tsx` maps `onFileClick` to `openFileViewer(node.path)`, which loads the file and writes the selected file to URL search params.
- Implementation implication: double-click activation cannot be a local file-row-only change; directory trigger scope and both FileTree call sites need compatible selection/focus behavior.

## Implementation Checkpoint: 2.3 Backend File Operation Guards

- Completed server-side mutation guard slice for create, rename, move, copy, recoverable delete, restore, destination preflight, upload, and download route contracts.
- Security review found and fixed three blockers before marking 2.3 complete:
  - Mutation path checks now use strict active-project boundaries and do not expand writes when `OPENCODE_ALLOW_GLOBAL_FS_BROWSE` is enabled.
  - Active-project destination preflight now uses strict project-boundary checks so relative traversal is reported as `FILE_OP_PATH_ESCAPE` instead of writable.
  - Rename/move/delete/restore no longer rely on POSIX `rename()` overwrite semantics; they use no-clobber copy/remove flow and write recycle metadata before moving content into the recyclebin.
- Validation: `bun x eslint packages/opencode/src/file/index.ts packages/opencode/src/server/routes/file.ts` passed.
- Validation: `bun run typecheck` still fails in existing unrelated `@opencode-ai/console-function` errors: missing `sst` module and unused `@ts-expect-error` in `packages/console/resource/resource.node.ts`.
- Sync: `bun run templates/skills/plan-builder/scripts/plan-sync.ts plans/20260509_web-file-upload` returned clean after checking 2.3.

## Implementation Checkpoint: 2.4 Backend File Operation Tests

- Added `packages/opencode/test/file/operations.test.ts` covering file create success, duplicate rejection, mutation path traversal rejection, strict active-project destination preflight under global browse, recyclebin metadata creation/restore, and restore conflict rejection.
- Validation: `bun test packages/opencode/test/file/operations.test.ts --timeout 30000` passed: 5 tests, 14 assertions.
- Validation: `bun x eslint packages/opencode/src/file/index.ts packages/opencode/src/server/routes/file.ts packages/opencode/test/file/operations.test.ts` passed.
- Validation: `bun run typecheck` and package-local `bun run typecheck` remain blocked by existing unrelated TypeScript errors outside the file operation slice.
- Sync: `bun run templates/skills/plan-builder/scripts/plan-sync.ts plans/20260509_web-file-upload` returned clean after checking 2.4.

## Phase Summary: 2 — Backend file-operation contract

- Done: 2.1, 2.2, 2.3, 2.4.
- Key decisions: strict active-project mutation boundary; no silent global write expansion; no silent overwrite or auto-rename fallback; recoverable delete uses repo-local recyclebin metadata.
- Validation: route pattern inspection, focused security review, eslint, single-file backend operation tests, plan-sync clean.
- Drift: none reported by plan-sync.
- Remaining: Phase 3 File explorer action shell, then clipboard operations, pop-out surfaces, validation/docs sync.

## Implementation Checkpoint: 3.1 FileTree Context Menu Targets

- Delegated implementation to coding subagent `ses_1f417b094ffec6F73MQdISwcn9` for context-menu target plumbing only.
- Added typed `FileTreeContextMenuTarget` surface for row targets and folder/background targets in `packages/app/src/components/file-tree.tsx`.
- Added root/background ContextMenu wrapper with disabled placeholder content; no mutation actions were wired in this slice.
- Validation: `bun test packages/app/src/components/file-tree.test.ts` passed: 5 tests, 16 assertions.
- Validation: `bun --bun eslint packages/app/src/components/file-tree.tsx packages/app/src/components/file-tree.test.ts` passed.
- Sync: `bun run templates/skills/plan-builder/scripts/plan-sync.ts plans/20260509_web-file-upload` returned clean after checking 3.1.

## Implementation Checkpoint: 3.2 FileTree Context Menu Action Rules

- Added typed context-menu action group model in `packages/app/src/components/file-tree.tsx` for Open, New, Clipboard, Organize, and Transfer groups.
- Added pure enabled/disabled rules for row targets, folder/background targets, selected-set actions, pending clipboard state, recyclebin restore candidates, and unsupported directory downloads.
- Kept this as a non-mutating UI rule layer; create/rename/delete/upload/download execution remains gated behind 3.3.
- Validation: `bun test packages/app/src/components/file-tree.test.ts` passed: 8 tests, 28 assertions.
- Validation: `bun --bun eslint packages/app/src/components/file-tree.tsx packages/app/src/components/file-tree.test.ts` passed.
- Sync: `bun run templates/skills/plan-builder/scripts/plan-sync.ts plans/20260509_web-file-upload` returned clean after checking 3.2.

## Validation

- Plan artifact normalization completed after `plan-validate` reported planned-state blockers.
- Normalized required headings in `proposal.md`, `spec.md`, `design.md`, `handoff.md`, `errors.md`, and `observability.md`.
- Replaced upload-MVP-only `idef0.json` / `grafcet.json` with File Explorer operations models.
- Added planned-state structural artifacts: `c4.json` and `sequence.json`.
- Converted `test-vectors.json` to the validator-required non-empty array shape.
- Command: `bun run templates/skills/plan-builder/scripts/plan-validate.ts plans/20260509_web-file-upload`
- Result: `PASS — all 13 artifact(s) required for state=planned are valid.`
- Architecture Sync: No code implementation yet; long-term `specs/architecture.md` update deferred until concrete API/layout boundaries are implemented.
