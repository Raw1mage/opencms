# Event: TUI startup black-screen from terminal protocol negotiation

- **Date**: 2026-02-10
- **Severity**: High

## Symptom

- `bun run dev` opens black screen and terminal appears stuck/unresponsive.
- Terminal state may remain abnormal after force-kill.

## Root Cause

- TUI renderer enabled Kitty keyboard protocol negotiation by default (`useKittyKeyboard: {}`).
- Some terminal environments do not fully support/relay negotiation sequences correctly.
- This can leave input/rendering in a bad state at startup.

## Fix

- Disable Kitty keyboard protocol negotiation in TUI renderer config:
  - `useKittyKeyboard: null`

## Verification

- Workspace typecheck passed after change.
- Startup path now avoids Kitty negotiation sequences in unsupported terminals.
