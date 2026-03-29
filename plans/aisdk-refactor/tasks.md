# Tasks

> 統一執行清單。每個 task = 單一檔案的單一修改 + 驗證條件。
> IDEF0 對照：A-level = section, leaf task = 一次 commit 可完成的最小改動。

## A1. Inject Provider Options Into AI SDK Path

### A11. Activate Store And Service Tier

> 注入點：`transform.ts` `options()` function (line 678)
> 現狀：`store=false` 已透過 `api.npm === "@ai-sdk/openai"` 條件涵蓋 codex ✅
> 缺：`serviceTier` 未設定；`promptCacheKey` 只對 `providerId === "openai"` 生效，不含 codex

- [ ] A11.1 `transform.ts:718` — 擴展 `promptCacheKey` 條件，加入 codex provider
  - 修改：`if (input.model.providerId === "openai" || input.model.providerId === "codex" || ...)`
  - 驗證：codex request body 出現 `prompt_cache_key` 欄位（由 AI SDK adapter 構建，非 interceptor）
- [ ] A11.2 `transform.ts:693` 後 — 新增 codex serviceTier 注入
  - 新增：`if (input.model.providerId === "codex") { result["serviceTier"] = "priority" }`
  - codex providerId = ChatGPT subscription only（無 API key 模式），providerId 判斷即充要條件
- [ ] A11.3 驗證 `store=false` 已生效 — codex request body 包含 `"store": false`
  - 方法：在 codex.ts fetch interceptor 加臨時 log `body.store` 值
- [ ] A11.4 驗證 AI SDK adapter 自動組合 `include`
  - 預期：`store=false` + reasoning model → body 自動含 `"include": ["reasoning.encrypted_content"]`
  - 方法：同上臨時 log `body.include`

### A12. Migrate Cache Key To Provider Options

> 現狀：codex.ts interceptor line 757-759 注入 `prompt_cache_key`
> 目標：改由 providerOptions → AI SDK adapter 構建 body，interceptor 只做 fallback

- [ ] A12.1 `codex.ts:757-759` — 改為 fallback-only
  - 修改：`if (!body.prompt_cache_key) { ... }` → 已經是 fallback（`if (!body.prompt_cache_key)`），確認即可
  - 實際：目前已是 fallback 模式 ✅ — 但 A11.1 完成後 AI SDK 會先設值，interceptor 不再觸發
- [ ] A12.2 驗證：prompt_cache_key 來源
  - 方法：在 interceptor log 中加入 `cacheKeySource: body.prompt_cache_key ? "providerOptions" : "interceptor"`

### A13. Track Response Identity For Delta

> 注入點：`llm.ts:609` `onFinish` callback — 可取得 event.providerMetadata
> 儲存點：需新建 per-session state 物件（或用 SharedContext）

- [ ] A13.1 確認 AI SDK `onFinish` event 包含 `providerMetadata.openai.responseId`
  - 方法：在 `llm.ts:609` onFinish 加臨時 log `event.providerMetadata`
  - 依據：aisdk-refactor design.md 確認 responses adapter 在 `response.completed` 時設 responseId
- [ ] A13.2 `llm.ts` — 新增 per-session codex state 物件
  - 定義：`const codexSessionState = new Map<string, { responseId?: string; instructionsHash?: string; toolsHash?: string }>()`
  - 位置：module-level（與現有 `lastRateLimitToastAt` 同級）
  - 或：用 SharedContext.set/get（如果 session scope 更合適）
- [ ] A13.3 `llm.ts:609` onFinish — 捕獲 responseId 存入 session state
  - 條件：只在 codex provider 時捕獲
  - 程式：`if (isCodex) codexSessionState.get(sessionID)?.responseId = event.providerMetadata?.openai?.responseId`
- [ ] A13.4 `llm.ts:570` — 計算 instructions + tools hash
  - 程式：`const currentHash = hash(JSON.stringify({ instructions: system, tools: Object.keys(tools) }))`
  - 比較上次 hash → 判斷 delta eligibility
  - 用 Bun 的 `Bun.hash()` 或簡單 string compare
