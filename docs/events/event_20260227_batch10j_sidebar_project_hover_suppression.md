# Batch10J Sidebar project hover suppression refactor (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`5745ee87b`)
Target: `cms`

## Scope

- Port low-risk desktop/sidebar interaction refinement for project tiles.

## Changes

1. `packages/app/src/pages/layout/sidebar-project.tsx`
   - Added per-tile `suppressHover` state in `SortableProject` store.
   - Prevent hover/focus preview activation when suppression flag is set.
   - Clicking an already-selected project now toggles sidebar (instead of navigating) and suppresses immediate hover reopen.
   - `HoverCard` open conditions updated to respect suppression state.
   - Migrated local open/menu state from separate signals to `createStore` for cohesive tile interaction state.

## Validation

- `bun run typecheck` in `packages/app` ✅

## Safety

- Change scoped to sidebar project tile UX behavior.
- No impact to provider split, rotation3d, account management, or admin routes.
