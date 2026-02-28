# Event: terminal selection highlight artifact cleanup

Date: 2026-02-28
Status: Completed

## Problem

- After paste/copy operations, selection highlight could visually persist and look like inverted output text.

## Fix

- Added unified `clearAllSelection()` for terminal + browser selection layers.
- Clear selection around paste flow (before and after paste).
- For popout mode, clear selection on normal text input keys (printable/Enter/Backspace/Delete).
- Reused same clear function after right-click copy completes.

## Files

- `packages/app/src/components/terminal.tsx`
- `packages/app/src/pages/session/terminal-popout.tsx`
