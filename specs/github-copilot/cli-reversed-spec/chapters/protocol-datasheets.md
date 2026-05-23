# Protocol Datasheets — copilot-cli Provider (OpenCMS Implementation)

**Source**: `packages/opencode/src/plugin/copilot-cli/` (9 modules)
**Reversed from**: `@github/copilot@1.0.48` CLI binary + production API observation
**Date**: 2026-05-19
**Purpose**: Complete wire-level specification of the copilot-cli provider's auth, routing, tool handling, and resilience layers

> **Reading guide**: 每個 §section 都是一個獨立的功能區塊。白話描述在前、技術欄位表在後。
> 不需要具備 AI/LLM 背景就能理解每個 section 的「目的」和「流程」。

---

## §1 — OAuth Device Flow（使用者登入）

### 白話說明

使用者第一次使用 Copilot 時，系統會顯示一組驗證碼（例如 `ABCD-1234`），
請使用者在瀏覽器打開 GitHub 頁面、貼上這組碼。
完成後系統自動拿到一把「通行證」（access token），後續所有 API 呼叫都用這把通行證。

### 流程

```
使用者按「登入」
    ↓
系統向 GitHub 要一組驗證碼（device_code + user_code）
    ↓
顯示 user_code 給使用者 → 使用者在瀏覽器完成授權
    ↓
系統每隔幾秒問 GitHub「使用者授權了嗎？」（polling）
    ↓
授權完成 → 拿到 access_token (gho_...)
    ↓
用 access_token 查使用者身分（login, email）
```

### 1a. Device Code 請求

**端點**: `POST https://github.com/login/device/code`
**觸發**: 使用者點選登入 → IDEF0-01 A1
**來源**: `plugin/copilot-cli/auth.ts:startDeviceFlow()`

| 欄位 | 類型 | 必要 | 值 / 來源 | 說明 |
|------|------|------|-----------|------|
| `client_id` | string | 必要 | `Ov23li8tweQw6odWQebz` | OpenCMS 的 OAuth App ID（scope 較窄，只有 read:user） |
| `scope` | string | 必要 | `read:user` | 只讀取使用者基本資料；CLI 用的是 `read:user,read:org,repo,gist` |

> **DD-1 決策**: OpenCMS 用自己的 Client ID，scope 只要 `read:user`。
> CLI 的 `Ov23ctDVkRmgkPke0Mmm` scope 更大，需要使用者重新授權。

**回應**:

| 欄位 | 類型 | 說明 |
|------|------|------|
| `verification_uri` | URL | 使用者要打開的網址（通常 `https://github.com/login/device`） |
| `user_code` | string | 使用者要輸入的驗證碼（8 字元） |
| `device_code` | string | 系統內部用，拿來 poll token（不給使用者看） |
| `interval` | integer | 每幾秒可以 poll 一次（GitHub 規定，太快會被罰） |
| `expires_in` | integer | 這組碼幾秒後過期（通常 900 = 15 分鐘） |

### 1b. Token Polling（輪詢授權結果）

**端點**: `POST https://github.com/login/oauth/access_token`
**來源**: `auth.ts:startDeviceFlow()` 內的 poll callback

| 欄位 | 類型 | 必要 | 值 / 來源 | 說明 |
|------|------|------|-----------|------|
| `client_id` | string | 必要 | 同上 | — |
| `device_code` | string | 必要 | 從 1a 拿到的 | — |
| `grant_type` | string | 必要 | `urn:ietf:params:oauth:grant-type:device_code` | RFC 8628 標準 |

**Polling 回應狀態**:

| 回應 | 動作 |
|------|------|
| `{ "error": "authorization_pending" }` | 繼續等，使用者還沒按確認 |
| `{ "error": "slow_down" }` | 增加等待間隔 +5 秒（GitHub 覺得你太急了） |
| `{ "error": "access_denied" }` | 使用者拒絕授權 → 報錯 |
| `{ "error": "expired_token" }` | 驗證碼過期了 → 報錯 |
| `{ "access_token": "gho_..." }` | 成功！拿到通行證 |

