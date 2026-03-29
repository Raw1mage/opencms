# Proposal

## Why

codex provider 的 CUSTOM_LOADER（CodexLanguageModel）試圖取代 AI SDK 的 25,000 行程式碼，只實作了 prompt 格式轉換和 stream 轉發，缺少 tool loop、schema validation、retry、lifecycle events 等 15+ 項功能。導致 tool call 後無回程、subagent 卡死、stream lifecycle 不完整。

根本原因：沒有先理解 AI SDK 做了什麼就去取代它。

同時，codex provider 的 5 項 Responses API 效能優化只啟用了 2 項（prompt_cache_key、sticky routing），遺漏了 store、serviceTier、encrypted reasoning、context_management、WebSocket transport、incremental delta、server compaction。

另外，codebase 中存在 1,390+ 行已廢棄的 dead code、重複的 auth plugin 邏輯、unsafe type casts、module-level 共享狀態等遺留問題。

## Original Requirement Wording (Baseline)

- "我想要 codex 的進階功能（incremental context, cache, compaction, encrypt）"
- "AI SDK 顯然是一個很完整現成的一大包功能，直接離開它似乎太冒然了"
- "不要浪費分析成果，把查到的架構原理先文件化"
- "請擬定一個plan，把上述server side api支援、高價值效能優化功能都加入實作計畫中"
- "websocket transport很重要必須做"
- "prewarm可以擱置"

## Requirement Revision History

- 2026-03-29: 初始需求 — 分析 AI SDK 架構 + codex 功能搬遷到 fetch interceptor
- 2026-03-29: 合併 codex-efficiency plan — 統一為「AI SDK 擴充重構」
- 2026-03-29: Prewarm 擱置；WebSocket transport 確認為必做
- 2026-03-29: 加入遺留清理（dead code、duplication、unsafe casts）

## Effective Requirement Description

1. 文件化 AI SDK 完整架構（✅ Phase 1 已完成）
2. 在 AI SDK path 上啟用全部 5 項 codex Responses API 效能優化
3. 實作 WebSocket transport adapter（fetch interceptor 層，不離開 AI SDK pipeline）
4. 清理遺留問題（dead code 1,390+ 行、auth plugin 重複、unsafe casts、shared state）
5. 有餘力時優化已知效能瓶頸

## Scope

### IN

- AI SDK 架構分析與文件化（✅ 已完成）
- providerOptions 注入（store, serviceTier, promptCacheKey, previousResponseId）
- Fetch interceptor 擴充（context_management body field）
- Fetch interceptor 去重（instructions, prompt_cache_key, auth plugin 合併）
- WebSocket transport adapter（fetch interceptor 內，WS ↔ SSE 轉換）
- Incremental delta（previous_response_id + delta input detection）
- Server-side compaction（/responses/compact + fallback）
- Dead code 移除（codex-language-model.ts, codex-websocket.ts, CUSTOM_LOADER branch）
- Unsafe type cast 移除（setAuth, setCompactThreshold, setCompactedOutput）
- Turn state per-session 隔離

### OUT

- Prewarm（generate: false）— 擱置
- 其他 provider 的重構
- AI SDK 上游修改
- C binary transport（已廢棄）
- client-side compaction 改進

## Constraints

- AI SDK pipeline（25K 行）必須保持完整 — 不修改、不取代
- 所有效能功能必須 graceful degrade
- AGENTS.md 第一條：禁止靜默 fallback
- WebSocket 必須有 HTTP SSE fallback

## What Changes

- `packages/opencode/src/session/llm.ts` — providerOptions 注入、response_id tracking
- `packages/opencode/src/provider/transform.ts` — codex providerOptions construction
- `packages/opencode/src/plugin/codex.ts` — fetch interceptor 擴充、WS transport adapter、auth plugin 合併
- `packages/opencode/src/provider/provider.ts` — CUSTOM_LOADER 移除
- `packages/opencode/src/provider/codex-language-model.ts` — 移除（816 行）
- `packages/opencode/src/provider/codex-websocket.ts` — 移除（574 行）
- `packages/opencode/src/provider/codex-compaction.ts` — 整合 server compaction
- `packages/opencode/src/session/compaction.ts` — server compaction trigger

## Capabilities

### New Capabilities

- **Encrypted Reasoning Reuse** — reasoning tokens 加密回傳，下次免重算
- **Priority Service Tier** — Pro 用戶走快車道
- **Context Management** — server-side inline compaction
- **WebSocket Transport** — persistent connection，支援 incremental delta
- **Incremental Delta** — 只送新增 input，不重送整個 history
- **Server Compaction** — server 端做 history 摘要

### Modified Capabilities

- **codex provider LLM call** — 從基本 HTTP SSE 升級為 WS + delta + cache + compaction

## Impact

- Token 消耗：長對話預期降低 50-90%
- Dead code：移除 1,390+ 行
- Type safety：移除所有 codex-related `as any` casts
- 檔案變更：~6 個 TS 檔修改 + 2 個 TS 檔移除

## IDEF0 / Grafcet

- IDEF0 模型：`plans/aisdk-refactor/diagrams/idef0.json`
  - A-0: Refactor Codex Provider Architecture
  - A1: Inject Provider Options (3 children: A11 store/tier, A12 cache key, A13 response_id)
  - A2: Extend Fetch Interceptor (2 children: A21 context_management, A22 dedup)
  - A3: Build WebSocket Transport Adapter (4 children: A31 connection, A32 WS→SSE, A33 synthetic response, A34 delta)
  - A4: Integrate Server Side Compaction
  - A5: Remove Dead Code (3 children: A51 CUSTOM_LOADER, A52 type casts, A53 turn state isolation)
- Grafcet 模型：`plans/aisdk-refactor/diagrams/grafcet.json`
  - G1: Phase Execution Sequence (S0-S8, 含 SG-2 WS bypass path)
  - G2: WebSocket Connection State Machine (WS0-WS4)
  - G3: Per-Request Transport Decision (R0-R5, 含 WS→HTTP fallback)

## Relation to codex-efficiency Plan

本 plan 合併並取代 `plans/codex-efficiency/` 的功能規劃。codex-efficiency plan 保留作為 spec/validation 參考，但執行以本 plan 為準。
