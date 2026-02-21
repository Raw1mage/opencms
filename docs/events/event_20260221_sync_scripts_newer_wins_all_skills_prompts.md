# Event: Update sync scripts to newer-wins for all skills/prompts

Date: 2026-02-21
Status: Done

## Decision

Align dev sync behavior with strategy:

- Runtime config path (`$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`) is active runtime source.
- Runtime and `templates/` are synchronized by **newer-wins** rule.
- Apply to **system prompts** and **all skills**, not only core skills.

## Changes

Updated scripts:

1. `script/sync-config-back.sh`
   - Sync runtime -> templates
   - Added prompts directory sync (`prompts/`)
   - Expanded skills sync from core-only to all skills
   - Removed `--delete` to avoid accidental data loss and preserve union

2. `script/dev-sync-config.sh`
   - Sync templates -> runtime
   - Added prompts directory sync (`prompts/`)
   - Expanded skills sync from core-only to all skills
   - Removed `--delete` to preserve runtime-only additions for reverse sync

## Expected Behavior in `bun run dev`

Given execution order:

1. `sync:back` (runtime -> templates, newer wins)
2. `dev-sync-config.sh` (templates -> runtime, newer wins)

Result: runtime/templates converge to newest file versions across both sides.