### 1c. 使用者身分查詢

**端點**: `GET https://api.github.com/user`
**Header**: `Authorization: Bearer gho_...`
**來源**: `auth.ts:startDeviceFlow()` 尾段

| 回應欄位 | 用途 |
|----------|------|
| `login` | 使用者名稱（顯示在 UI） |
| `email` | 使用者 email（顯示在帳號列表） |

---

## §2 — Token Exchange（通行證升級）

### 白話說明

GitHub 給的 access_token（`gho_...`）是「普通通行證」，能做基本事。
但 Copilot API 真正要的是一把「短期專用通行證」叫 `capiSessionToken`，
有效期只有幾分鐘到幾小時。系統會用普通通行證去換這把專用的。

如果換不到？沒關係，普通通行證也能用（只是功能可能受限）。這就是 DD-2 fallback。

### 流程

```
拿著 access_token (gho_...)
    ↓
POST /copilot_internal/v2/token（用 Bearer auth）
    ↓
成功 → 拿到 { token: "tid=...", expires_at: 1716000000 }
    ↓
失敗 → 退回用原本的 access_token（DD-2 fallback，記 warning log）
```

### 欄位規格

**端點**: `POST https://api.githubcopilot.com/copilot_internal/v2/token`
**來源**: `auth.ts:exchangeToken()`

**Request Headers**:

| Header | 值 | 說明 |
|--------|---|------|
| `Authorization` | `Bearer gho_...` | 用普通通行證去換專用的 |

**Response**:

| 欄位 | 類型 | 說明 |
|------|------|------|
| `token` | string | `capiSessionToken`，格式通常是 `tid=...;...` |
| `expires_at` | integer (Unix timestamp) | 過期時間，通常 30 分鐘 ~ 數小時 |

**Fallback 行為 (DD-2)**:

當 token exchange 失敗時（網路問題、API 變更等）：
- 記錄 `[copilot-cli] token exchange failed, falling back to raw access_token` warning
- 後續 API 呼叫改用 `gho_...` 作為 Bearer token
- 功能不一定完整，但不會完全斷線

---

## §3 — Auto-Refresh（通行證自動續期）

### 白話說明

`capiSessionToken` 會過期。系統在每次需要打 API 之前，
先看一下通行證還有沒有效。如果快過期了（剩不到 60 秒），
自動去重新換一把。使用者完全不用管。

### 流程

```
準備打 API → 呼叫 getBearer()
    ↓
capiSessionToken 還有效？（距過期 > 60 秒）
    ├─ 是 → 直接用
    └─ 否 → 重新跑 initAuth()（同時刷新 profile，DD-4）
              ↓
         新的 capiSessionToken 回來 → 用新的
         exchange 失敗 → 退回用 rawAccessToken
```

**來源**: `auth.ts:getBearer()`

| 參數 | 值 | 說明 |
|------|---|------|
| refresh buffer | 60 秒 | 距離過期 60 秒就視為「快過期」 |
| refresh 副作用 | profile 也會更新 | DD-4 決策：token 和 profile 綁一起刷 |

---

## §4 — User Profile & Feature Flags（使用者設定檔）

### 白話說明

登入後系統會去問 GitHub「這個使用者有什麼權限？用哪些 API 端點？開了哪些實驗功能？」
回來的資料決定了後續的路由行為（例如：該用新版 API 還是舊版 API）。

### 端點

**URL**: `GET https://api.github.com/copilot_internal/user`
**Enterprise**: `GET https://<domain>/api/v3/copilot_internal/user`
**Header**: `Authorization: Bearer gho_...`
**來源**: `profile.ts:fetchProfile()`

### 回應結構

| 欄位 | 類型 | 用途 |
|------|------|------|
| `login` | string | GitHub 使用者名稱 |
| `email` | string | 信箱 |
| `endpoints.api` | string | API base URL（預設 `https://api.githubcopilot.com`） |
| `endpoints.telemetry` | string | 遙測端點 |
| `feature_flags` | object | 功能開關（見下表） |
| `copilot_features` | object | 巢狀功能設定 |
| `subscription` | object | 訂閱等級資訊 |
| `organization_list` | array | 所屬組織 |
| `mcp` | object | MCP 設定 |