- [ ] A13.5 `llm.ts:570` — 注入 previousResponseId 到 options
  - 條件：codex provider AND responseId 存在 AND hash 相同（delta eligible）
  - 程式：`if (deltaEligible) params.options.previousResponseId = prevResponseId`
  - 驗證：request body 出現 `previous_response_id` 欄位

## A2. Extend Fetch Interceptor Body Transform

### A21. Add Context Management Injection

> 注入點：`codex.ts` CodexNativeAuthPlugin fetch, body transform section (line ~749-773)

- [ ] A21.1 `codex.ts:769` 前 — 加入 context_management
  - 程式：`if (!body.context_management) { body.context_management = [{ type: "compaction", compact_threshold: THRESHOLD }] }`
  - THRESHOLD：先 hardcode `100000`（~80% of 128K），後續從 model config 讀取
  - 注意：不是所有 codex model 都支援 context_management — server 會忽略不支援的欄位（graceful degrade），不會報錯
- [ ] A21.2 驗證：request body 包含 `context_management` 欄位
  - 方法：現有 `codex fetch body transform` log 已印 hasCacheKey — 加印 `hasContextMgmt`

### A22. Deduplicate Fetch Interceptor Logic

> 兩個 auth plugin：CodexAuthPlugin (line 358-628, provider "openai") vs CodexNativeAuthPlugin (line 654-919, provider "codex")
> CodexNativeAuthPlugin 是 strict superset（多了 turn state + cache key）

- [ ] A22.1 確認 CodexAuthPlugin 是否仍有使用者
  - 查：openai provider 的 OAuth 用戶是否走 CodexAuthPlugin → 若 openai provider 永遠用 API key，則 CodexAuthPlugin 的 OAuth 路徑是 dead code
  - 方法：grep `provider: "openai"` 在 plugin 註冊處，確認 openai 是否也支援 OAuth
- [ ] A22.2 抽出共用邏輯到 helper functions
  - `buildCodexHeaders(init, auth, accountId)` — header construction (重複 ~25 行)
  - `transformCodexBody(bodyString)` — body transform (重複 ~20 行)
  - `refreshCodexToken(getAuth, providerId, input)` — token refresh (重複 ~15 行)
  - 位置：codex.ts module-level helper
- [ ] A22.3 CodexAuthPlugin — 改用 helper functions
  - 替換 lines 379-500 中的重複邏輯
- [ ] A22.4 CodexNativeAuthPlugin — 改用 helper functions
  - 替換 lines 669-773 中的重複邏輯
  - 保留獨有邏輯：turn state capture/replay, prompt_cache_key fallback
- [ ] A22.5 保留 instructions extraction（兩個 plugin 都保留）
  - AI SDK adapter 的 `instructions` 來自 `providerOptions.openai.instructions`
  - 但 `transform.ts options()` 只在 `usesInstructions` 能力開啟時才設 instructions 到 options
  - codex endpoint **要求**頂層 `instructions` 欄位 — interceptor 的提取邏輯是必要的後備
  - 行動：保留 instructions extraction，抽為共用 helper（A22.2 的 `transformCodexBody`）
- [ ] A22.7 驗證：codex OAuth 正常登入 + LLM call 正常
- [ ] A22.8 驗證：openai OAuth（如果存在）正常登入 + LLM call 正常

## A3. Build WebSocket Transport Adapter

### A31. Manage WebSocket Connection

> 位置：codex.ts 新增 module-level class/object
> 參考：codex-websocket.ts lines 1-100（connection setup）

- [x] A31.1 ~~查~~ codex WS endpoint URL — **已確認**
  - `wss://chatgpt.com/backend-api/codex/responses`（codex-websocket.ts:17）
  - Beta header: `OpenAI-Beta: responses_websockets=2026-02-06`（codex-websocket.ts:18）
  - Connect timeout: 15s, Max age: 55min（codex-websocket.ts:19-20）
