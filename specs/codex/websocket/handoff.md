# Handoff

## Status

- Source plan: `plans/codex-websocket/`
- Promotion status: user confirmed this plan is completed and it has been promoted into `specs/codex/websocket/`.
- This package is a completed formal spec / handoff surface, not an active unfinished plan.

## Read Order For Future Maintenance

1. `specs/codex/provider_runtime/design.md`
2. `specs/codex/provider_runtime/spec.md`
3. `specs/codex/websocket/implementation-spec.md`
4. `specs/codex/websocket/design.md`
5. `specs/codex/websocket/spec.md`
6. `specs/codex/protocol/whitepaper.md`

## What This Package Preserves

- Codex WebSocket transport adapter scope under the AI SDK contract
- WebSocket-specific protocol behavior and fallback rules
- Runtime hardening and incremental-delta design intent
- Validation focus and shelved prewarm boundary

## Maintenance Rules

- Treat this package as a completed codex sub-spec under `specs/codex/`.
- Keep WebSocket work subordinate to `specs/codex/provider_runtime/`; do not fork a parallel orchestration/runtime path.
- Preserve explicit fallback/error semantics and session-scoped state isolation.
- Keep Phase 4 prewarm as explicitly shelved work unless a later user request reopens it.

## Historical Note

- The original plan root under `/plans/` was removed after promotion because the user confirmed the work is complete.
- `tasks.md` is preserved here as a completion ledger rather than an execution seed.
