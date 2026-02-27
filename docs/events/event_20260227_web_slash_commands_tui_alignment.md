# Event: Align web slash commands with TUI expectations

Date: 2026-02-27
Status: Done

## Context

- User reported web slash command behavior diverged from TUI.
- Requested alignment direction:
  - add `/session`
  - remove `/update_model` (and `/update_models`) from slash dropdown
  - keep custom commands visible in slash dropdown

## Changes

### 1) Added `/session` slash in web session commands

- File: `packages/app/src/pages/session/use-session-commands.tsx`
- Added command:
  - id: `session.switch`
  - slash: `session`
  - action: opens `DialogSelectFile` (same picker used by file/session navigation)

### 2) Adjusted slash dropdown source/merge rules

- File: `packages/app/src/components/prompt-input.tsx`
- Kept built-in + custom slash commands visible.
- Explicitly excluded custom slash triggers:
  - `update_model`
  - `update_models`
- Added dedupe by trigger, preferring built-in commands over custom when names collide.

## Validation

- `bun x tsc --noEmit --project packages/app/tsconfig.json` ✅
- `./webctl.sh build-frontend && ./webctl.sh restart && ./webctl.sh status` ✅ (`healthy: true`)

## Handoff Notes

- Slash dropdown behavior is currently defined in `prompt-input.tsx` (`slashCommands` memo).
- If later requiring strict TUI one-to-one parity, migrate slash derivation to a shared command metadata adapter used by both UIs.