### 關鍵 Feature Flags

| Flag | 影響 |
|------|------|
| `copilot_cli_websocket_responses` | `true` → 使用 Responses API（新版）；`false` → Chat Completions（舊版） |
| `copilot_cli_opus_1m_default_model` | 預設模型選擇 |
| `copilot_cli_gpt_default_model` | GPT 預設模型 |
| `copilot_cli_focused_tools` | 工具篩選策略 |
| `copilot_cli_shell_spawn_backend` | Shell 執行後端 |

> **重要**: `copilot_cli_websocket_responses` 是決定 §8 Dual-Path Routing 的最高優先依據。

---

## §5 — Circuit Breaker（斷路器 / 故障隔離）

### 白話說明

如果 Copilot API 連續出錯（例如連續 5 次 500 錯誤），系統會「拉閘」——
暫時停止所有請求，等一段時間後才嘗試一個「探測請求」。
如果探測成功就恢復正常；失敗就繼續等，而且等更久。

這就像家裡的電路斷路器：短路時自動跳開，保護整個系統不被拖垮。

### 三態狀態機

```
                    5 次連續失敗
  [CLOSED 正常] ─────────────────→ [OPEN 斷路]
       ↑                                │
       │ 探測成功                   等待 30s
       │                                ↓
       └──────────── [HALF_OPEN 探測中]
                     │
                     │ 探測失敗 → 回到 OPEN
                     │   等待時間加倍（30s → 60s → 120s）
                     └───→ [OPEN 斷路]
```

### 設定值

**來源**: `circuit-breaker.ts` + `types.ts:DEFAULT_CIRCUIT_BREAKER_CONFIG`

| 設定 | 值 | 說明 |
|------|---|------|
| `failureThreshold` | 5 | 連續幾次失敗才斷路 |
| `resetTimeoutMs` | 30,000 (30 秒) | 斷路後等多久才試探 |
| `probeTimeoutMs` | 30,000 (30 秒) | 探測請求超時上限 |
| `statusCodes` | `[500, 502, 503, 504]` | 哪些 HTTP 狀態碼算「失敗」 |
| 最大退避 | 120,000 (120 秒) | exponential backoff 上限 |

### 狀態轉移規則

| 當前狀態 | 事件 | 動作 | 新狀態 |
|---------|------|------|--------|
| CLOSED | 請求成功 | 重設失敗計數 | CLOSED |
| CLOSED | 請求失敗（5xx） | 失敗計數 +1 | 計數 < 5: CLOSED |
| CLOSED | 第 5 次連續失敗 | 記錄斷路時間 | OPEN |
| OPEN | 任何請求 | 直接拒絕，不打 API | OPEN |
| OPEN | 等待時間到 | 開放一個探測名額 | HALF_OPEN |
| HALF_OPEN | 探測請求成功 | 重設一切 | CLOSED |
| HALF_OPEN | 探測請求失敗 | 等待時間 × 2（上限 120s） | OPEN |
| HALF_OPEN | 探測超時（30s） | 視同失敗 | OPEN |
| HALF_OPEN | 其他請求（非探測） | 阻擋 | HALF_OPEN |

> **DD-3 決策**: Circuit breaker 是獨立 utility class，未來可供其他 provider（gemini-cli 等）複用。

---

## §6 — Request Header Injection（請求標頭注入）

### 白話說明

每次打 Copilot API，系統會在 HTTP 請求上加一些特殊標頭。
這些標頭告訴 Copilot 伺服器「這個請求是誰發的、是什麼情境」。

### 標頭清單

**來源**: `index.ts:loader()` 的 custom fetch interceptor

| Header | 值 | 何時加 | 說明 |
|--------|---|--------|------|
| `Authorization` | `Bearer ${capiSessionToken 或 gho_...}` | 每次 | 身分驗證（由 getBearer() 提供） |
| `x-initiator` | `"user"` 或 `"agent"` | 每次 | 使用者直接操作 vs 子代理 |
| `Openai-Intent` | `conversation-edits` | 每次 | Copilot API 要求的固定值 |
| `Copilot-Vision-Request` | `true` | 有圖片時 | 告訴伺服器這次帶了圖片 |
| `User-Agent` | `opencode/${版本}` | 每次 | 來源標示 |

