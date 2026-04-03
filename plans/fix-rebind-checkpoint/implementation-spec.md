# Implementation Spec

## Goal
- Resolve the 440-message legacy session stall by introducing defensive history truncation and forced shadow-file generation.

## Scope
### IN
- Virtual boundary logic in `message-v2.ts`.
- Synthetic context prompt assembly in `prompt.ts`.
- Forced background healing path in `compaction.ts`.

### OUT
- Altering the normal prompt cache operation for clean sessions.

## Critical Files
- packages/opencode/src/session/message-v2.ts
- packages/opencode/src/session/prompt.ts
- packages/opencode/src/session/compaction.ts

## Structured Execution Phases
- Phase 1: Defensive Truncation. Terminate infinite back-scanning at 150 msgs.
- Phase 2: Synthesis Loading. Prepend SharedContext summary to handle the gap.
- Phase 3: Physical Healing. Force-generate the missing JSON checkpoint.

## Validation
- `tail -f /tmp/opencode-loop.log` shows msg.length < 100 on legacy rebind.
- `rebind-checkpoint-{id}.json` exists in State directory after visit.

## Handoff
- Build agent must read this spec first.
- Materialize runtime todo from tasks.md.
