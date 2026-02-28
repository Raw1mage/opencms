# Event: restore inline terminal when popout window closes

Date: 2026-02-28
Status: Completed

## Problem

- Closing terminal popout window could leave main page in a stale "popped out" state,
  making bottom terminal panel appear missing.

## Fix

- Added robust popout lifecycle watcher in `terminal-panel.tsx`:
  - `beforeunload` listener on popout window
  - interval-based closed-window polling fallback
- On close detection:
  - clear `popoutWindow` signal
  - focus opener window
  - scroll terminal panel into view at page bottom

## File

- `packages/app/src/pages/session/terminal-panel.tsx`
