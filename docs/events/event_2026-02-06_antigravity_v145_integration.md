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
| `toast_scope` | 控制 toast 在子會話中的可見性 | ❌ 缺失 | HIGH |
| `cli_first` | Gemini CLI quota 優先路由 | ❌ 缺失 | MEDIUM |
| Soft Quota Protection | 跳過 90% 使用率的帳戶 | ❌ 缺失 | HIGH |
| Antigravity-First Strategy | 跨帳戶耗盡 Antigravity quota 後再 fallback | ⚠️ 部分 | MEDIUM |
| **#233 Sandbox Endpoint Skip** | **Gemini CLI 跳過 sandbox 端點** | ❌ 缺失 | **CRITICAL** |
| Thinking Block Handling | 增強 thinking block 處理 | ✅ 已有（upstream 已回滾） | - |

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
| | | |
