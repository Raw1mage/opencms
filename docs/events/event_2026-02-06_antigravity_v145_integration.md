# Event: Antigravity Auth Plugin v1.4.5 整合

**日期**: 2026-02-06
**狀態**: [EXECUTION] - 已完成主要功能
**來源**: upstream `refs/opencode-antigravity-auth` (v1.4.5)

---

## 背景

Claude thinking 模型在 subagent 執行 tool call 時出現 `Invalid 'signature' in 'thinking' block` 錯誤。根本原因分析指向 signature cache miss 和 sandbox endpoint 路由問題。

調查過程中發現 upstream antigravity-auth plugin v1.4.5 包含多項相關修復和新功能，需要整合到 cms branch。

---

## v1.4.5 重要變動摘要

### CHANGELOG 關鍵內容

| 功能 | 描述 | cms 狀態 | 優先級 |
|-----|------|---------|-------|
| `toast_scope` | 控制 toast 在子會話中的可見性 | ✅ 完成 | HIGH |
| `cli_first` | Gemini CLI quota 優先路由 | ✅ 完成 | MEDIUM |
| Soft Quota Protection | 跳過 90% 使用率的帳戶 | ⏭️ 跳過 (有 rotation3d) | HIGH |
| Antigravity-First Strategy | 跨帳戶耗盡 Antigravity quota 後再 fallback | ⏭️ 跳過 | MEDIUM |
| **#233 Sandbox Endpoint Skip** | **Gemini CLI 跳過 sandbox 端點** | ✅ 完成 | **CRITICAL** |
| Thinking Block Handling | 增強 thinking block 處理 | ✅ 已有（upstream 已回滾） | - |
| **Rotation 系統統一** | **跨進程帳戶健康狀態共享** | ✅ 完成 | **CRITICAL** |

---

## Tier 1 - Critical（修復阻塞問題）

### 1.1 #233 Fix: Sandbox Endpoint Skip

**問題**: Gemini CLI 模型（如 `gemini-3-flash-preview`）只能使用 production endpoint，但 cms branch 的 fallback loop 會嘗試所有端點（包括 sandbox），導致 404/403 錯誤級聯。

**修復位置**: `src/plugin/antigravity/index.ts`

**Upstream 代碼** (lines 1504-1509):
```typescript
if (headerStyle === "gemini-cli" && currentEndpoint !== ANTIGRAVITY_ENDPOINT_PROD) {
  pushDebug(`Skipping sandbox endpoint ${currentEndpoint} for gemini-cli headerStyle`);
  continue;
}
```

**任務**:
- [ ] 在 endpoint fallback loop 中添加 headerStyle 檢查
- [ ] 對 `gemini-cli` headerStyle 只使用 `ANTIGRAVITY_ENDPOINT_PROD`
- [ ] 添加 debug 日誌

---

### 1.2 toast_scope Configuration

**問題**: Subagent session 會收到重複的 toast 通知，造成 spam。

**修復位置**:
- `src/plugin/antigravity/plugin/config/schema.ts`
- `src/plugin/antigravity/index.ts`

**Upstream 實現**:
```typescript
// schema.ts
export const ToastScopeSchema = z.enum(["root_only", "all"]).default("root_only")

// index.ts
let isChildSession = false
let childSessionParentID: string | undefined
// ... 在 session.created 事件中檢測 parentID
```

**任務**:
- [ ] 添加 `ToastScopeSchema` 到 config/schema.ts
- [ ] 添加 `isChildSession` 和 `childSessionParentID` 追蹤
- [ ] 實現 session.created 事件處理器檢測 parentID
- [ ] 添加 toast 過濾邏輯

---

### 1.3 Soft Quota Protection

**問題**: 帳戶接近配額上限時繼續使用可能導致 Google 懲罰。

**修復位置**:
- `src/plugin/antigravity/plugin/config/schema.ts`
- `src/plugin/antigravity/plugin/accounts.ts`

**Upstream 配置選項**:
```typescript
soft_quota_threshold_percent: z.number().min(1).max(100).default(90)
quota_refresh_interval_minutes: z.number().min(0).max(60).default(15)
soft_quota_cache_ttl_minutes: z.union([z.literal("auto"), z.number()]).default("auto")
```

**關鍵函數**:
- `isOverSoftQuotaThreshold()`
- `isAccountOverSoftQuota()`
- `areAllAccountsOverSoftQuota()`
- `getMinResetTimeForSoftQuota()`

