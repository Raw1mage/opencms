# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read design.md / tasks.md before coding
- Build agent must read `plans/aisdk-refactor/design.md` for AI SDK architecture analysis
- Build agent must read `specs/codex-protocol/whitepaper.md` for wire protocol reference
- Materialize tasks.md into runtime todos before coding
- Each phase is independently deliverable — commit and validate before proceeding to next
- **Phase 3 的舊 code（codex-websocket.ts、codex-language-model.ts）僅供參考，不可直接使用**

## Required Reads

- implementation-spec.md — phases, scope, validation criteria
- design.md — architecture decisions (DD-1 through DD-8), WebSocket transport adapter architecture
- tasks.md — execution checklist (5 phases)
- `plans/aisdk-refactor/design.md` — AI SDK 完整架構分析（streamText pipeline、responses adapter 欄位表、providerMetadata 流動）
- `specs/codex-protocol/whitepaper.md` — codex wire protocol reference

## Current State

- Phase 1 ✅: prompt_cache_key + sticky routing 已上線（fetch interceptor）
- Phase 2 ⚠️: zstd compression 已上線；providerOptions 注入（store, serviceTier）待做；encrypted reasoning replay 待驗證
- Phase 3 ❌: 舊 CUSTOM_LOADER WebSocket 已廢棄。需以 fetch interceptor transport adapter 重新實作
- Phase 4 ❌: server-side compaction + context_management 未開始

## Architecture Context（關鍵）

CUSTOM_LOADER 已廢棄。所有 codex 功能必須在 AI SDK pipeline 內實作：

```
LLM.stream() → providerOptions injection
  → AI SDK @ai-sdk/openai adapter → 構建 request body
    → fetch(url, { body, headers })
      → codex.ts fetch interceptor
        ├─ [HTTP] → fetch(codex_url) → SSE Response
        └─ [WebSocket] → WS connection → synthetic SSE Response
```

AI SDK 不知道底層是 HTTP 還是 WS — fetch interceptor 是唯一的 transport 切換點。

## Stop Gates In Force

- **SG-1**: prompt_cache_key ineffective → analyze packet capture
- **SG-2**: WebSocket rejected → stay on HTTP SSE
- **SG-3**: encrypted reasoning body overflow → implement truncation
- **SG-4**: AI SDK SSE parser can't consume synthetic Response → analyze parser format expectations

## Build Entry Recommendation

**Start with Phase 2**: 注入 `providerOptions.openai.store = false` + `serviceTier = "priority"`。

這是 2 行 code 在 llm.ts，立即生效：
- `store=false` → 自動啟用 encrypted reasoning include
- `serviceTier="priority"` → Pro 用戶走快車道

**Phase 3 prerequisites**:
- Phase 2 的 providerOptions 注入必須先完成（previousResponseId 也走 providerOptions）
- 需先分析 `@ai-sdk/openai` 的 SSE parser 預期格式（見 aisdk-refactor design.md 的 SSE Response Parse 章節）
- 需確認 codex WebSocket endpoint URL（參考 whitepaper.md + codex-websocket.ts 舊 code）

## Execution-Ready Checklist

- [x] Implementation spec is complete with 4 phases
- [x] Design doc updated with new WebSocket architecture (DD-4 revised, DD-7 prewarm shelved, DD-8 incremental delta)
- [x] Tasks.md updated — Phase 3 重新規劃（3A-3D）
- [x] AI SDK architecture analysis available (aisdk-refactor design.md)
- [x] Wire protocol reference available (whitepaper.md)
- [x] Stop gates defined with mitigation
- [x] Build entry point documented
