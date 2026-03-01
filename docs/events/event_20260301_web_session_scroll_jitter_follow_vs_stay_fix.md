# Event: web session scroll jitter fix (follow vs stay contention)

Date: 2026-03-01
Status: Done

## Symptom

- During streaming responses in Web session view, scrolling could feel jittery.
- Behavior looked like a contention between:
  1. staying at current user position, and
  2. auto-following latest content.

## Root Cause

- `MessageTimeline` only forwarded scroll handling to auto-scroll logic while a short-lived
  `scrollGesture` window was active.
- Once gesture window expired, scroll updates at non-bottom positions could stop informing
  auto-scroll state, leading to unstable follow/stay behavior.

## Change

- File: `packages/app/src/pages/session/message-timeline.tsx`
- Updated `onScroll` logic:
  - Keep scheduling scroll-state as before.
  - Continue feeding auto-scroll handler when either:
    - gesture is active, **or**
    - view is already not at bottom.
  - Keep gesture-gated paths for explicit gesture handling and desktop scroll-spy behavior.

## Expected UX

- User can scroll up and remain stable at current position while streaming continues.
- Existing floating "jump to latest" control remains the explicit path to return to bottom follow mode.
