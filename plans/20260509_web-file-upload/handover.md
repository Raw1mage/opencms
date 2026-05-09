# Handover — Web File Explorer Operations

## Status

- Plan path: `plans/20260509_web-file-upload/`
- Event log: `docs/events/event_20260509_web-file-upload.md`
- Current branch/worktree at time of original handover: `main` in `/home/pkcs12/projects/opencode`
- Critical process issue: implementation was incorrectly performed in the authoritative `main` worktree instead of an admitted beta worktree. Treat all implementation changes as contaminated until reviewed or extracted.

## 2026-05-09 audit + extraction (post-handover)

- Feature code lifted from `main` working tree into a fresh beta worktree at `/home/pkcs12/projects/opencode-worktrees/web-file-upload` on branch `beta/web-file-upload`, commit `539c2ac820a18b6c29b4d75432b2535a2d3d220f`. Main reverted of the seven feature files; docs (`plans/20260509_web-file-upload/`, `docs/events/event_20260509_web-file-upload.md`) intentionally stay on main.
- Plan was re-reviewed against the actual code on `beta/web-file-upload`. Findings were applied as doc edits in this directory; no code was changed during the audit. Summary of reset:
  - **Phase 1 (UI interaction model) reset to pending for 1.4 / 1.5 / 1.6.** Prior boxes were checked but no `onDblClick`, `size`/`modifiedAt` columns, or checkbox/Shift/Ctrl selection actually shipped. Only the design and reconnaissance sub-tasks (1.1–1.3, 1.7, 1.8) genuinely closed.
  - **Phase 2 split.** 2.2 was reframed: 2.2a (create/rename/move/copy/delete-to-recyclebin/restore/preflight) shipped; 2.2b (upload + download routes, `OperationResult.operation = "upload"`, `FILE_UPLOAD_TOO_LARGE` enum entry) is now an explicit pending task. 2.4 expanded to include rename/move/copy duplicates, basename rejection, symlink-escape, recyclebin uniqueness, preflight external happy path, and upload/download cases. 2.6 added for Bus event wiring.
  - **Phase 3 gained 3.0** as the frontend integration glue gate before 3.3: consume `OperationResult.affectedDirectories` in `context/file.tsx` and reconcile open tabs in `pages/session/file-tabs.tsx`.
  - **Phase 5 reconnaissance added 5.1.** Terminal pop-out is already implemented in `terminal-panel.tsx` + `app.tsx`; 5.4 was rewritten as a delta on the existing implementation (vacate source pane, minimal chrome) rather than greenfield.
  - **`spec.md` gained explicit requirements** for symlink escape, upload size limit (default 64 MiB, tunable via `tweaks.cfg`), and recyclebin visibility/git-ignore behavior. A new "Out of Scope (V1)" section explicitly excludes drag-and-drop within the tree, OS-to-tree drop upload, permanent unlink, archive directory download, cross-project clipboard, and mobile/touch.
  - **`errors.md` flagged drift.** `FILE_UPLOAD_TOO_LARGE` is marked **pending** (catalogued but not yet in `File.OperationCode`); `FILE_CLIPBOARD_INVALID_STATE` is marked UI-only. Sync rule: catalogue additions here must land with the enum entry in the same change.
  - **`data-schema.json` and `test-vectors.json` rewritten** against the implemented zod validators. Prior versions used invented field names (`targetDirectory`/`destinationDirectory`/`filename`/`confirmDestructive`/`createFile`) that never matched any route; downstream consumers should rerun against the new shapes.
  - **`implementation-spec.md` replaced.** Prior version described an obsolete "minimal upload feature"; new version is a pointer-only document plus six cross-phase invariants.
- 3.3 remains approval-gated. Pre-conditions before opening 3.3: 1.6 (selection state), 2.2b (upload/download routes), 3.0 (frontend reconcile glue). See `tasks.md` Dependency notes.

## User concern / reason for handover

The user identified that beta-workflow was not followed. This is correct. No mission authority fields were restated or verified before implementation, and no beta admission gate was completed. The outgoing agent is removed from execution responsibility.

## Scope captured in plan

The original request was file upload through the WebApp File tab. It was expanded into a desktop WebApp File Explorer operations upgrade:

- right-click context menus on rows and folder/background surfaces
- create file/folder, rename, move, copy, cut, paste, recoverable delete, restore
- upload into current folder and download active-project files
- reject same-name overwrites by default
- server-side project-boundary and no silent global-write fallback
- file size / modified date display
- row body single-click select/focus, double-click open
- batch selection for multi-file operations
- File Explorer, file-view tab, and terminal pop-out surfaces
- mobile/touch explicitly out of scope

## Artifacts created/updated

- `plans/20260509_web-file-upload/`
  - `proposal.md`
  - `spec.md`
  - `design.md`
  - `frontend-design.md`
  - `tasks.md`
  - `handoff.md`
  - `implementation-spec.md`
  - `idef0.json`
  - `grafcet.json`
  - `c4.json`
  - `sequence.json`
  - `data-schema.json`
  - `test-vectors.json`
  - `errors.md`
  - `observability.md`
