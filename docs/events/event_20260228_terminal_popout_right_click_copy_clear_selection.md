# Event: terminal popout right-click copy + clear selection

Date: 2026-02-28
Status: Completed

## Change

- Switched popout selection copy interaction from silent auto-copy-on-select to explicit right-click copy.
- After right-click copy, selection highlight is cleared to avoid sticky visual state.

## Rationale

- Better matches typical terminal UX expectations for explicit copy gesture.
- Avoids ambiguity where users cannot tell whether clipboard copy succeeded.

## Files

- `packages/app/src/components/terminal.tsx`
- `packages/app/src/pages/session/terminal-popout.tsx`
