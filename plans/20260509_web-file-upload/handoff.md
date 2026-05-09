# Handoff

## Execution Contract

- Start with backend API contract before UI wiring.
- Treat this as a File Explorer operations upgrade, not an upload-only feature.
- Do not implement overwrite, auto-rename, cross-project paste, archive-folder download, or fallback destinations unless the user explicitly changes scope.
- Destructive operations require explicit confirmation UX and server-side confirmation evidence.
- Implement desktop WebApp first; do not attempt mobile/touch gestures or mobile file-pane context-menu behavior in this plan.
- Keep exactly one current phase in TodoWrite during implementation.

## Required Reads

- `specs/architecture.md`
- `packages/opencode/src/server/routes/file.ts`
- `packages/opencode/src/file/index.ts`
- `packages/app/src/context/file.tsx`
- `packages/app/src/components/file-tree.tsx`
- `packages/app/src/pages/session/file-tabs.tsx`

## Stop Gates In Force

- Stop if SDK generation requires a non-obvious build step not documented in repo scripts.
- Stop if existing File module project-boundary helper is private and reuse would require broad refactor.
- Stop before enabling overwrite behavior.
- Stop before allowing directory download via implicit zip/archive generation.
- Stop if copy/cut/paste semantics would require OS clipboard integration rather than in-app operation state.
- Stop if desktop implementation starts requiring mobile/touch interaction decisions.
- Stop if external writable-location paste cannot show canonical destination and permission result before writing.

## Validation Plan

- Focused unit tests for backend file-operation safety.
- Typecheck or package-level test for WebApp compile validity.
- Browser verification of context menu visibility, create/rename/delete/upload/download, copy/cut/paste, refreshed folder listings, duplicate rejection, and project-boundary rejection.

## Execution-Ready Checklist

- [ ] Read all required files before editing implementation code.
- [ ] Keep current phase reflected in TodoWrite and update `tasks.md` immediately after each completed slice.
- [ ] Reuse existing FileTree, file context, ContextMenu, Hono route, and File namespace patterns where compatible.
- [ ] Add stable API error codes before wiring UI error handling.
- [ ] Run focused validation after each backend/frontend slice.
- [ ] Update event log and architecture sync notes before declaring completion.