- [x] A31.2 ~~查~~ AI SDK SSE parser 格式 — **已確認**
  - `createEventSourceResponseHandler()` → `parseJsonEventStream()` → `EventSourceParserStream` + `TransformStream`
  - 標準 SSE 格式：`data: {json}\n\n`，`data: [DONE]\n\n` 表示結束
  - 來源：`@ai-sdk/provider-utils/dist/index.js:759-773`
  - Response 需要：`response.body` 為 `ReadableStream`，content-type 無硬性要求（parser 不檢查）
- [ ] A31.3 `codex.ts` — 定義 `CodexWsManager` interface
  - ```ts
    interface CodexWsState { status: "idle" | "connecting" | "open" | "streaming" | "failed"; ws: WebSocket | null; sessionId: string }
    ```
  - 方法：`connect(headers)`, `send(body)`, `close()`, `isFailed()`
- [ ] A31.4 `codex.ts` — 實作 `connect()`
  - `new WebSocket(endpoint, { headers: {...} } as any)` — Bun 支援 custom headers（codex-websocket.ts:147 已驗證）
  - Headers: Authorization, OpenAI-Beta, chatgpt-account-id, originator, x-codex-turn-state
  - 設定 onopen/onclose/onerror/onmessage handlers
  - handshake timeout: 15s（與舊 code 一致）
- [ ] A31.5 `codex.ts` — 實作 per-session lifecycle
  - `codexWsManagers = new Map<string, CodexWsState>()`
  - 首次 codex fetch → `connect()`
  - session end / error → `close()` + 移除 entry
  - 注：session end event 需掛 Bus subscriber 或在 fetch interceptor 偵測
- [ ] A31.6 `codex.ts` — 實作 failure isolation
  - WS error/close → `status = "failed"`
  - `isFailed()` → 後續 fetch 直接走 HTTP
  - 不嘗試重連（session scope，下個 session 重開）

### A32. Transform WebSocket Events To SSE Stream

> 依賴：A31.2 確認的 SSE 格式

- [ ] A32.1 `codex.ts` — 定義 WS message handler → ReadableStream 的橋接
  - `new ReadableStream({ start(controller) { ws.onmessage = (e) => { ... } } })`
  - 每收到 WS text frame → 解析 JSON → 包裝成 SSE line → `controller.enqueue(encoder.encode(...))`
- [ ] A32.2 確認 WS event format
  - codex WS 回傳的是 JSONL（每行一個 JSON object）還是單個 JSON per frame？
  - 查 codex-websocket.ts `handleMessage()` 實作
- [ ] A32.3 實作 SSE 行格式化
  - 如果 AI SDK 期望 `data: {json}\n\n`：`controller.enqueue(encoder.encode(\`data: ${json}\n\n\`))`
  - 如果 AI SDK 期望 `event: xxx\ndata: {json}\n\n`：需加 event type
- [ ] A32.4 實作 stream 結束條件
  - WS 收到 `response.completed` / `response.failed` → `controller.close()`
  - WS error/close → `controller.error(new Error(...))`

### A33. Construct Synthetic HTTP Response

- [ ] A33.1 `codex.ts` — 在 WS path 中建構 Response
  - ```ts
    const response = new Response(sseStream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    })
    ```
- [ ] A33.2 turn state capture — WS path 無法從 response headers 取 turn state
  - 替代方案：從 WS message 中的 metadata 取 turn state（查 codex WS protocol）
  - 或：WS handshake response headers 可能帶 turn state
- [ ] A33.3 單元測試：建構 synthetic Response → 餵給 AI SDK SSE parser → 確認輸出正確
  - 輸入：手工構造的 SSE stream（模擬 `response.created` + `response.output_text.delta` + `response.completed`）
  - 預期：AI SDK 產出 `response-metadata`, `text-delta`, `finish` stream parts

### A34. Compute Incremental Delta

> 依賴：A13（response_id tracking）
> **已確認**：AI SDK adapter 只把 `previousResponseId` 放入 body 的 `previous_response_id`，**不做 input delta**（@ai-sdk/openai:3270）。Delta 裁剪必須在 fetch interceptor 層。

