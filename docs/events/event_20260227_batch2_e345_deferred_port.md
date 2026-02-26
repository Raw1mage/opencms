# Event: Batch-2 deferred port `e345b89ce` (tool-call batching UI)

Date: 2026-02-27
Status: Done

## Scope

- Upstream: `e345b89ce` — fix(app): better tool call batching
- Target files:
  - `packages/ui/src/components/message-part.tsx`
  - `packages/ui/src/components/session-turn.tsx`

## Rewrite-port decisions

- Ported core batching behavior by introducing `AssistantParts` (flattened assistant part rendering across multiple assistant messages in one turn).
- Preserved cms-specific turn behaviors (response hiding, reasoning visibility rules, hidden permission/question tool calls) via `AssistantParts` options instead of direct upstream copy.
- Kept i18n surface unchanged for this round (no `gatheredContext` key migration) to avoid broad locale churn.

## Changes

- `message-part.tsx`
  - added part renderability filter for hidden todo tools and pending/running `question` tool states.
  - added `AssistantParts` component for unified assistant part rendering with filtering options.
- `session-turn.tsx`
  - switched expanded assistant rendering path from per-message item wrapper to `AssistantParts`.

## Validation

- `bun turbo typecheck --filter=@opencode-ai/ui --filter=@opencode-ai/app` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