**任務**:
- [ ] 添加三個配置選項到 schema.ts
- [ ] 實現 soft quota 檢查函數到 accounts.ts
- [ ] 添加 quota cache TTL 管理
- [ ] 整合 soft quota 檢查到帳戶選擇流程

---

## Tier 2 - Important Features

### 2.1 cli_first Config Option

**功能**: 允許用戶優先使用 Gemini CLI quota，保留 Antigravity quota 給 Claude 模型。

**配置**:
```typescript
cli_first: z.boolean().default(false)
```

**任務**:
- [ ] 添加配置到 schema.ts
- [ ] 修改 model-resolver.ts 中的 quota 路由邏輯
- [ ] 添加測試覆蓋

---

### 2.2 Antigravity-First Strategy

**功能**: 跨所有帳戶耗盡 Antigravity quota 後再 fallback 到 Gemini CLI。

**關鍵函數**:
- `hasOtherAccountWithAntigravityAvailable()`
- `getMinResetTimeForAntigravityFallback()`

**任務**:
- [ ] 實現跨帳戶 Antigravity 可用性檢查
- [ ] 整合到帳戶輪換邏輯
- [ ] 添加測試套件

---

## 與 Claude Thinking Signature 錯誤的關聯

**原始錯誤**: `Invalid 'signature' in 'thinking' block`

**根本原因分析結果**:
1. Subagent 有不同的 `conversationKey` → signature cache miss
2. 使用 `skip_thought_signature_validator` sentinel
3. Google Cloud API 對 Claude thinking 不接受 sentinel

**v1.4.5 相關修復**:
- `toast_scope: "root_only"` 可減少 subagent 干擾
- `#233 Sandbox Skip` 確保 Gemini CLI 使用正確端點
- Thinking block handling 改進（upstream 已回滾，需評估）

**建議的額外修復**:
- 同步化 warmup 機制（確保 signature 在 tool call 前就緒）
- 優化 cache key 策略（讓 parent-child session 能共享 signature）

---

## 實施計畫

### Phase 1: Critical Fixes (預計 2-3 小時)
1. #233 Sandbox Endpoint Skip
2. toast_scope Configuration

### Phase 2: Quota Management (預計 3-4 小時)
3. Soft Quota Protection
4. cli_first Config Option

### Phase 3: Optimization (預計 2-3 小時)
5. Antigravity-First Strategy
6. 文檔更新和測試補充

---

## 參考文件

- Upstream CHANGELOG: `refs/opencode-antigravity-auth/CHANGELOG.md`
- Upstream commit history: v1.4.3 → v1.4.5
- 相關 Issues: #233, #337, #304

---

## DEBUGLOG

| 時間 | 動作 | 結果 |
|-----|------|------|
| 2026-02-06 | 初始分析完成 | 識別 6 項整合任務 |
| 2026-02-06 | #233 Sandbox Skip 實作 | ✅ 完成 |
| 2026-02-06 | toast_scope 設定 | ✅ 完成 |
| 2026-02-06 | cli_first 設定 | ✅ 完成 |
| 2026-02-06 | Rotation 系統統一 | ✅ 完成 - 解決 subagent 重複試 rate-limited model 問題 |
| 2026-02-06 | ModelHealthRegistry 降級 | ✅ 完成 - 決策邏輯改用 RateLimitTracker (3D) |
| 2026-02-06 | 統一狀態檔 | ✅ 完成 - 合併為 rotation-state.json |
| 2026-02-06 | 向後相容性修復 | ✅ 完成 - readUnifiedState() 自動遷移舊檔案 |

---

## Rotation 系統統一 (rotation_unify)

**問題**: Subagent 經常重複嘗試剛才被 rate limit 的模型，因為帳戶健康狀態沒有跨進程共享。

**根本原因**:
- `src/plugin/antigravity/plugin/rotation.ts` 有自己的 in-memory `HealthScoreTracker`
- `src/account/rotation.ts` 的全域 `HealthScoreTracker` 也是 in-memory only
- 只有 `RateLimitTracker` 和 `ModelHealthRegistry` 有檔案持久化

**修復**:
1. 為全域 `HealthScoreTracker` 添加檔案持久化 (`~/.local/state/opencode/account-health.json`)
2. 將 Antigravity plugin 的 `HealthScoreTracker` 改為 adapter，包裝全域追蹤器
3. 使用 `antigravity-account-{index}` 格式將 number index 轉換為 string ID

