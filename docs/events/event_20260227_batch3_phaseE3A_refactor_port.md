# Event: Batch-3 Phase E3-A rewrite-port (app/ui behavior fixes)

Date: 2026-02-27
Status: Done

## Scope

- `68cf011fd` fix(app): ignore stale part deltas
- `45191ad14` fix(app): keyboard navigation previous/next message
- `aae75b3cf` fix(app): middle-click tab close in scrollable tab bar
- `082f0cc12` fix(app): preserve native path separators in file path helpers

## Changes

- `packages/app/src/context/global-sdk.tsx`
  - track stale part-delta keys when coalescing `message.part.updated`.
  - skip stale `message.part.delta` events for already-updated parts during flush.
- `packages/app/src/pages/session.tsx`
  - adjust previous/next message navigation index math to allow resuming scroll at boundary.
- `packages/app/src/pages/session/message-timeline.tsx`
  - add `data-session-title` marker on sticky header for hash-scroll inset calculations.
- `packages/app/src/pages/session/use-session-hash-scroll.ts`
  - subtract sticky header inset while scrolling to hashed message anchors.
- `packages/ui/src/components/tabs.tsx`
  - handle middle-button `onMouseDown` preventDefault to make middle-click close reliable in scrollable tab bar.
- `packages/app/src/context/file/path.ts`
  - make root-prefix stripping separator-agnostic and case-insensitive on Windows.
  - preserve native separators where applicable.
- `packages/app/src/context/file/path.test.ts`
  - add Windows mixed-separator normalization regression coverage.

## Validation

- `bun test packages/app/src/context/file/path.test.ts` ✅
- `bun turbo typecheck --filter=@opencode-ai/app --filter=@opencode-ai/ui` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