### 判斷邏輯

```
請求 body 裡有 image_url 或 input_image？
    ├─ 是 → 加 Copilot-Vision-Request: true
    └─ 否 → 不加

最後一則訊息的 role 不是 "user"？
    ├─ 是 → x-initiator: agent（代理發的）
    └─ 否 → x-initiator: user（使用者自己的訊息）

父 session 存在？（chat.headers hook）
    ├─ 是 → x-initiator: agent（子代理 session）
    └─ 否 → 維持原判斷
```

### 移除的標頭

| Header | 原因 |
|--------|------|
| `x-api-key` | AI SDK 預設會加，但 Copilot 不認，衝突 |
| `authorization` (小寫) | 避免和大寫 `Authorization` 重複 |

---

## §7 — Chat Completions API 路徑（舊版 API）

### 白話說明

這是 OpenAI 原始的對話 API 格式。大部分模型（GPT-4o, Claude 等）走這條路。
請求是一串「訊息陣列」，回應也是訊息格式。

### 端點

**URL**: `POST https://api.githubcopilot.com/chat/completions`
**來源**: `client.ts:streamCompletions()` / `callCompletions()`

### Request 格式

```json
{
  "model": "gpt-4o",
  "stream": true,
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi!", "tool_calls": [
      { "id": "call_abc", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"/tmp/x\"}" } }
    ]},
    { "role": "tool", "tool_call_id": "call_abc", "content": "file content here" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file from disk",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
      }
    }
  ]
}
```

### SSE Stream 事件

**格式**: `data: {json}\n\n`，結尾 `data: [DONE]\n\n`

| 事件類型 | 結構 | 說明 |
|---------|------|------|
| 文字片段 | `choices[0].delta.content` | 逐字串流出 |
| 工具呼叫開始 | `choices[0].delta.tool_calls[i].id` + `.function.name` | 宣告要呼叫哪個工具 |
| 工具引數片段 | `choices[0].delta.tool_calls[i].function.arguments` | 引數 JSON 逐段送出 |
| 結束原因 | `choices[0].finish_reason` | `"stop"` / `"tool_calls"` |

### Response 格式（非串流）

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Here is the answer",
      "tool_calls": [
        { "id": "call_abc", "type": "function", "function": { "name": "read_file", "arguments": "{...}" } }
      ]
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 }
}
```

---

## §8 — Responses API 路徑（新版 API）

### 白話說明

這是 OpenAI 的新版 API，只有較新的模型（GPT-5+）使用。
和舊版最大的差異：**工具呼叫和結果不是包在訊息裡面，而是獨立的頂層物件**。

想像舊版是「信封裡裝信」，新版是「信和信封分開放在桌上」。

### 端點

**URL**: `POST https://api.githubcopilot.com/responses`
**來源**: `client.ts:streamResponses()`

### Request 格式

```json
{
  "model": "gpt-5",
  "stream": true,
  "input": [
    { "role": "user", "content": [{ "type": "input_text", "text": "Hello" }] },
    { "role": "assistant", "content": [{ "type": "output_text", "text": "Hi!" }] },
    { "type": "function_call", "call_id": "call_abc", "name": "read_file", "arguments": "{\"path\":\"/tmp/x\"}" },
    { "type": "function_call_output", "call_id": "call_abc", "output": "file content here" }
  ],
  "tools": [
    {
      "type": "function",
      "name": "read_file",
      "description": "Read a file from disk",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
    }
  ]
}
```

### 關鍵差異對照