- [x] A34.1 ~~確認~~ AI SDK adapter 行為 — **adapter 不做 delta，只傳值**
- [ ] A34.2 `codex.ts` per-session state — 記錄上次 request 的 input items 數量
  - 儲存：`lastInputLength: number`（per-session Map）
  - 每次 fetch interceptor 攔截到 codex request 時更新
- [ ] A34.3 `codex.ts` fetch interceptor — 實作 input 裁剪
  - 條件：body 有 `previous_response_id` AND `body.input.length > lastInputLength`
  - 裁剪：`body.input = body.input.slice(lastInputLength)`（只保留新增 items）
  - 不裁剪：`previous_response_id` 不存在 或 input 長度未增長（重送全量）
- [ ] A34.4 驗證：delta mode 下 `input_tokens` < 全量 50%
  - 方法：log 中對比有無 `previous_response_id` 時的 input token 數

### A3D. Fallback And Validation

- [ ] A3D.1 `codex.ts` fetch interceptor — 加入 WS/HTTP 分支
  - 在 `isCodexEndpoint` 判斷後，加入：
    ```ts
    const wsManager = codexWsManagers.get(sessionId)
    if (wsManager && !wsManager.isFailed() && wsManager.status === "open") {
      return wsPath(wsManager, bodyString, headers)
    }
    // else: fall through to existing HTTP path
    ```
  - sessionId 從 headers `session_id` 取得（chat.headers hook 已設定）
- [ ] A3D.2 `codex.ts` — mid-request fallback
  - WS streaming 中斷 → catch error → 以相同 body 呼叫 HTTP fetch
  - 注意：abort signal 需正確傳遞
- [ ] A3D.3 驗證：正常 WS 流程（連線 → 送 request → 收 stream → complete）
- [ ] A3D.4 驗證：模擬 WS 斷線 → 自動 HTTP fallback → request 完成
- [ ] A3D.5 E2E 驗證：codex tool call loop (多步 tool call) 全程 WS

## A4. Integrate Server Side Compaction

> 參考：codex-compaction.ts（現有 code）

- [ ] A4.1 確認 `/responses/compact` endpoint 存在
  - 查 codex-compaction.ts 的 endpoint URL + request format
  - 查 whitepaper.md 是否提及 compact
- [ ] A4.2 確認 compact API 的 request/response format
  - Request: `{ conversation_history: [...], model: "..." }`?
  - Response: `{ compacted_history: [...] }`?
  - 需從 codex-compaction.ts source 確認
- [ ] A4.3 `compaction.ts` — 在 compaction trigger 中加入 codex server compact 分支
  - 條件：`model.providerId === "codex"`
  - 流程：call server compact → 成功 → 替換 history → 失敗 → fall through to client compact
- [ ] A4.4 `compaction.ts` — 實作 server compact API call
  - 用 codex fetch interceptor 的 auth（已有 Bearer token + Account-Id）
  - 或直接 call codex-compaction.ts 的現有函式
- [ ] A4.5 `compaction.ts` — fallback 處理
  - server 404/500/timeout → log.warn("server compact unavailable, falling back to client") → 走現有 client compact
- [ ] A4.6 驗證：server compact 呼叫成功（log）
- [ ] A4.7 驗證：server compact 失敗 → client compact 接手（模擬 404）

## A5. Remove Dead Code And Resolve Conflicts

### A51. Remove CUSTOM LOADER Infrastructure

- [ ] A51.1 `provider.ts:330-342` — 簡化 codex loader
  - 移除註解（CUSTOM_LOADER disabled pending...）
  - 簡化為：`codex: async () => ({ autoload: true, getModel: (sdk, id) => sdk.responses(id), options: {} })`
- [ ] A51.2 `provider.ts:291` — 確認 CUSTOM_LOADERS object 中 codex 條目是否有其他引用
  - grep `CUSTOM_LOADERS` 確認所有使用處
  - `provider.ts:1765` 迭代 CUSTOM_LOADERS — codex 條目仍需保留（只是簡化）
- [ ] A51.3 刪除 `codex-language-model.ts`（816 行）
  - `git rm packages/opencode/src/provider/codex-language-model.ts`
