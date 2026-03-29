# Implementation Spec

## Goal

- 在 AI SDK pipeline 不變的前提下，為 codex provider 啟用 5 項 Responses API 效能優化 + WebSocket transport + 遺留清理

## Scope

### IN

- Phase 1: AI SDK 架構分析（✅ 已完成）
- Phase 2: providerOptions 注入（A1）+ fetch interceptor 擴充與去重（A2）+ dead code 移除（A5）
- Phase 3: WebSocket transport adapter（A3）+ incremental delta
- Phase 4: Server-side compaction（A4）

### OUT

- Prewarm（generate: false）— 擱置
- 其他 provider 重構
- C binary / CUSTOM_LOADER 恢復
- AI SDK 上游修改

## Assumptions

- AI SDK `@ai-sdk/openai` v2.0.89 支援 `store`、`serviceTier`、`promptCacheKey`、`previousResponseId` 等 providerOptions ✅ 已驗證
- AI SDK SSE parser 能消費 synthetic Response（WS events → SSE format）— 待驗證（SG-4）
- Bun native WebSocket client 支援 codex WS endpoint — 待驗證（SG-2）
- codex `/responses/compact` endpoint 存在且接受第三方 client — 待驗證

## Stop Gates

- **SG-1**: prompt_cache_key 被 server 忽略 → 分析 packet capture
- **SG-2**: WebSocket handshake 被 server 拒絕 → 停留 HTTP SSE，skip Phase 3
- **SG-3**: encrypted reasoning 造成 body 過大 → truncation 策略
- **SG-4**: AI SDK SSE parser 無法消費 synthetic Response → 深入分析 parser 預期格式

## Critical Files

| File | Role | Modification |
|------|------|-------------|
| `session/llm.ts` | LLM orchestration | providerOptions injection, response_id tracking |
| `provider/transform.ts` | Options construction | codex providerOptions (store, serviceTier) |
| `plugin/codex.ts` | Fetch interceptor | WS transport adapter, body transform, auth dedup |
| `provider/provider.ts` | Model loader | CUSTOM_LOADER removal |
| `provider/codex-language-model.ts` | Dead code | **Remove** (816 lines) |
| `provider/codex-websocket.ts` | Dead code | **Remove** (574 lines) |
| `session/compaction.ts` | Compaction trigger | Server compaction integration |

## Structured Execution Phases

### Phase 1: Analysis ✅ DONE

- AI SDK streamText pipeline (7 transform stages) documented
- @ai-sdk/openai responses adapter (17+ fields) analyzed
- 7 codex components mapped to AI SDK integration points
- Dead code inventory (1,390+ lines)
- Call path traced (12 stages, 2 injection points)
- IDEF0 (A-0 → A5, 15 activities) + Grafcet (G1-G3, 3 state machines)

### Phase 2: providerOptions + Cleanup (A1 + A2 + A5)

> 可並行：A11/A12 (providerOptions) 與 A51/A52 (dead code removal) 互不依賴

**A1: providerOptions**
1. A11: store=false + serviceTier=priority in transform.ts
2. A12: promptCacheKey migration to providerOptions
3. Verify: encrypted_content auto-include, cache key in body

**A2: Fetch interceptor**
4. A21: context_management body field
5. A22: Deduplicate auth plugins + remove redundant instructions/cache key logic

**A5: Dead code removal**
6. A51: Remove codex-language-model.ts + codex-websocket.ts + CUSTOM_LOADER branch
7. A52: Remove unsafe type casts (setAuth, setCompactThreshold, setCompactedOutput)
8. A53: Turn state per-session isolation

**Validation:**
- [ ] store=false → include has reasoning.encrypted_content
- [ ] serviceTier=priority in body
- [ ] context_management in body
- [ ] 0 new TypeScript errors
- [ ] No imports of removed files
- [ ] codex tool call loop normal
- [ ] codex + openai OAuth both work

### Phase 3: WebSocket Transport (A3)

> 依賴 Phase 2: providerOptions + dead code cleanup 必須先完成

**A3: WebSocket transport adapter**
1. A31: WS connection manager (per-session lifecycle, state machine)
2. A32: WS → SSE stream transform
3. A33: Synthetic Response construction
4. A34: Incremental delta (previous_response_id + delta detection)
5. A3D: Fallback (WS fail → HTTP) + validation

**Validation:**
- [ ] WS connection established (log)
- [ ] AI SDK SSE parser consumes synthetic Response
- [ ] Incremental delta input_tokens < 50% of full
- [ ] WS failure → automatic HTTP fallback
- [ ] E2E: codex tool call loop over WebSocket

### Phase 4: Server Compaction (A4)

> 可與 Phase 3 並行（HTTP path 即可使用 compaction）

1. A4: /responses/compact API call + trigger integration + fallback
2. Verify: compaction reduces token count > 50%

## IDEF0 / Grafcet Reference

- `diagrams/idef0.json` — 15 activities across 3 decomposition levels
- `diagrams/grafcet.json` — 3 Grafcets:
  - G1: Phase execution sequence (9 steps, SG-2 bypass path)
  - G2: WebSocket connection state machine (5 states)
  - G3: Per-request transport decision (6 states, 2 fallback paths)

## Handoff

- Build agent must read this spec + design.md first
- Build agent must read `diagrams/idef0.json` for activity decomposition
- Build agent must read `diagrams/grafcet.json` for state machine contracts
- Phase 3 的舊 code（codex-websocket.ts、codex-language-model.ts）**僅供參考**
- Wire protocol reference: `specs/codex-protocol/whitepaper.md`