- `docs/events/event_20260509_web-file-upload.md`
- XDG whitelist backup made before implementation: `/home/pkcs12/.config/opencode.bak-20260509-1457-web-file-upload/`

## Plan/task progress recorded

`tasks.md` currently records:

- Phase 1: completed through `1.8`
- Phase 2: completed through `2.4`
- Phase 3: completed `3.1` and `3.2`; `3.3` not started
- Phases 4, 5, 6: not started

Important caveat: because implementation was done in `main`, these task checkboxes should be reviewed by the next owner before trusting them as valid workflow progress.

## Code changes made in main that appear related to this feature

Likely related files changed by this work:

- `packages/opencode/src/file/index.ts`
  - Added File namespace operations for create, rename, move, copy, recoverable delete, restore, destination preflight, upload/download support.
  - Added strict active-project mutation boundary helpers.
  - Added no-clobber copy/remove flow to avoid POSIX rename overwrite semantics.
- `packages/opencode/src/server/routes/file.ts`
  - Added Hono/OpenAPI route contract for file operations.
- `packages/sdk/js/openapi.json`
- `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts`
  - SDK/OpenAPI generated changes from new routes.
- `packages/opencode/test/file/operations.test.ts`
  - Added backend operation guard tests.
- `packages/app/src/components/file-tree.tsx`
  - Added `FileTreeContextMenuTarget` target model.
  - Added ContextMenu wrapper and folder/background target handling.
  - Added non-mutating action group/enabled-rule model for Open/New/Clipboard/Organize/Transfer.
- `packages/app/src/components/file-tree.test.ts`
  - Added tests for context menu targets and action rules.

Do not assume this list is complete; use `git diff` for the source of truth.

## Unrelated or pre-existing changes visible in working tree

At handover time, `git status --short --branch` showed additional modified/deleted/untracked paths that may not belong to this feature:

- `packages/app/src/components/session/session-context-metrics.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/ui/src/components/session-turn.tsx`
- `specs/attachments/grafcet.step4.svg` deleted
- `specs/compaction/README.md`
- `.miatrag/`
- other untracked specs may have appeared in earlier status snapshots

Next owner must separate feature changes from unrelated local work before committing, moving, or cleaning anything.

## Validation run and results

Passed focused checks:

- `bun x eslint packages/opencode/src/file/index.ts packages/opencode/src/server/routes/file.ts`
- `bun test packages/opencode/test/file/operations.test.ts --timeout 30000`
  - 5 tests passed, 14 assertions
- `bun x eslint packages/opencode/src/file/index.ts packages/opencode/src/server/routes/file.ts packages/opencode/test/file/operations.test.ts`
- `bun test packages/app/src/components/file-tree.test.ts`
  - first after 3.1: 5 tests passed, 16 assertions
  - after 3.2: 8 tests passed, 28 assertions
- `bun --bun eslint packages/app/src/components/file-tree.tsx packages/app/src/components/file-tree.test.ts`
- `bun run templates/skills/plan-builder/scripts/plan-sync.ts plans/20260509_web-file-upload`
  - clean after 2.3, 2.4, 3.1, 3.2

Known validation blockers:

- Repository `bun run typecheck` failed in existing unrelated `@opencode-ai/console-function` errors around missing `sst` and unused `@ts-expect-error`.
- Package-local `packages/opencode` typecheck also failed on many existing unrelated TypeScript errors outside the file operation slice.

## Security and behavioral decisions already encoded

- Mutation endpoints must remain strict active-project only.
- `OPENCODE_ALLOW_GLOBAL_FS_BROWSE` must not expand write/mutation authority.
- No silent overwrite.
- No auto-rename fallback.
- Recoverable delete uses repo-local `recyclebin/` plus `.opencode-recycle.json` metadata.
- Directory download via implicit archive generation is out of scope unless explicitly approved later.
- External writable paste must show canonical destination and permission result before writing.

## Immediate recommended next steps for replacement owner

1. Stop all implementation on `main`.
2. Establish beta-workflow mission metadata before any further coding:
   - `mainRepo`
   - `mainWorktree`
   - `baseBranch`
   - `implementationRepo`
   - `implementationWorktree`
   - `implementationBranch`
   - `docsWriteRepo`
3. Decide how to handle contaminated `main` changes:
   - extract a patch for only feature-related files, or
   - preserve current dirty main as-is for manual review, or
   - have a human split/revert unrelated changes.
4. If continuing implementation, recreate or apply reviewed feature patch into the admitted beta worktree only.
5. Before continuing from `3.3`, obtain explicit user approval because `3.3` wires actual create/rename/delete/upload/download UI actions, including destructive delete-to-recyclebin flow.

## Do not do without user approval

- Do not commit.
- Do not reset, checkout, clean, or delete working tree changes.
- Do not create or switch branches as a silent repair.
- Do not move current `main` changes into beta automatically.
- Do not proceed with `3.3` without explicit approval and beta admission.

## Last known stop point

Stopped after task `3.2` was recorded complete. Task `3.3` is pending and approval-gated.
