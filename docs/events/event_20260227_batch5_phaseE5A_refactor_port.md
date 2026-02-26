# Event: Batch-5 Phase E5-A rewrite-port (app/ui behavior follow-up)

Date: 2026-02-27
Status: Done

## Scope

- `e27d3d5d4` fix(app): remove filetree tooltips
- `c6d8e7624` fix(app): on cancel comment unhighlight lines
- `cc02476ea` (+ `0d0d0578e`) refactor app error handling with shared formatter
- `b8337cddc` fix(app): permissions/questions from child sessions
- `286992269` fix(app): correct Copilot provider description in i18n
- `05ac0a73e` fix(app): simplify review layout
- `7afa48b4e` tweak(ui): keep reasoning inline code subdued in dark mode

## Decision summary

- Ported:
  - `e27d3d5d4`
  - `c6d8e7624`
  - `cc02476ea`
  - `b8337cddc` (cms-adapted, session tree request lookup)
  - `286992269`
  - `05ac0a73e`
  - `7afa48b4e`
- Integrated/no-op:
  - `0d0d0578e` (format-only generated follow-up)

## Changes

- `packages/app/src/components/file-tree.tsx`
  - removed file-tree tooltip wrapper behavior and tooltip props plumbing.
- `packages/app/src/pages/session/file-tabs.tsx`
  - introduced `cancelCommenting()` to clear selected lines and close editor consistently on cancel/focus-out.
- `packages/app/src/utils/server-errors.ts` (new)
  - centralized server error formatting (`formatServerError`, config-invalid formatting).
- `packages/app/src/utils/server-errors.test.ts` (new)
  - coverage for config-invalid formatting and fallback behavior.
- `packages/app/src/context/global-sync.tsx`
  - switched session-load error toast details to `formatServerError`, added error variant.
- `packages/app/src/context/global-sync/bootstrap.ts`
  - switched bootstrap error toast details to `formatServerError`, added error variant.
- `packages/app/src/pages/session/session-request-tree.ts` (new)
  - traverses session tree to resolve first pending permission/question among parent+children.
- `packages/app/src/pages/session.tsx`
  - permission/question prompt lookup now uses session-tree request helpers.
  - review tab behavior simplified to desktop-always review tab mode.
  - removed file-tree open/close tab-force effects aligned with simplified review layout.
- `packages/app/src/pages/session/session-side-panel.tsx`
  - simplified review panel layout flow by removing conditional fallback branch tied to file-tree changes tab.
- i18n updates (`bs/da/en/es/no/pl/ru/th`)
  - Copilot note corrected from Claude-specific wording to GitHub Copilot AI wording.
- `packages/ui/src/components/message-part.css`
  - dark-mode inline-code in reasoning sections is now subdued (`opacity: 0.6`).

## Validation

- `bun test packages/app/src/utils/server-errors.test.ts` ✅
- `bun turbo typecheck --filter=@opencode-ai/app --filter=@opencode-ai/ui` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
