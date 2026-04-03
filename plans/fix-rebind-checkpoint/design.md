# Design

## Context
- 440-message sessions consume 850KB+ per round, hitting API limits and stalling the TUI.
- `REBIND_BUDGET` logic exists but is dormant for these legacy/dirty sessions.

## Goals / Non-Goals
**Goals:**
- Cap input payload for non-checkpoint sessions at <200KB.
- Retain only recent history for context continuity.

**Non-Goals:**
- Manually purging the database records (must keep all for TUI rendering).

## Decisions
- Decision: Use a "Virtual Anchor." Creating a fake checkpoint snapshot on-the-fly during load when the physical file is missing but needed.
- Decision: Background Healing. After the session is stabilized, proactively write the missing physical checkpoint to prevent future virtual-anchor logic.

## Risks / Trade-offs
- Risk: Loss of long-term history context for the model. -> Mitigation: SharedContext snapshot and 100 recent messages provide sufficient operational context.

## Critical Files
- packages/opencode/src/session/message-v2.ts: `filterCompacted`
- packages/opencode/src/session/prompt.ts: `runLoop` assembly
