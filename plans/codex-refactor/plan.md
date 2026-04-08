# Codex Provider Refactor — 單一計畫書

版本：2026-04-09 rev2
狀態：施工中

---

## 一、背景

Codex provider 散布在 opencode core 多個檔案中（codex.ts 960 行、codex-websocket.ts 653 行、codex-native.ts 318 行），透過 fetch interceptor hack 注入 protocol 行為。需重構為獨立的 `@opencode-ai/codex-provider` package。

前置修復（已完成）：compact_threshold 動態化 + SessionSnapshot 廢除。

---

## 二、需求

1. Codex provider 重構為獨立 package
2. 實作 `LanguageModelV2` interface，直接對接 Responses API
3. **request body 必須與舊 provider 的 golden output 逐欄位一致**
4. **response event → StreamPart 映射必須與舊 AI SDK adapter（1733 行）行為一致**
5. WS transport + delta + continuation 在 package 內部完成
6. opencode 主程式零 codex 硬編碼

---

## 三、規格文件

### 權威來源

**官方文件（聖經）**：https://developers.openai.com/api/docs
- Responses API, Function calling, Streaming events, WebSocket mode, Tools

所有實作細節記錄在 **[datasheet.md](datasheet.md)**，包含：

- §1 Request body 每個欄位的值、來源、WS/HTTP 差異
- §2 Input items 六種格式的完整 schema（developer, user, assistant, function_call, function_call_output）
- §3 Tool schema
- §4 Response event → StreamPart 完整映射（11 種 added type、10 種 done type、7 種 delta type、state management）
- §5 providerOptions camelCase → snake_case 映射
- §6 sse.ts 目前缺少的 event handlers 和優先級
- §7 已知陷阱（11 項，每項有後果和正確做法）

Golden reference: **[golden-request.json](golden-request.json)**

---

## 四、Package 結構

```
packages/opencode-codex-provider/src/
├── protocol.ts      — 常數
├── types.ts         — API types
├── convert.ts       — prompt → request body（§1, §2 實作）
├── headers.ts       — headers builder
├── auth.ts          — OAuth PKCE
├── sse.ts           — events → StreamPart（§4 實作）
├── models.ts        — model catalog
├── continuation.ts  — WS continuation state
├── transport-ws.ts  — WS transport
├── provider.ts      — LanguageModelV2（§5 實作）
└── index.ts         — exports
```

### 整合點

| 檔案 | 修改 |
|---|---|
| `custom-loaders-def.ts` | codex loader 呼叫 `createCodex()` |
| `plugin/codex-auth.ts` | OAuth only（無 fetch interceptor） |
| `plugin/index.ts` | import from `codex-auth.ts` |
| `provider/provider.ts` | npm 改為 `@opencode-ai/codex-provider` |
| `provider/transform.ts` | store=false 加入 codex |
| `session/llm.ts` | 送 session_id header |

---

## 五、施工清單

### 已完成

- [x] Package 建立（11 files, 1924 LOC）
- [x] 整合 wiring（custom-loaders-def, codex-auth, index.ts, provider.ts, llm.ts）
- [x] WS transport 連線 + delta + continuation
- [x] Session context wiring（sessionId → provider via headers）
- [x] Cache reporting（cachedInputTokens from usage）
- [x] Tool call: `tool-call` StreamPart from `output_item.done`
- [x] Tool result: content parts array 直接傳
- [x] System prompt: developer role in input[0]
- [x] User/assistant content: content parts array 格式
- [x] providerOptions: store, service_tier, reasoning, text
- [x] Tool schema: strict:false
- [x] Golden request dump + datasheet + plan 整併

### 待修（datasheet §6 gap analysis）

- [ ] **finishReason = "tool-calls"**（有 function_call 時）— **高優先**
- [ ] text-end flush（stream 結束時補發）
- [ ] text-start 自動補發（delta 前無 added）
- [ ] response.created → response-metadata
- [ ] response.incomplete finishReason 映射
- [ ] annotation → source events
- [ ] reasoning encrypted_content metadata
- [ ] reasoning summary_part.added (index > 0)
- [ ] max_output_tokens 傳遞
- [ ] providerOptions 完整性驗證（對照 ProviderTransform.options 實際輸出）

### 待清理

- [ ] 移除舊 codex.ts 中的 CodexNativeAuthPlugin（已被 codex-auth.ts 取代）
- [ ] 移除 codex-websocket.ts（已被 transport-ws.ts 取代）
- [ ] 移除 codex-native.ts（FFI，未使用）
- [ ] 移除 provider.ts 中的 codex-compaction.ts 引用
- [ ] 驗證 core 零 codex 殘留：`grep -r "codex" src/ | grep -v plugin/codex`

---

## 六、驗證方法

| # | 項目 | 判定 |
|---|---|---|
| 1 | Golden diff | 新 request body top-level fields 與 golden-request.json 一致 |
| 2 | Tool call | AI 讀檔 → 完整回報內容（非空） |
| 3 | Multi-turn | 3+ 輪含 tool call，全部正常 |
| 4 | WS delta | R2+ inputItems < fullItems |
| 5 | Cache hit | R2+ cacheReadTokens > 0 |
| 6 | Abort zero | 整個 session 無 Tool execution aborted |
| 7 | Tool loop | AI 自主決定多次 tool call → 全部執行（finishReason=tool-calls 生效） |

---

## 七、Revision History

| 日期 | 事件 |
|---|---|
| 2026-04-08 | 初始需求、upstream 分析、beta workflow、merge to main |
| 2026-04-08~09 | Hotfix 迭代：session wiring, cache, tool-call, tool result, system prompt, providerOptions |
| 2026-04-09 | 計畫整併、datasheet 建立（golden dump + 1733 行 adapter 逐行分析） |
| 2026-04-09 rev2 | Plan 重寫：§三指向 datasheet、§五 gap analysis 完整施工清單、§六 增加 tool loop 驗證 |
