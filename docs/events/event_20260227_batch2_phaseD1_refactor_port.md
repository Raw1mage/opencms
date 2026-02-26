# Event: Batch-2 Phase D1 rewrite-port (app/ui low-risk)

Date: 2026-02-27
Status: Done (4 ported, 1 deferred)

## Scope

- `0186a8506` fix(app): keep Escape handling local to prompt input on macOS desktop
- `20f43372f` fix(app): terminal disconnect and resync
- `3a505b269` fix(app): virtualizer getting wrong scroll root
- `46739ca7c` fix(app): ui flashing when switching tabs
- `e345b89ce` fix(app): better tool call batching

## Decision summary

- Ported:
  - `0186a8506`
  - `20f43372f`
  - `3a505b269`
  - `46739ca7c` (bootstrap loading-state guard part)
- Deferred (next round due high divergence):
  - `e345b89ce` (large UI rendering architecture change across `message-part.tsx` + `session-turn.tsx`)

## Changes

- `packages/app/src/components/prompt-input.tsx`
  - Esc handling now exits popover/shell/working locally and supports macOS desktop blur behavior.
- `packages/app/src/utils/terminal-writer.ts`
  - Writer now supports async write completion and flush callbacks.
- `packages/app/src/utils/terminal-writer.test.ts`
  - Updated tests for callback-based writer flow and pending flush completion.
- `packages/app/src/components/terminal.tsx`
  - Use callback write path and ensure cleanup flush completion before terminal persistence.
- `packages/ui/src/pierre/virtualizer.ts`
  - Added dynamic scroll-root detection fallback outside session-review container.
- `packages/app/src/context/global-sync/bootstrap.ts`
  - Avoid resetting status to `loading` when already `complete`.

## Validation

- `bun test packages/app/src/utils/terminal-writer.test.ts` ✅
- `bun turbo typecheck --filter=@opencode-ai/app --filter=@opencode-ai/ui` ✅

## Next

- Phase D2 then D1-deferred `e345b89ce` as a dedicated UI rendering refactor batch.