- [ ] A51.4 刪除 `codex-websocket.ts`（574 行）
  - `git rm packages/opencode/src/provider/codex-websocket.ts`
- [ ] A51.5 `codex.ts:909-915` — 移除 `codexPreconnectWebSocket()` fire-and-forget import
  - 刪除整個 `import("../provider/codex-language-model").then(...)` 區塊
- [ ] A51.6 grep 確認無殘留引用
  - `grep -r "codex-language-model" packages/opencode/src/`
  - `grep -r "codex-websocket" packages/opencode/src/`
  - `grep -r "codexPreconnectWebSocket" packages/opencode/src/`
  - 預期：0 matches
- [ ] A51.7 TypeScript check — `bun run typecheck` or equivalent → 0 new errors

### A52. Remove Unsafe Type Casts

- [ ] A52.1 `llm.ts:301-308` — 刪除 setAuth block
  - 刪除：
    ```ts
    if (typeof (language as any).setAuth === "function" && auth) {
      (language as any).setAuth({ ... })
    }
    ```
  - 理由：codex 走 AI SDK path，auth 由 plugin fetch interceptor 處理
- [ ] A52.2 `provider.ts:2271-2272` — 刪除 setCompactThreshold cast
  - 刪除：
    ```ts
    if (isCodex && ... && typeof (language as any).setCompactThreshold === "function") {
      (language as any).setCompactThreshold(...)
    }
    ```
  - 理由：compact threshold 改由 context_management body field 處理（A21）
- [ ] A52.3 `compaction.ts:584-585` — 刪除 setCompactedOutput cast
  - 刪除：
    ```ts
    if (typeof (language as any).setCompactedOutput === "function") {
      (language as any).setCompactedOutput(result.output)
    }
    ```
  - 理由：server compaction（A4）替代此邏輯
- [ ] A52.4 TypeScript check — 0 new errors

### A53. Isolate Turn State Per Session

- [ ] A53.1 `codex.ts:643-648` — 改 `codexTurnState` 為 per-session Map
  - 修改前：`const codexTurnState = { turnState: undefined, responseId: undefined }`
  - 修改後：`const codexTurnStates = new Map<string, { turnState?: string; responseId?: string }>()`
- [ ] A53.2 `codex.ts:726-728` — turn state replay 改為讀 Map
  - `const state = codexTurnStates.get(sessionId)`
  - `if (state?.turnState) headers.set("x-codex-turn-state", state.turnState)`
  - sessionId 從 headers `session_id` 取得
- [ ] A53.3 `codex.ts:777-781` — turn state capture 改為寫 Map
  - `const sessionId = headers.get("session_id")`
  - `if (sessionId && newTurnState) codexTurnStates.set(sessionId, { ...prev, turnState: newTurnState })`
- [ ] A53.4 `codex.ts:905-906` — chat.message hook reset 改為清 Map entry
  - `codexTurnStates.delete(sessionId)`
  - sessionId 從 `input.sessionID` 取得（已確認：user-message-persist.ts:21 傳 sessionID）
- [ ] A53.5 session 結束清理
  - 需掛 session end event 或依賴 Map entry 自然被 GC（如果 sessionId 不再被引用）
  - 或用 `WeakRef` / `FinalizationRegistry`（overkill for this case）
  - 簡單做法：chat.message hook 在新 session 開始時自然覆蓋舊 entry
- [ ] A53.6 驗證：開兩個 session 同時使用 codex → turn state 不串擾

## Phase 1 分析 ✅ DONE

- [x] 1.1 拆解 ai/dist/index.js streamText pipeline — 7 個 transform stage
- [x] 1.2 拆解 @ai-sdk/openai/dist/index.js responses adapter — 17+ 個 body 欄位
- [x] 1.3 對照 7 個 codex component 與 AI SDK integration point
- [x] 1.4 文件化到 design.md
- [x] 1.5 盤點 dead code（1,390+ 行）
- [x] 1.6 盤點 fetch interceptor 重複邏輯
- [x] 1.7 追蹤 LLM call path（12 stages, 2 critical injection points）
- [x] 1.8 IDEF0 + Grafcet 分析
