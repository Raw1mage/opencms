# Event: terminal popout use minimal shell (browser title only)

Date: 2026-03-01
Status: Done

## Request

- Terminal popout window should not include outer app shell elements (session/project drawers).
- Popout should be a single terminal view, using browser title only (no in-content title row).

## Changes

1. `packages/app/src/pages/layout.tsx`
   - Added route check for `/session/:id?/terminal-popout`.
   - For popout route, return minimal container directly (`props.children` + toast region), bypassing full layout shell.

2. `packages/app/src/pages/session/terminal-popout.tsx`
   - Added session lookup via SDK (`session.get`).
   - Removed in-content title bar to keep window content as pure terminal.
   - Removed extra plus/new-terminal button to keep popout focused as a pure terminal window.
   - Document title updated to `${sessionTitle} · Terminal`.

## Expected UX

- Popout is visually focused on terminal only.
- No sidebar drawers from main shell.
- Session context is visible via browser window title.
