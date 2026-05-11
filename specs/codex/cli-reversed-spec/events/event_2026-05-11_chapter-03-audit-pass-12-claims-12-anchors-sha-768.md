---
date: 2026-05-11
summary: "Chapter 03 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions"
---

# Chapter 03 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **8 TYPE** (C1 struct SessionId, C2 struct ThreadId, C4 struct Session, C7 enum InitialHistory, C9 struct TurnContext, C10 struct ActiveTurn, C11 struct TurnState, C12 enum MailboxDeliveryPhase). Far exceeds ≥1 TEST/TYPE floor.
- **Open questions**: 0.

## Notes on TEST anchor

Chapter 03 is structural — types declare the contract. No behavioural TEST citation is added for Ch03 because the runtime tests (`state/session_tests.rs`, `session/tests.rs`) exercise behaviours that belong to later chapters (06 request build, 11 cache). The 8 TYPE anchors are sufficient under the audit gate (≥1 TEST-or-TYPE).

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | `protocol/src/session_id.rs:13` | struct | ✓ Uuid newtype + now_v7 constructor |
| C2 | `protocol/src/thread_id.rs:11` | struct | ✓ identical shape to C1 |
| C3 | `protocol/src/session_id.rs:55` | impl | ✓ From<ThreadId> for SessionId zero-cost |
| C4 | `core/src/session/session.rs:14` | struct | ✓ 13 fields incl conversation_id, installation_id, active_turn |
| C5 | `core/src/session/session.rs:353` | fn | ✓ 19-arg async ctor, returns Arc<Self> |
| C6 | `core/src/session/session.rs:386` | match | ✓ ThreadId::default for non-resume, preserved on resume |
| C7 | `protocol/src/protocol.rs:2371` | enum | ✓ 4 variants confirmed |
| C8 | `core/src/session/session.rs:392` | match | ✓ count Compacted items for Resumed, 0 otherwise |
| C9 | `core/src/session/turn_context.rs:55` | struct | ✓ ~50 fields confirmed |
| C10 | `core/src/state/turn.rs:29` | struct | ✓ tasks IndexMap + turn_state Arc<Mutex<TurnState>> |
| C11 | `core/src/state/turn.rs:110` | struct | ✓ Default-derived, full pending_* + tool_calls + token_usage |
| C12 | `core/src/state/turn.rs:46` | enum | ✓ 2 variants + state machine doc comment |

## Cross-diagram traceability (per miatdiagram §4.7)

Walked the cross-links:
- `protocol/src/session_id.rs::SessionId` → A3.1 → C1, C3 ✓
- `protocol/src/thread_id.rs::ThreadId` → A3.1 → C2 ✓
- `protocol/src/protocol.rs::InitialHistory` → A3.3 → C7, C8 ✓
- `core/src/session/session.rs::Session` → A3.5 → C4, C5 ✓
- `core/src/session/turn_context.rs::TurnContext` → A3.4 → C9 ✓
- `core/src/state/turn.rs::{ActiveTurn, TurnState, MailboxDeliveryPhase}` → A3.5, A3.6 → C10, C11, C12 ✓

Every Mechanism cell in idef0.03.json resolves to an architecture box. Forward references to Ch04 (build_initial_context) and Ch06 (request build) explicitly marked "deferred, not yet audited" — forward-reference discipline preserved.

## Key drift findings (recorded in delta map)

1. **Session abstraction itself is divergent** — OpenCode and codex-cli diverge at this layer. Wire-level alignment (Ch04+) remains tractable; Session-internal alignment would over-constrain OpenCode.
2. **`window_generation` not tracked by OpenCode** based on compaction count — currently passed externally to `buildHeaders`. Subagent / compaction window namespace may differ as a result. Not a cache-blocker per se (wire shape stays compatible), but worth a future ticket.
3. **No `MailboxDeliveryPhase` analogue** in OpenCode — by design; OpenCode subagent mailbox uses different primitives.

These findings strengthen the conclusion: **future cache-dimension RCAs should target wire-body content (chapters 04, 06) not Session-internal state shape**.

## Next

Chapter 04 (Context Fragment Assembly) — this is the chapter that finally describes `build_initial_context()` and produces datasheet D4-1 (the request body's `input[]` array shape). It's the **most consequential chapter for the cache-4608 question and for the deferred bundle-slow-first-refinement work**. Will be larger than ch01-03 because it touches the IDEF0 + datasheet contract for wire content directly.
