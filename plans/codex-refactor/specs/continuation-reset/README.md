# Codex Continuation Reset

Defines the trigger-driven remote-ref flush policy for Codex/Responses API continuation state.

## Status

IMPLEMENTED — all tasks completed 2026-04-02.

## Key Decisions

- Flush is A-trigger-only (no separate keep-conditions).
- Triggers: identity change, provider invalidation, restart mismatch, checkpoint rebuild untrusted, explicit reset.
- Replay = checkpoint prefix + raw tail steps.
- Flush clears remote refs only; local checkpoint/tail assets are preserved.
- Provider-specific cleanup is adapter-owned; runtime does not assume `msg_*` is universal.

## Files

- [spec.md](spec.md) — requirements and acceptance checks
- [design.md](design.md) — A-trigger matrix and implementation design
