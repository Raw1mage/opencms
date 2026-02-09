# DEBUG 日誌管理策略

**日期**: 2026-02-09  
**優先級**: Medium  
**狀態**: Analysis Complete

---

## 1. 現狀分析

### 現有日誌基礎設施

✅ **集中化機制**:
- `debugCheckpoint()`: 統一日誌入口 (256 使用點)
- `debugSpan()`: 用於追蹤執行流程
- **輸出**: `~/.local/share/opencode/log/debug.log` (XDG 標準)

✅ **安全篩選**:
- `safe()` 函數防止環形引用
- `flowKeys` 白名單提取上下文 (sessionID, messageID, callID 等)
- 自動 normalize 日誌行格式

### 現有日誌使用點

| 模組 | 用法 | 位置 |
|------|------|------|
| Antigravity | logger.ts (createLogger) | 插件特定 |
| Copilot | 日誌函數 | 待確認 |
| Gemini | 日誌函數 | 待確認 |
| Core | debugCheckpoint | src/util/debug.ts |

### 現有問題 ⚠️

1. **日誌級別混亂**
   - Logger 接口定義: debug, info, warn, error
   - debugCheckpoint 沒有級別區分
   - 無法按嚴重程度過濾

2. **敏感數據風險** (潛在)
   - refreshToken, apiKey, password 若被記錄 → 安全漏洞
   - 目前無自動敏感詞過濾機制
   - 依賴開發者正確使用

3. **日誌轉儲和歸檔**
   - 自動 normalize 機制存在 (normalizeMaybe/normalizeSoon)
   - 無自動清理策略
   - debug.log 可能持續增長

---

## 2. 改進計劃 (建議優先順序)

### Phase 1: 防止敏感數據洩露 (即時)

**目標**: 減少人為錯誤導致的敏感數據記錄

```typescript
// src/util/debug.ts 新增敏感詞過濾

const SENSITIVE_KEYS = new Set([
  "refreshToken",
  "token",
  "apiKey",
  "api_key",
  "apiSecret",
  "api_secret",
  "password",
  "passwd",
  "secret",
  "Authorization",
  "X-API-Key",
])

function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 20 ? value.slice(0, 10) + "..." : value
  }
  if (typeof value === "object" && value !== null) {
    const result = {}
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key)) {
        result[key] = "[REDACTED]"
      } else {
        result[key] = redactSensitive(val)
      }
    }
    return result
  }
  return value
}
```

**變更**:
- 在 `safe()` 函數中集成 `redactSensitive()`
- 文檔化敏感詞清單
- 開發者指南說明何時不應該記錄

### Phase 2: 日誌級別支持 (1-2 weeks)

**目標**: 支援日誌級別過濾 (DEBUG, INFO, WARN, ERROR)

```typescript
export enum LogLevel {
  DEBUG = 0,  // 詳細開發信息
  INFO = 1,   // 一般信息
  WARN = 2,   // 警告
  ERROR = 3,  // 錯誤
}

export function debugCheckpoint(
  scope: string,
  message: string,
  data?: Record<string, unknown>,
  level: LogLevel = LogLevel.DEBUG,
) {
  // 根據 OPENCODE_LOG_LEVEL 環境變數過濾
  const minLevel = getMinLogLevel()
  if (level < minLevel) return
  
  // ... 現有邏輯 ...
}
```

**變更**:
- 為 debugCheckpoint 增加 level 參數
- 支援環境變數 OPENCODE_LOG_LEVEL (debug|info|warn|error)
- 文檔化各級別的用途

### Phase 3: 日誌輪轉和清理 (2-3 weeks)

**目標**: 防止 debug.log 無限增長

```typescript
// 自動日誌輪轉
// - debug.log: 當日日誌
// - debug.1.log, debug.2.log, ... : 歷史日誌
// - 保留 7 天的日誌 (可配置)

const MAX_LOG_SIZE = 50 * 1024 * 1024  // 50MB per file
const MAX_LOG_FILES = 7  // 7 days

function rotateLogsIfNeeded() {
  // 檢查 debug.log 大小
  // 如果超過 MAX_LOG_SIZE，移至 debug.1.log，debug.1 → debug.2 等
  // 刪除超過 MAX_LOG_FILES 的舊文件
}
```

**變更**:
- 實現日誌輪轉機制
- 環境變數配置保留天數
- Cron 或定時清理任務

---

## 3. 短期行動 (本 Session)

基於現狀分析，進行 **Phase 1 實施**:

### 3.1 更新 safe() 函數

**檔案**: `src/util/debug.ts` (行 44-54)

```typescript
const SENSITIVE_KEYS = new Set([
  "refreshToken", "token", "apiKey", "api_key",
  "apiSecret", "api_secret", "password", "passwd",
  "secret", "Authorization", "X-API-Key"
])

function redactSensitive(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key)) {
    if (typeof value === "string") {
      return `[REDACTED-${value.length}chars]`
    }
    return "[REDACTED]"
  }
  return value
}

function safe(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (key, val) => {
    if (val instanceof Error) return val.stack || val.message
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]"
      seen.add(val)
    }
    // FIX: Redact sensitive keys before stringifying
    return redactSensitive(key, val)
  })
}
```

### 3.2 更新文檔 + 開發指南

**檔案**: 新建 `src/util/DEBUG-LOGGING.md`

```markdown
# DEBUG 日誌使用指南

## 安全規則

❌ **禁止記錄**:
- refreshToken, apiKey, password
- Authorization headers
- 完整的環境變數

✅ **可安全記錄**:
- sessionID, messageID, callID (已在 flowKeys)
- 操作類型 (read, write, delete)
- 錯誤信息 (不含敏感詞)
- 計數和統計數據

## 示例

```typescript
// ❌ BAD
log.debug("Loaded token", { token: account.refreshToken })

// ✅ GOOD
log.debug("Loaded account", { 
  email: account.email,
  hasToken: !!account.refreshToken 
})
```
```

---

## 4. 風險評估

### 當前敏感數據洩露風險: 🟠 **MEDIUM**

**原因**:
- 開發者可能在 log.debug() 中記錄敏感數據
- debugCheckpoint() 沒有敏感詞過濾
- 無自動檢查機制

**影響**:
- debug.log 可能含有 API 金鑰
- 若日誌被無意間分享 → 安全漏洞
- 需要 code review 才能發現

**緩解措施** (已實施):
- safe() 函數防止某些洩露
- flowKeys 白名單提取上下文

**建議**:
- Phase 1 立即實施敏感詞過濾
- 更新開發指南
- Code review 檢查清單中加入日誌檢查

---

## 5. 實施計畫

| 階段 | 任務 | 優先級 | 時間 |
|------|------|--------|------|
| 1 | 敏感詞過濾 (safe 函數) | 🔴 HIGH | Now |
| 1 | 開發指南 | 🟡 MEDIUM | Now |
| 2 | 日誌級別支持 | 🟡 MEDIUM | 1-2 weeks |
| 3 | 日誌輪轉清理 | 🟢 LOW | 2-3 weeks |

---

## 6. 相關檔案

- 日誌實現: `src/util/debug.ts` (270 lines)
- Logger 接口: `src/plugin/antigravity/plugin/logger.ts` (146 lines)
- Log 模組: `src/util/log.ts` (TBD)

---

**簽署**: OpenCode Technical Debt Review  
**下次檢查**: 1 週後確認 Phase 1 實施
