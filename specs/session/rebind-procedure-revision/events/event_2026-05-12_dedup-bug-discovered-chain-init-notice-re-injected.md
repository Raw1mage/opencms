---
date: 2026-05-12
summary: "Dedup bug discovered: chain_init_notice re-injected every round"
---

# Dedup bug discovered: chain_init_notice re-injected every round

Live monitor `b3q25w7ls` captured chain_init_notice in `bundle_user` fragmentIds across 8 consecutive `llm.prompt.telemetry` events — same (prev=raw → next=humanresource) account pair, ~700 chars/turn wasted, "once-after-chain-break" semantic broken.

Root cause: prompt.ts:460/1208 detect chain-affecting events by comparing the latest compaction anchor against the session's pinned identity. The anchor only refreshes on compaction → the divergence is a steady-state condition between compactions, not a periodic event. Pre-Phase B/C the side effect was an idempotent `invalidateContinuationFamily` (harmless). Post-Phase B/C the side effect is a fresh `Continuation.run` writing a new PendingInjectionStore mark on every detection.

Hotfix `b8df87855` added `DispatchDedup` (session/continuation/dispatch-dedup.ts) — per-session dedup at Continuation.run entry. Key derivation from event kind + relevant transition; one-shot kinds (empty_response_recovery, compaction_*, backend_failure_forced_resend, ws_reconnect, …) bypass dedup; recurring kinds (account_switch, account_rotate, provider_switch, model_switch_*) are deduped within TTL.

Initial TTL was 5 min — on observation the dispatch leaked one re-fire every 5 min indefinitely because stale-anchor is steady-state. Follow-up hotfix `a0807416a` bumped TTL to 1 hour.

15 new tests covering dedup key derivation, TTL behavior, session isolation, and one-shot bypass.