| 面向 | Chat Completions (§7) | Responses API (§8) |
|------|----------------------|-------------------|
| 端點 | `/chat/completions` | `/responses` |
| 訊息容器 | `messages` 陣列 | `input` 陣列 |
| 使用者文字 | `{ role: "user", content: "..." }` | `{ role: "user", content: [{ type: "input_text", text: "..." }] }` |
| 助手文字 | `{ role: "assistant", content: "..." }` | `{ role: "assistant", content: [{ type: "output_text", text: "..." }] }` |
| 工具呼叫 | 包在 `assistant.tool_calls[]` 裡 | **頂層** `{ type: "function_call", ... }` |
| 工具結果 | `{ role: "tool", tool_call_id, content }` | **頂層** `{ type: "function_call_output", call_id, output }` |
| 圖片 | `{ type: "image_url", image_url: { url } }` | `{ type: "input_image", image_url: url }` |
| tools 格式 | `{ type: "function", function: { name, ... } }` | `{ type: "function", name, ... }`（扁平，沒有 nested function） |

### SSE Stream 事件

| 事件 | 結構 | 說明 |
|------|------|------|
| 文字片段 | `type: "response.output_text.delta"` → `delta` | 逐字串流 |
| 文字完成 | `type: "response.output_text.done"` → `text` | 完整文字 |
| 輸出項新增 | `type: "response.output_item.added"` → `item` | 新項目（可能是文字或工具呼叫） |
| 工具引數片段 | `type: "response.function_call_arguments.delta"` → `delta` | 引數 JSON 逐段 |
| 工具引數完成 | `type: "response.function_call_arguments.done"` → `arguments` | 完整引數（比 delta 可靠） |
| 回應完成 | `type: "response.completed"` → `response` | 整個回應結束 |

---

## §9 — Dual-Path Routing 決策（走哪條路）

### 白話說明

系統會根據「這個模型適合走新版還是舊版 API」來選路。
選路的依據是：先看伺服器給的功能開關，再看模型名稱的版本號。

### 決策樹

```
shouldUseResponsesApi(modelID)?
    │
    ├─ profile 有 copilot_cli_websocket_responses flag？
    │     ├─ true → 走 Responses API (§8)
    │     └─ false → 走 Chat Completions (§7)
    │
    └─ 沒有 flag → 看模型名稱
          │
          ├─ GPT-5 或更新（但不是 gpt-5-mini）→ 走 Responses API
          └─ 其他所有模型 → 走 Chat Completions
```

**來源**: `models.ts:shouldUseResponsesApi()` + `isGpt5OrLater()`

### 路由影響

| 決策結果 | Request 格式 | Response 解析 | 工具格式 |
|---------|-------------|--------------|---------|
| Responses API | `promptToResponsesInput()` | `streamResponses()` SSE | `toolsToResponses()` |
| Chat Completions | `promptToMessages()` | `streamCompletions()` SSE | `toolsToCompletions()` |

> **gpt-5-mini 例外**: 雖然版本號 ≥ 5，但已知有相容性問題，強制走 Chat Completions。

---

## §10 — Tool Call Round-Trip（工具呼叫完整來回）

### 白話說明

當 AI 回覆中說「我需要讀一個檔案」，這就是 tool call。
整個流程是：AI 發出請求 → 系統執行工具 → 把結果送回 AI → AI 繼續回答。

這是所有 AI agent 的核心迴圈，也是最複雜的資料流。

### 完整流程

```
[1] AI 在串流回應中宣告要呼叫工具
    │
    │ Chat Completions: delta.tool_calls[i].function.name 出現
    │ Responses API:    response.output_item.added (type=function_call)
    │
[2] 引數逐段送達
    │
    │ Chat Completions: delta.tool_calls[i].function.arguments += chunk
    │ Responses API:    response.function_call_arguments.delta += chunk
    │
[3] 串流結束，組裝完整 tool call
    │
    │ adapter.ts 發出 { type: "tool-call", toolCallType: "function",
    │                    toolCallId, toolName, args }
    │ finish reason 必須是 "tool-calls"（不然 AI SDK 不會執行工具）
    │
[4] AI SDK 攔截 finish reason，交給 OpenCMS runloop 執行工具
    │
    │ runloop → tool executor → 拿到結果
    │
[5] 結果送回下一輪 API 呼叫
    │
    │ Chat Completions: { role: "tool", tool_call_id: "...", content: "結果" }
    │ Responses API:    { type: "function_call_output", call_id: "...", output: "結果" }
    │
[6] AI 收到結果，繼續回答（或再呼叫另一個工具）
```

