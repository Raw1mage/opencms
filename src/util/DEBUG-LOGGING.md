# DEBUG 日誌使用指南

**版本**: 1.0  
**更新**: 2026-02-09  
**相關**: `src/util/debug.ts` | `event_20260209_debug_logging_strategy.md`

---

## 快速開始

### 基本用法

```typescript
import { debugCheckpoint } from "../util/debug"

// ✅ 推薦
debugCheckpoint("my-module", "Processing request", {
  sessionID: "sess_123",
  messageID: "msg_456",
  operationType: "read",
  fileCount: 5,
})

// ❌ 禁止
debugCheckpoint("my-module", "Got token", {
  token: account.refreshToken,  // 敏感！
  apiKey: process.env.API_KEY,  // 敏感！
})
```

---

## 安全規則

### ❌ 禁止記錄

以下數據絕對禁止記錄到日誌：

1. **認證憑證**
   - `refreshToken`
   - `apiKey` / `api_key`
   - `apiSecret` / `api_secret`
   - `token`
   - `password` / `passwd`
   - `Authorization` headers

2. **個人信息**
   - 完整的 email 地址 (若非必要)
   - 用戶密碼
   - 信用卡信息

3. **環境變數**
   - `process.env` 物件全量
   - API 金鑰類環境變數

### ✅ 推薦記錄

以下數據可安全記錄：

1. **上下文 ID**
   - `sessionID` (已在 flowKeys)
   - `messageID` (已在 flowKeys)
   - `callID` (已在 flowKeys)
   - `projectId` (已在 flowKeys)

2. **操作信息**
   - 操作類型: "read", "write", "delete"
   - 資源計數: file count, token count
   - 狀態轉換: "starting", "completed", "failed"

3. **錯誤信息**
   - 錯誤訊息 (不含敏感詞)
   - 錯誤代碼
   - 棧追蹤

4. **度量數據**
   - 執行時間
   - 記憶體使用量
   - API 調用次數

---

## 實踐示例

### 例 1: Account 操作

```typescript
// ❌ BAD: 記錄完整 token
debugCheckpoint("account", "Loaded account", {
  email: account.email,
  refreshToken: account.refreshToken,
  projectId: account.projectId,
})

// ✅ GOOD: 只記錄存在性
debugCheckpoint("account", "Loaded account", {
  email: account.email,
  hasRefreshToken: !!account.refreshToken,
  projectId: account.projectId,
})

// ✅ BETTER: 記錄摘要
debugCheckpoint("account", "Loaded account", {
  accountEmail: account.email.slice(0, 5) + "...",
  hasCredentials: !!(account.refreshToken && account.projectId),
})
```

### 例 2: API 調用

```typescript
// ❌ BAD: 記錄完整的 API 響應 (可能含敏感數據)
debugCheckpoint("api-client", "API response", {
  response: fullResponse,
})

// ✅ GOOD: 記錄相關的結構化信息
debugCheckpoint("api-client", "API response received", {
  statusCode: response.status,
  contentLength: response.headers.get("content-length"),
  durationMs: Date.now() - startTime,
})
```

### 例 3: 權限檢查

```typescript
// ❌ BAD: 記錄完整的授權信息
debugCheckpoint("permission", "Checking permission", {
  authorization: req.headers.authorization,
  token: extractedToken,
})

// ✅ GOOD: 記錄權限信息
debugCheckpoint("permission", "Checking permission", {
  permission: "read:files",
  pattern: "/home/user/**",
  allowed: true,
})
```

---

## 敏感詞自動過濾

### 自動過濾列表

以下鍵名會自動被過濾並顯示為 `[REDACTED]`:

```
refreshToken, token, apiKey, api_key
apiSecret, api_secret, password, passwd
secret, Authorization, X-API-Key
```

**示例**:
```typescript
debugCheckpoint("test", "Data", {
  email: "user@example.com",      // ✅ 記錄
  refreshToken: "secret_token_123",  // ❌ 自動過濾為 [REDACTED-17chars]
  projectId: "proj_456",          // ✅ 記錄
})

// 輸出:
// [opencode] [timestamp] [test] Data {
//   "email": "user@example.com",
//   "refreshToken": "[REDACTED-17chars]",
//   "projectId": "proj_456"
// }
```

---

## Code Review 檢查清單

當審查使用 `debugCheckpoint()` 的 PR 時，檢查：

- [ ] 是否記錄了敏感詞 (token, apiKey, password 等)?
- [ ] 是否記錄了完整的環境變數?
- [ ] 是否記錄了完整的 HTTP 請求/響應體?
- [ ] 是否記錄了用戶敏感的個人信息?
- [ ] 日誌信息是否清楚表達了操作的目的?
- [ ] 是否包含了診斷所需的上下文 ID (sessionID, callID)?

---

## 故障排除

### Q: 我的敏感數據仍然被記錄

A: 檢查以下情況:
1. 您的鍵名是否在敏感詞清單中?
2. 敏感詞清單是否需要更新?
3. 您是否直接使用 `JSON.stringify()` 而非 `debugCheckpoint()`?

若發現遺漏的敏感詞，請提交 PR 更新 `SENSITIVE_KEYS` 清單。

### Q: 我需要記錄某個敏感數據用於調試

A: 做法:
1. 使用環境變數 `OPENCODE_DEBUG_SENSITIVE=1` 暫時啟用 (未來實現)
2. 或者，提取非敏感部分 (如長度、類型)
3. 或者，在開發環境手動設置斷點 debug

---

## 相關資源

- 實現: `src/util/debug.ts`
- 策略文檔: `docs/events/event_20260209_debug_logging_strategy.md`
- RCA 日誌系統: `src/util/log.ts` (TBD)

---

**簽署**: OpenCode Technical Debt Review  
**反饋**: 若有建議，請在 PR 中評論或聯繫維護團隊
