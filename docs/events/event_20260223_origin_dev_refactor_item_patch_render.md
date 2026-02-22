# Event: origin/dev refactor item - apply_patch render alignment

Date: 2026-02-23
Status: Done

## Source

- `9c5bbba6e` fix(app): patch tool renders like edit tool

## Refactor

- Updated `packages/ui/src/components/message-part.tsx` apply_patch tool renderer:
  - keep existing multi-file fallback UI
  - add single-file fast path that reuses edit-style trigger and diff presentation
  - show filename + directory path + diff counters in message-part header style

## Validation

- `bun run --cwd /home/pkcs12/projects/opencode/packages/ui typecheck` ✅