### Tool Schema 轉換

AI SDK 傳進來的 tool 定義需要轉換成 Copilot API 能接受的格式：

**Chat Completions 格式** (`toolsToCompletions`):
```json
{ "type": "function", "function": { "name": "read_file", "description": "...", "parameters": {...} } }
```

**Responses API 格式** (`toolsToResponses`):
```json
{ "type": "function", "name": "read_file", "description": "...", "parameters": {...} }
```

> 注意：Responses API 的 tools 是**扁平結構**（name 在頂層），不是包在 `function:` 裡。

### Tool Result 序列化

**來源**: `adapter.ts:stringifyOutput()`

tool 執行結果可能是各種型態，需要統一轉成字串：

| 輸入型態 | 處理方式 |
|---------|---------|
| `string` | 直接用 |
| `Array<{ type: "text", text }>` | 取第一個 text |
| `{ text: string }` | 取 .text |
| `object` | JSON.stringify |
| `undefined` | 空字串 |

### Finish Reason 映射

| API 回傳 | AI SDK 對應值 | 說明 |
|---------|-------------|------|
| `"stop"` | `"stop"` | 正常結束 |
| `"tool_calls"` | `"tool-calls"` | 有工具要執行（**關鍵！**） |
| `"length"` | `"length"` | 超過 token 限制 |
| `"content_filter"` | `"content-filter"` | 內容被過濾 |
| 其他 | `"unknown"` | 未知 |

> **關鍵**: 如果任何 tool call 被偵測到，finish reason **必須**設為 `"tool-calls"`，
> 即使 API 回傳 `"stop"`。否則 AI SDK 不會觸發工具執行迴圈。

---

## §11 — bun compile Symbol 斷裂問題與解法

### 白話說明

AI SDK 用 JavaScript 的 `Symbol` 機制來識別 tool schema。
這在開發模式（直接跑 source code）沒問題，
但**編譯成 binary 後 Symbol 的身分會斷掉**——同一個名字的 Symbol 在不同模組裡變成「不同人」。

結果：AI SDK 認不出自己包裝的 schema，tool 定義變成空的，工具完全不能用。

### 問題根因

```
開發模式：
  Symbol.for("ai.schema") 在所有模組 → 同一個 Symbol ✓

bun compile 後：
  Symbol.for("ai.schema") 在模組 A → Symbol #1
  Symbol.for("ai.schema") 在模組 B → Symbol #2
  #1 ≠ #2 → isSchema() 回傳 false → schema 被當成不存在
```

AI SDK 的 `jsonSchema()` 工具用 `Symbol.for("ai.schema.jsonSchema")` 標記。
`isSchema()` 檢查時用同名 Symbol 去比對。
bun compile 的模組隔離讓這個比對失敗。

### 解法：rawToolSchemas Side-Channel

**來源**: `adapter.ts:getToolSchemaWithFallback()` + `resolve-tools.ts`

```
[1] OpenCMS 啟動時，resolve-tools.ts 預先把所有工具的 raw JSON schema
    存進一個 Map<toolName, jsonSchema>（叫 rawToolSchemas）

[2] adapter.ts 在準備 API 請求時，嘗試正常解開 AI SDK 的 Schema wrapper：
    ├─ 成功 → 用正常路徑
    └─ 失敗（Symbol 斷掉）→ 從 rawToolSchemas Map 讀 fallback

[3] getToolSchemaWithFallback() 的嘗試順序：
    a. t.parameters?.jsonSchema  （AI SDK 的 getter）
    b. t.parameters 本身（可能已經是 raw object）
    c. rawToolSchemas.get(t.name)（最終 fallback）
```

### 影響範圍

| 場景 | Symbol 有效？ | rawToolSchemas 需要？ |
|------|-------------|---------------------|
| `bun run` 開發模式 | ✓ | 不需要（但存在也不影響） |
| `bun compile` binary | ✗ | **必要**，否則所有工具壞掉 |
| Node.js 執行 | ✓ | 不需要 |

