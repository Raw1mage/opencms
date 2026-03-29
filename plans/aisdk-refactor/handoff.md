# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read design.md 的 AI SDK 架構分析
- Build agent must read `diagrams/idef0.json` for IDEF0 activity decomposition
- Build agent must read `diagrams/grafcet.json` for Grafcet state machine contracts
- Build agent must materialize tasks.md into runtime todos
- Each phase independently deliverable — commit and validate before next
- **Phase 3 的舊 code（codex-websocket.ts、codex-language-model.ts）僅供參考，不可直接使用**

## Required Reads

| Document | Purpose |
|----------|---------|
| implementation-spec.md | Phases, scope, stop gates, validation |
| design.md | AI SDK 完整架構分析 + 7 component integration mapping |
| tasks.md | IDEF0-aligned execution checklist (A1-A5, 42 tasks) |
| diagrams/idef0.json | 15 activities, 3 decomposition levels |
| diagrams/grafcet.json | 3 state machines (phase sequence, WS lifecycle, transport decision) |
| specs/codex-protocol/whitepaper.md | Codex wire protocol reference |
| plans/codex-efficiency/spec.md | Behavioral requirements (GIVEN/WHEN/THEN) |

## Current State

| Component | Status | Detail |
|-----------|--------|--------|
| Phase 1 Analysis | ✅ DONE | AI SDK pipeline (7 stages), responses adapter (17+ fields), dead code inventory |
| prompt_cache_key | ✅ Active | Fetch interceptor injection (to migrate to providerOptions) |
| sticky routing | ✅ Active | x-codex-turn-state capture/replay (module-level, needs per-session isolation) |
| zstd compression | ✅ Active | Fetch interceptor, ChatGPT mode |
| store=false | ❌ Not set | Need providerOptions injection |
| serviceTier=priority | ❌ Not set | Need providerOptions injection |
| encrypted reasoning | ⚠️ Partial | AI SDK auto-include verified; session history replay unverified |
| context_management | ❌ Not done | Need fetch interceptor body transform |
| WebSocket transport | ❌ Old code dead | Need new fetch interceptor transport adapter |
| Incremental delta | ❌ Not done | Need response_id tracking + delta detection |
| Server compaction | ❌ Not done | Code exists but unintegrated |
| Dead code | ❌ 1,390+ lines | codex-language-model.ts, codex-websocket.ts, CUSTOM_LOADER branch |
| Auth plugin duplication | ❌ Present | CodexAuthPlugin ≈ CodexNativeAuthPlugin |
| Unsafe type casts | ❌ Present | setAuth, setCompactThreshold, setCompactedOutput |

## Architecture Context

```
User Message → SessionProcessor → LLM.stream()
  ├─ Provider.getLanguage() → sdk.responses(modelID)    ← A51: remove CUSTOM_LOADER
  ├─ transform.providerOptions() → { openai: {...} }    ← A11/A12/A13: inject here
  ├─ streamText({ model, providerOptions, messages })    ← AI SDK pipeline (untouched)
  │    └─ @ai-sdk/openai adapter → constructs body       ← 17+ fields auto-handled
  │         └─ fetch(url, { body, headers })              ← intercepted below
  └─ codex.ts fetch interceptor                          ← A2/A3: extend here
       ├─ Auth (Bearer, Account-Id)
       ├─ URL rewrite → codex endpoint
       ├─ Body: context_management                       ← A21: new
       ├─ Headers: x-codex-turn-state                    ← A53: per-session
       ├─ [HTTP mode] → fetch() → SSE Response           ← existing
       └─ [WS mode] → WS connection → synthetic Response ← A3: new
```

## Stop Gates In Force

- **SG-1**: prompt_cache_key ineffective → analyze packet capture
- **SG-2**: WebSocket handshake rejected → stay HTTP-only, skip Phase 3 (Grafcet T4_7_bypass)
- **SG-3**: encrypted reasoning body overflow → truncation strategy
- **SG-4**: AI SDK SSE parser rejects synthetic Response → analyze parser format

## Build Entry Recommendation

**Start with Phase 2 parallel tracks:**

Track A (providerOptions): A11 → A12 → verify → commit
Track B (dead code): A51 → A52 → verify → commit
Track C (fetch interceptor): A22 → A21 → verify → commit

All three tracks are independent. Can be done sequentially or in parallel worktrees.

**After Phase 2**: A53 (turn state isolation) → then Phase 3 (WebSocket).

## Execution-Ready Checklist

- [x] AI SDK architecture fully analyzed (design.md)
- [x] Dead code inventoried with line counts
- [x] Call path traced (12 stages, 2 injection points)
- [x] IDEF0 model complete (15 activities, 3 levels)
- [x] Grafcet model complete (3 state machines)
- [x] Tasks aligned to IDEF0 numbering (A1-A5, 42 tasks)
- [x] Behavioral specs available (codex-efficiency/spec.md)
- [x] Stop gates defined with mitigation
- [x] Build entry and parallelization documented

## Relation to codex-efficiency Plan

`plans/codex-efficiency/` 保留作為 spec/validation 參考（GIVEN/WHEN/THEN scenarios）。
執行以本 plan（aisdk-refactor）為準。codex-efficiency tasks.md 已更新指向本 plan。
