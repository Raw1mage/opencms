# Event: Custom provider persistence and model hydration recovery

## 需求

- 修復自訂提供者（如 `miat`）設定修改後無法儲存的問題。
- 修復自訂提供者無法刪除的問題。
- 修復在自訂提供者新增 model（如 `qwen3.5:9b-128k`）後，模型管理員無法列出的問題。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-custom-provider.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/models.tsx`
- `/home/pkcs12/projects/opencode/packages/opencode/src/config/config.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/server/routes/global.ts`

### OUT

- 不改動 model manager drag/favorites/layout 的既有修復。
- 不新增 fallback 機制。

## 任務清單

- [x] 修復 custom provider 編輯表單回填來源
- [x] 修復 custom provider duplicate 檢查覆蓋 config.provider
- [x] 新增 custom provider 刪除路徑
- [x] 修復 custom provider models 進入 model manager hydration
- [x] 執行最小可行驗證（typecheck + 相關測試）

## Debug Checkpoints

### Baseline

- `miat` 在自訂提供者視窗中修改設定後無法儲存。
- `miat` 在自訂提供者視窗中無法刪除。
- 新增到 custom provider config 的 model，未出現在模型管理員列表。

### Implementation

- `packages/app/src/components/dialog-custom-provider.tsx`
  - 編輯模式改為從 `globalSync.data.config.provider[providerId]` 讀回 `name/models/baseURL/headers`，不再只依賴 `provider.all`。
  - duplicate provider 檢查納入 `config.provider` 中的 custom providers。
  - 新增刪除按鈕，前端改走新的 global config delete API。
- `packages/app/src/context/models.tsx`
  - model source 追加合併 `config.provider` 中 `@ai-sdk/openai-compatible` custom providers。
  - 讓 custom provider models（如 `miat/qwen3.5:9b-128k`）可進入 model manager。
- `packages/opencode/src/config/config.ts`
  - 新增 `Config.removeGlobalProvider(providerId)`，真正移除 global config 中的 custom provider，並同步清理 `disabled_providers`。
- `packages/opencode/src/server/routes/global.ts`
  - 新增 `DELETE /config/provider/:providerId` 路由，供前端刪除 custom provider config。

### Root Cause

- 問題一：custom provider 編輯表單回填來源過度依賴 `provider.all`，而不是以 `config.provider` 作為 custom provider 的真實編輯來源。
- 問題二：刪除流程缺乏對應的 global config delete API，導致前端無法真正移除 custom provider。
- 問題三：app models context 沒有把 `config.provider` 中的 custom provider models 合併進模型清單，造成 model manager 無法看到新模型。

### Validation

- `bun run typecheck`（repo root）✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/provider/provider.test.ts` ✅（0 pass / 66 skip / 0 fail）
- Architecture Sync: Verified (No doc changes)
  - 依據：本次修復的是 custom provider 設定回填、刪除 API 路徑與前端 model hydration 缺口，未改變長期模組邊界、核心資料流主幹或 runtime 狀態機。