**修改檔案**:
- `src/account/rotation.ts` - 添加 `persistToFile()` 和 `loadFromFile()` 方法
- `src/plugin/antigravity/plugin/rotation.ts` - 改為 adapter 模式

**效果**:
- Parent session 的 rate limit 會立即被 subagent 看到
- 帳戶健康分數跨所有進程即時同步

---

## ModelHealthRegistry 降級 (rotation_unify Phase 2)

**問題**: `ModelHealthRegistry` 只追蹤 `provider:model` 維度（無帳號維度），導致一個帳號 rate limit 時，所有帳號對該模型都被標記為不可用。

**根本原因**:
- `provider.ts` 中的 `getSmallModel()` 使用 `ModelHealthRegistry.isAvailable()` 檢查可用性
- 此方法沒有帳號參數，無法區分不同帳號的狀態
- 導致 rotation3d 的跨帳號輪換機制被繞過

**修復**:
1. `src/provider/provider.ts`:
   - 移除 `getModelHealthRegistry` import
   - 新增 `isModelAvailable(pid, modelID)` async helper，使用 `RateLimitTracker` 檢查
   - 所有 `registry.isAvailable()` 調用改為 `await isModelAvailable()`

2. `src/session/llm.ts`:
   - 錯誤處理改為只使用 `RateLimitTracker.markRateLimited()` (有帳號維度)
   - 移除 `ModelHealthRegistry` 的使用

3. `src/plugin/antigravity/index.ts`:
   - 移除重複的 `getModelHealthRegistry().markRateLimited()` 調用
   - 移除重複的 `getModelHealthRegistry().markSuccess()` 調用
   - 保留 `getRateLimitTracker().markRateLimited()` (有帳號維度)

**修改檔案**:
- `src/provider/provider.ts` - 改用 `RateLimitTracker` 做可用性檢查
- `src/session/llm.ts` - 移除 `ModelHealthRegistry` 使用
- `src/plugin/antigravity/index.ts` - 移除重複的 `ModelHealthRegistry` 調用

**效果**:
- 決策邏輯統一使用 `RateLimitTracker` (3D: account:provider:model)
- 帳號 A 的 rate limit 不再影響帳號 B 使用同一模型
- `ModelHealthRegistry` 保留僅供監控/顯示用途

---

## 統一狀態檔 (rotation_unify Phase 3)

**問題**: 狀態分散在三個獨立的 JSON 檔案中，增加複雜度和潛在的同步問題。

**原先結構**:
- `rate-limits.json` - RateLimitTracker (3D: account:provider:model)
- `account-health.json` - HealthScoreTracker (帳號健康分數)
- `model-health.json` - ModelHealthRegistry (2D: provider:model, 僅監控用)

**修復**:
將 `rate-limits.json` 和 `account-health.json` 合併為單一 `rotation-state.json`:
```json
{
  "version": 1,
  "accountHealth": { [accountId]: { score, lastUpdated, lastSuccess, consecutiveFailures } },
  "rateLimits": { [accountId]: { [provider:model]: { resetTime, reason, model } } }
}
```

**修改檔案**:
- `src/account/rotation.ts`:
  - 新增 `readUnifiedState()` 和 `writeUnifiedState()` 函數
  - `HealthScoreTracker.persistToFile/loadFromFile` 改用統一檔案
  - `RateLimitTracker.persistToFile/loadFromFile` 改用統一檔案
  - `model-health.json` 保留供 `ModelHealthRegistry` 監控使用

**效果**:
- 狀態集中在單一檔案 (`~/.local/state/opencode/rotation-state.json`)
- 減少 I/O 操作次數（讀寫一個檔案而非兩個）
- 跨進程同步更可靠

---

## 向後相容性修復 (rotation_unify Phase 4)

**問題**: Activities 面板的 rate limit 倒數時間不顯示。

**根本原因**:
- 新的 `readUnifiedState()` 只讀取 `rotation-state.json`
- 舊的 rate limit 數據在 `rate-limits.json`
- 統一狀態檔不存在時返回空數據

**修復**:
`src/account/rotation.ts`:
- `readUnifiedState()` 添加向後相容性邏輯
- 如果 `rotation-state.json` 不存在，自動從 `rate-limits.json` 和 `account-health.json` 遷移
- 遷移完成後自動建立 `rotation-state.json`

**效果**:
- 首次執行時自動遷移舊數據
- Activities 面板正確顯示 rate limit 倒數時間