> **DD-9 決策**: copilot-cli 不在 data path 依賴 AI SDK runtime。
> adapter.ts 只 import **types**，不 import 執行邏輯。
> rawToolSchemas side-channel 是這個決策的實踐。

---

## §12 — Quota 查詢（配額用量）

### 白話說明

Copilot 有使用量限制。系統可以查詢「還剩多少額度」，
顯示在 UI 上讓使用者知道。

### 端點

**URL**: `GET https://api.githubcopilot.com/copilot_internal/v2/token`（主要）
**備用**: `GET https://api.githubcopilot.com/account/quota`
**來源**: `quota.ts:getCopilotQuota()`

### Response 結構

```json
{
  "quotaSnapshots": {
    "chat": {
      "entitlementRequests": 500,
      "usedRequests": 120,
      "usageAllowedWithExhaustedQuota": false,
      "remainingPercentage": 76,
      "overage": false,
      "resetDate": "2026-06-01T00:00:00Z"
    },
    "completions": { ... },
    "premium_interactions": { ... }
  }
}
```

| 欄位 | 說明 |
|------|------|
| `entitlementRequests` | 這個計費週期的總額度 |
| `usedRequests` | 已使用的額度 |
| `usageAllowedWithExhaustedQuota` | 額度用完後還能不能繼續用 |
| `remainingPercentage` | 剩餘百分比 |
| `overage` | 是否已超量 |
| `resetDate` | 額度重設日期 |

---

## 附錄 A — 完整模組依賴圖

```
index.ts (Plugin 入口)
  ├─→ auth.ts (OAuth + Token)
  │     ├─→ profile.ts (Profile fetch)
  │     └─→ types.ts
  ├─→ models.ts (Routing logic)
  │     └─→ auth.ts (讀 profile flags)
  └─→ adapter.ts (LanguageModelV2 bridge)
        ├─→ client.ts (HTTP + SSE)
        │     ├─→ auth.ts (getBearer)
        │     ├─→ circuit-breaker.ts
        │     └─→ types.ts
        ├─→ models.ts (routing decision)
        └─→ resolve-tools.ts (rawToolSchemas, lazy import)

quota.ts (獨立，由 provider layer 呼叫)
  ├─→ auth.ts
  └─→ types.ts
```

## 附錄 B — Enterprise 支援

| 面向 | GitHub.com | GitHub Enterprise |
|------|-----------|------------------|
| OAuth 端點 | `github.com/login/device/code` | `<domain>/login/device/code` |
| API 端點 | `api.github.com` | `<domain>/api/v3` |
| Copilot API | `api.githubcopilot.com` | profile 回傳的 `endpoints.api` |
| Domain 正規化 | — | 去掉 `https://` 和尾端 `/` |

---

## 附錄 C — Design Decision 索引

| DD # | 決策 | 影響的 §section |
|------|------|----------------|
| DD-1 | 用自己的 Client ID，scope 只有 read:user | §1 |
| DD-2 | Token exchange 失敗時 fallback 到 raw access_token | §2, §3 |
| DD-3 | Circuit breaker 是獨立 utility class | §5 |
| DD-4 | Auto-refresh 同時更新 profile | §3 |
| DD-5 | Profile/Token/Quota 為 module 內部狀態 | §4, §12 |
| DD-6 | Quota 透過 provider layer 的 getQuota() hook | §12 |
| DD-7 | 這是「重製複刻」不是「功能補齊」| 全域 |
| DD-8 | Plugin 自包含，不依賴其他 provider 模組 | 全域 |
| DD-9 | 最小化 AI SDK 依賴 + rawToolSchemas side-channel | §10, §11 |
| DD-10 | Provider family 命名為 copilot-cli | 全域 |
| DD-11 | 格式轉換邏輯從 AI SDK 複製到 plugin 內 | §7, §8, §10 |
| DD-12 | 驗證自建 data path 可行性 | §7, §8 |
| DD-13 | 基於 copilot-cli 經驗寫 new-provider SOP | — |
