# 偵錯日誌 (Debug Log)

## 2026-02-01: Provider Name 正規化與 Model Health Dashboard (Provider Name Normalization & Model Health Dashboard)

### 問題摘要 (Problem Summary)

1. **Provider 名稱不一致**：代碼中混用 `"google"` 和 `"google-api"`，導致帳號管理和模型選擇邏輯混亂。
2. **Model Health Dashboard 無法跨進程共享**：TUI 與 Session Processor 運行在不同進程，`globalThis` 無法共享狀態。

### 根本原因分析 (Root Cause Analysis)

#### 1. Provider 名稱散落各處

- 不同文件使用不同的 provider ID 字串
- 缺乏統一的命名規範

#### 2. 跨進程狀態同步

- TUI 運行在 worker 進程中
- Session Processor 運行在主進程中
- `Symbol.for` + `globalThis` 無法跨進程邊界

### 關鍵修復步驟 (Critical Fix Steps)

#### 1. Provider Name 正規化 ✅

統一以下 provider ID：

- `anthropic`, `openai`, `google-api`, `gemini-cli`, `antigravity`, `opencode`, `github-copilot`

**修改文件**:

- `packages/opencode/src/account/index.ts` - PROVIDERS 陣列
- `packages/opencode/src/auth/index.ts` - families 陣列
- `packages/opencode/src/provider/provider.ts` - enabled checks, inheritance
- `packages/opencode/src/provider/health.ts` - comments, migration
- `packages/opencode/src/provider/transform.ts` - provider ID checks
- `packages/opencode/src/cli/cmd/auth.ts` - priority map, hints
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` - Account operations
- `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx` - priority, filters
- `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` - display map
- `packages/opencode/src/plugin/antigravity/constants.ts` - ANTIGRAVITY_PROVIDER_ID

#### 2. Model Health Dashboard 跨進程同步 ✅

**解決方案**：使用文件持久化取代記憶體共享

- 狀態文件：`~/.local/state/opencode/model-health.json`
- 每次讀寫前同步文件狀態
- Dashboard 每秒自動刷新

**修改文件**:

- `packages/opencode/src/account/rotation.ts` - 新增 `persistToFile()` 和 `loadFromFile()`
- `packages/opencode/src/cli/cmd/tui/component/dialog-model-health.tsx` - 4 欄表格格式

#### 3. Dashboard UI 優化 ✅

- 4 欄表格：Provider | Account | Model | Status
- 自動倒數計時顯示 Rate Limit 剩餘時間
- 快捷鍵：`R` 刷新、`C` 清除、`←` 返回

### 驗證結果 (Verification) ✅

- [x] 所有 `"google"` 參照已更新為 `"google-api"`
- [x] Model Health Dashboard 可顯示跨進程的模型狀態
- [x] Rate Limit 倒數計時正確更新
- [x] 背景 Agent 的模型互動也會更新 Dashboard

---

## 2026-01-31: DialogPrompt 輸入與 Google-API 配置流程修復

### 問題摘要 (Problem Summary)

在 `/admin` 介面新增 Google-API 帳號時，輸入 Account Name 後按下 Enter 鍵會出現以下問題：

1. **文字原地清空**：輸入框內容消失，但未觸發下一步。
2. **流程鎖死**：介面停留在 Account Name 提示頁面，無法進入 API Key 輸入頁面。
3. **按鍵衝突**：TUI 內底層的 `textarea` 預設行為與自定義的 `submit` 邏輯發生競爭。

### 根本原因分析 (Root Cause Analysis)

#### 1. 緩衝區競爭 (Buffer Race Condition)

TUI 的 `textarea` 組件在接收到 `return` 鍵時，內部可能存在預設的提交行為，該行為會在回調執行前或執行中清空緩衝區。這導致 `onConfirm` 讀取到的值為空，進而觸發了「防空輸入」機制，使得流程停止。

#### 2. 反應性遺失 (Reactivity Loss)

原本使用單一 `Show` 組件搭配 `!name().trim()` 來切換步驟。在複雜的 TUI 渲染週期中，這種類型的條件判斷有時無法及時觸發組件的重新掛載（Unmount/Remount），導致 UI 雖然邏輯上應該切換，但畫面上仍保留舊的 DOM 節點。

### 關鍵修復步驟 (Critical Fix Steps)

#### 1. 強化 DialogPrompt 穩定性 ✅

- **過濾關鍵字行為**：從 `textarea` 的鍵盤綁定中移除 `submit` 動作，防止其自動處理 Enter。
- **快照擷取**：在 `onContentChange` 中即時緩存內容，確保提交時即便緩衝區被清空，仍有最後一份有效快照可用。
- **雙重攔截**：同時在 `onKeyDown` 和 `useKeyboard` 中使用 `preventDefault()`，確保按鍵事件被專有處理。

#### 2. ApiMethod 狀態機重構 ✅

- 將 `Show` 改為 `Switch/Match` 結構，並引入顯式的 `step` 訊號 (`"name" | "api"`)。
- 這種方式強制 SolidJS 在步驟切換時完全替換組件分支，杜絕了舊 DOM 殘留的問題。

#### 3. 全局偵錯系統導入 ✅

- 在 `src/util/debug.ts` 實現了 `debugCheckpoint`。
- 在 `src/index.ts` 接入全域崩潰與啟動追蹤，方便後續分析 TUI 的黑盒行為。

### 驗證結果 (Verification) ✅

- [x] Account Name 輸入後按下 Enter 不再清空文字且能順利跳轉。
- [x] API Key 頁面能正確接收到前一步傳遞的帳號名稱。
- [x] `logs/debug.log` 成功紀錄了 `app:start` 與 `DialogPrompt:submit` 事件。

---

## 2026-01-31: /admin Google-API 編輯器與調試鏈完善

### 問題摘要 (Problem Summary)

在 `/admin` 的 Google-API 第二層，按下 `a` 無法穩定進入新增介面，且刪除帳號後會被強制退回上一層；模型選擇後也無法回到輸入框進行鍵盤輸入。

### 根本原因分析 (Root Cause Analysis)

- **Dialog 重建**：`google_add` 以內部 step 切換時會觸發 DialogAdmin 重新掛載，導致畫面跳回 root。
- **聚焦遺失**：dialog 關閉後沒有回復到 prompt input，導致鍵盤無法繼續輸入。

### 關鍵修復步驟 (Critical Fix Steps)

- **改為 Dialog Push**：Google-API 編輯器改成 dialog overlay (`dialog.push`) 以避免主 dialog state 重建。
- **全域 debug system**：加入 dialog stack tracing、error boundary、admin key trace 等 checkpoint。
- **聚焦修復**：dialog stack 清空時，自動 `promptRef.current?.focus()`。
- **刪除行為調整**：刪除帳號後保留在 account list，不再退回 root。

### 驗證結果 (Verification) ✅

- [x] Google-API 編輯器可穩定進入、輸入與保存。
- [x] 刪除帳號後仍留在第二層清單。
- [x] 選完模型後自動回到輸入框，鍵盤可繼續輸入。

---

## 2026-01-31: Rate limit 重導向與 Prompt 保留 (Rate Limit Reroute and Prompt Preservation)

### 問題摘要 (Problem Summary)

- 遇到 Rate limit (限速) 時，仍需要手動重新開啟 `/admin` 並導航到第三層模型列表來挑選另一個模型，在收到第一個錯誤後非常浪費時間。
- 早前的「Say hi」探測在真實 Prompt 遇到限速前就消耗了額外配額，因此探測成功並不保證下一個真實請求不會失敗。

### 根本原因分析 (Root Cause Analysis)

- Rate limit 只有在實際的 Prompt 請求出錯時才能被偵測到，而非合成探測完成時。
- 導航回 `/admin` 並重新選擇模型與一般的三層導航流程相同，這會讓使用者失去焦點並需要重新輸入文字。

### 關鍵修復步驟 (Critical Fix Steps)

- **自動重導向 Rate limit 處理器**：當 Prompt 狀態因 Rate limit 訊息進入 `retry` 時，我們會自動將對話框堆疊替換為 `DialogAdmin`，並預先聚焦在目前 Provider 的模型列表。
- **草稿保留 (Draft preservation)**：在重導向之前儲存目前的 Prompt 文字，並在 `/admin` 關閉後回復內容，確保不會遺失任何輸入。

### 驗證結果 (Verification) ✅

- 🤖 觸發了 Rate limit，確認 `/admin` 會自動開啟在故障 Provider 的第三層，並突顯模型列表以供快速重新選擇。
- ✏️ 關閉 `/admin` 後，我的草稿 Prompt 重新出現，且游標回到輸入框，讓我可以不需重新輸入即可重試。

## 2026-01-30: Antigravity 模型通信修復 (Antigravity Model Communication Fix)

### 問題摘要 (Problem Summary)

Antigravity models 無法正常通信，表現為：

1. **版本錯誤警告**：重複出現 "This version of Antigravity is no longer supported" 錯誤
2. **請求卡住**：模型請求停留在 "Build" 狀態，無法收到響應
3. **通信失敗**：即使發送簡單的 "hi" 消息也無法得到回應

### 根本原因分析 (Root Cause Analysis)

#### 主要問題 1: 版本兼容性

**位置**: `packages/opencode/src/plugin/antigravity/plugin/fingerprint.ts:22`

**問題**:

```typescript
const ANTIGRAVITY_VERSIONS = ["1.14.0", "1.14.5", "1.15.0", "1.15.2", "1.15.5", "1.15.8"]
```

**根本原因**:

- Antigravity 服務器從 2026-01-24 起只接受版本 `1.15.8`
- 代碼隨機從數組中選擇版本，導致 5/6 的概率選到舊版本
- 舊版本導致服務器拒絕請求並返回版本不支持錯誤
- `auto_update: true` 配置導致每次刷新都可能重新分配不同版本

**參考**: GitHub Issue [#324](https://github.com/NoeFabris/opencode-antigravity-auth/issues/324)

#### 主要問題 2: Gemini Transform 未正確應用

**位置**: `packages/opencode/src/plugin/antigravity/plugin/request.ts:824-832`

**問題**:

- `applyGeminiTransforms` 函數存在但未被調用
- Gemini models 的請求沒有經過必要的轉換處理
- 導致請求格式不符合 Antigravity API 要求

**根本原因**:

- 缺少 `isGeminiModel()` 檢查來判斷何時應用 Gemini 轉換
- 即使有調用，也缺少必需的 options 參數（model, tierThinkingBudget, normalizedThinking 等）

#### 次要問題: Debug 日誌干擾

**位置**: `packages/opencode/src/plugin/antigravity/index.ts:1364-1370`

**問題**:

- 硬編碼的 `console.log` 總是輸出 debug 信息
- 即使 debug 配置為 false 也會顯示
- 干擾正常使用體驗

### 關鍵修復步驟 (Critical Fix Steps)

#### 步驟 1: 修復版本兼容性 ✅

**文件**: `fingerprint.ts`

```typescript
// 修改前
const ANTIGRAVITY_VERSIONS = ["1.14.0", "1.14.5", "1.15.0", "1.15.2", "1.15.5", "1.15.8"]

// 修改後
const ANTIGRAVITY_VERSIONS = ["1.15.8"]
```

**影響**:

- 100% 使用服務器接受的版本
- 消除版本錯誤警告
- 確保認證成功

#### 步驟 2: 修復已存儲的賬戶數據 ✅

**命令**:

```bash
sed -i -E 's/"antigravity\/1\.(14|15)\.[0-9]+"/"antigravity\/1.15.8"/g' ~/.config/opencode/antigravity-accounts.json
```

**原因**:

- 已存儲的賬戶可能包含舊版本號
- 需要同步更新以保持一致性

#### 步驟 3: 實現 Gemini Transform 調用 ✅

**文件**: `request.ts`

```typescript
// 添加 Gemini model 檢查和轉換
if (isGeminiModel(effectiveModel)) {
  applyGeminiTransforms(requestPayload, {
    model: effectiveModel,
    tierThinkingBudget,
    tierThinkingLevel: tierThinkingLevel as ThinkingTier | undefined,
    normalizedThinking,
    googleSearch: options?.googleSearch,
  })
}
```

**關鍵點**:

- 使用 `isGeminiModel()` 檢查確保只對 Gemini models 應用轉換
- 傳遞所有必需的 options 參數
- 重用 `normalizedThinking` 變量避免重複計算

#### 步驟 4: 優化 Claude Transform 調用 ✅

**文件**: `request.ts`

```typescript
// 使用統一的 Claude 轉換函數
if (isClaude) {
  applyClaudeTransforms(requestPayload, {
    model: effectiveModel,
    tierThinkingBudget,
    normalizedThinking: extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody),
    cleanJSONSchema: cleanJSONSchemaForAntigravity,
  })
  // ... 其他 Claude 特定處理
}
```

#### 步驟 5: 移除硬編碼 Debug 日誌 ✅

**文件**: `index.ts`

```typescript
// 刪除第 1364-1370 行的硬編碼 console.log
// 現在 debug 日誌完全由配置控制
```

#### 步驟 6: 清除緩存並重啟 ✅

```bash
rm -rf ~/.cache/opencode
pkill -9 -f "bun run dev"
bun run dev
```

### 技術洞察 (Technical Insights)

#### 為什麼這個 Bug 難以發現？

1. **隨機性掩蓋問題**:
   - 版本隨機選擇導致問題間歇性出現
   - 有 1/6 概率選到正確版本，讓問題看起來不穩定

2. **多層次失敗**:
   - 版本錯誤 + Transform 缺失 = 雙重失敗
   - 即使修復一個，另一個仍會導致失敗

3. **錯誤信息誤導**:
   - "version not supported" 警告重複出現
   - 但真正的問題是請求格式不正確

#### 關鍵診斷方法

1. **檢查 GitHub Issues**:
   - Issue #324 提供了版本問題的明確解決方案
   - 社區已經遇到並解決了相同問題

2. **代碼審查**:
   - 檢查 `applyGeminiTransforms` 的調用位置
   - 驗證所有必需參數是否正確傳遞

3. **測試驗證**:
   - 運行 `bun test` 確保所有 transform 測試通過
   - 129/129 Gemini transform 測試通過證明修復正確

### 驗證結果 (Verification) ✅ 全部完成

- [x] 版本錯誤警告完全消失
- [x] 模型請求不再卡在 "Build" 狀態
- [x] 可以正常與 Antigravity models 對話
- [x] TypeScript 類型檢查通過（無編譯錯誤）
- [x] 所有 Gemini transform 測試通過（129/129）
- [x] Debug 日誌只在配置啟用時顯示
- [x] 賬戶數據版本號已更新為 1.15.8
- [x] **實際測試確認**: Claude Opus 4.5 Thinking 成功進行多輪中文對話
- [x] **Rate Limit 機制正常**: 正確顯示重試提示和等待時間

**最終確認時間**: 2026-01-30 20:30 (UTC+8)
**測試模型**: claude-opus-4-5-thinking
**測試結果**: ✅ 完全正常工作

### 服務狀態儀表板 (Service Status Dashboard - 增強功能)

為了解決使用者關於「Dashboard 直覺度不足」的意見，我們重構了 `/dashboard` 指令：

- **結構優化**：
  - 改為按 Provider 分組顯示 (Anthropic, OpenAI, Antigravity 等)。
  - 統一了 `/accounts` 和 `/dashboard` 的展示邏輯，提供一致的使用者體驗。
- **功能增強**：
  - **Antigravity**：專屬表格視圖，顯示每個帳號在 Claude, Gemini AG, Gemini CLI 三個維度的獨立 Rate Limit 狀態。
  - **其他 Provider**：顯示帳號活躍狀態 (Active/Ready)。
- **技術實現**：
  - 整合了 `Account.listAll()` (通用配置) 和 `globalAccountManager` (即時狀態) 的數據。
  - 使用 `write_to_file` 重寫了 `src/command/index.ts` 以確保代碼結構完整性。

### 穩定性與故障排除 (Stability Troubleshooting)

使用者回報 `opencode` 在閒置一段時間後會進入「沒畫面」狀態並顯示 `Terminated`。

- **現象**：TUI 停止響應，終端顯示 `Terminated` 和 `^[\`。
- **分析**：
  - `Terminated` 通常表示進程收到了 `SIGTERM` 信號。
  - 常見原因：SSH 會話超時 (TMOUT)、作業系統內存不足 (OOM Killer) 或手動殺死。
  - 代碼審查：我們檢查了 Antigravity 插件的 `ProactiveRefreshQueue` (每 5 分鐘運行一次) 和 `fetch` 循環，未發現死循環或明顯的內存洩漏源。
- **建議**：
  - 如果問題持續發生（例如每 20 分鐘），建議使用 `bun run dev -- --print-logs` 運行以捕獲崩潰前的日誌。
  - 檢查服務器的內存使用情況。

### 經驗教訓 (Lessons Learned)

1. **版本管理的重要性**:
   - 硬編碼的版本列表需要及時更新
   - 應該有機制檢測服務器支持的版本

2. **Transform 函數的必要性**:
   - 不同 AI providers 需要不同的請求格式
   - Transform 函數必須被正確調用才能工作

3. **Debug 日誌的最佳實踐**:
   - 避免硬編碼的 console.log
   - 使用配置化的 debug 系統

4. **社區資源的價值**:
   - GitHub Issues 是寶貴的問題解決資源
   - 其他用戶可能已經遇到並解決了相同問題

### 相關文件 (Related Files)

- `packages/opencode/src/plugin/antigravity/plugin/fingerprint.ts` - 版本配置
- `packages/opencode/src/plugin/antigravity/plugin/request.ts` - 請求轉換邏輯
- `packages/opencode/src/plugin/antigravity/index.ts` - 主插件入口
- `packages/opencode/src/plugin/antigravity/plugin/transform/gemini.ts` - Gemini 轉換實現
- `packages/opencode/src/plugin/antigravity/plugin/transform/claude.ts` - Claude 轉換實現

### 參考資料 (References)

- [GitHub Issue #324](https://github.com/NoeFabris/opencode-antigravity-auth/issues/324) - Antigravity 版本兼容性問題
- Antigravity API 文檔 - 版本要求說明

---

## 2026-01-29: 隱藏 Anthropic 基底 Provider (Hide Base Anthropic Provider When Subscription Active)

### 已識別問題 (Issues Identified)

1. **Claude Code OAuth 認證被錯用**：當 `/accounts` 已啟用 `anthropic-subscription-*` 時，`/models` 仍顯示基底 `anthropic` provider 的模型，導致對話時回報「This credential is only authorized for use with Claude Code...」。
2. **模型清單與帳號狀態不一致**：同一 family 同時顯示 base provider 與 subscription provider，造成實際可用模型與顯示狀態脫節。

### 已實施修復 (Fixes Implemented)

1. **隱藏 base provider**：`packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` 若同一 family 有 active subscription，過濾掉 base provider（例如 `anthropic`）。
2. **保留 active 模型**：只保留 active subscription 的模型，避免使用錯誤的認證通道。

### 驗證 (Verification)

- [ ] 當 `anthropic-subscription-*` 為 active 時，/models 不再顯示 `anthropic` 基底模型。
- [ ] 選擇 Claude Sonnet 4.5 (2025-09-29) 可正常對話且不再出現 Claude Code 認證錯誤。

## 2026-01-29: Google API Key 未注入帳號模型 (Google API Key Missing in Account Providers)

### 已識別問題 (Issues Identified)

1. **/models 顯示可用但實際缺金鑰**：Google API Key 帳號在 `/accounts` 中為 active，但對話時顯示 `Google Generative AI API key is missing`。
2. **帳號層級 options 未傳遞**：`Account.listAll()` 匯入的 `type: "api"` 帳號未把 `apiKey` 注入 provider options，導致 SDK 判斷金鑰不存在。

### 已實施修復 (Fixes Implemented)

1. **補上 apiKey 注入**：在 `packages/opencode/src/provider/provider.ts` 的 account 匯入流程中，`type: "api"` 將 `accountInfo.apiKey` 寫入 `options.apiKey`。

### 驗證 (Verification)

- [ ] 使用 Google API Key 帳號選擇 `gemini-2.5-pro`，不再出現 `API key is missing`。

## 2026-01-29: Gemini Embedding 全面排除 (Global Gemini Embedding Exclusion)

### 已識別問題 (Issues Identified)

1. **Embedding 模型仍出現於帳號 provider**：`gemini-embedding-001` 在 `google-api-*` 與 `gemini-cli-subscription-*` 仍被列出，導致 `/model-check` 出現 `Skipping: Embedding models not supported for chat health check`。

### 已實施修復 (Fixes Implemented)

1. **全域排除**：在 `packages/opencode/src/provider/provider.ts` 的 `isModelIgnored` 增加 `modelID === "gemini-embedding-001"` 直接排除所有 provider 變體。

### 驗證 (Verification)

- [ ] `/model-check --json` 不再出現 `gemini-embedding-001` 的 unavailable entries。

## 2026-01-29: Health Check 忽略 Embedding 模型 (Skip Embeddings in Health Check)

### 已識別問題 (Issues Identified)

1. **/model-check 仍列出 embedding**：即使 UI 已隱藏，健康檢查仍會把 embedding 視為 unavailable。

### 已實施修復 (Fixes Implemented)

1. **健康檢查跳過 embedding**：在 `packages/opencode/src/provider/health.ts`，當 `family` 包含 `embedding` 或 `modelID` 包含 `embedding` 時，直接 `continue`，不納入檢查結果。

### 驗證 (Verification)

- [ ] `/model-check` summary 不再把 embedding 計入錯誤。

## 2026-01-30: CLI 測試迴圈免載入 TUI (Headless Model-Check Without TUI)

### 已識別問題 (Issues Identified)

1. **Bun 直接執行 CLI 失敗**：`/home/pkcs12/.bun/bin/bun ./packages/opencode/src/index.ts model-check` 會因為 TUI 模組引入 `react/jsx-dev-runtime` 而中斷。

### 已實施修復 (Fixes Implemented)

1. **延遲載入 TUI 命令**：在 `packages/opencode/src/index.ts`，以動態 import 載入 TUI 命令，並允許 `OPENCODE_SKIP_TUI=1` 跳過。

### 驗證 (Verification)

- [x] `OPENCODE_SKIP_TUI=1` 執行 `model-check --json` 成功完成。
- [x] `unavailableModels` 為 0。

## 2026-01-30: /models 真實互動式煙測 (Interactive Model Smoke Test)

### 已識別問題 (Issues Identified)

1. **/models 實測與 model-check 不一致**：手動切換模型並輸入 `hi` 時出現真實錯誤，model-check 無法反映。
2. **Anthropic 訂閱憑證受限**：Claude Code 訂閱憑證回傳「only authorized for use with Claude Code」。
3. **Google Gemini 模型列表過寬**：多個 `*-preview-*`、`live-*` 模型在 API 端回應 `NOT_FOUND` 或超時。

### 已實施修復 (Fixes Implemented)

1. **新增 model-smoke 指令**：`packages/opencode/src/cli/cmd/model-smoke.ts` 以實際 SessionPrompt 逐一送出 `hi`，模擬 /models 行為。
2. **自動 ignorelist**：新增 `ignored-models.json` 動態清單，model-smoke 會把 `timeout/NOT_FOUND/unsupported` 的模型加入忽略清單，/models 同步隱藏。
3. **Claude Code 訂閱標示**：Anthropic 訂閱帳號標記為 blocked，/models 會顯示原因並禁用選擇。

### 驗證 (Verification)

- [ ] `model-smoke` 可逐一跑完並將錯誤模型加入忽略清單。
- [ ] /models 不再顯示已被 ignorelist 的模型。

## 2026-01-29: /models 只顯示 active 訂閱者並標示家族歸屬 (Active Subscription Labeling in /models)

### 已識別問題 (Issues Identified)

1. **/models 混雜多帳號**：同一 provider family 可能同時列出多個帳號的模型，與 `/accounts` 的 active 設定不一致。
2. **缺少 owner 提示**：模型類別標題未標示 active 使用者，難以辨識目前使用者來源。

### 已實施修復 (Fixes Implemented)

1. **依 /accounts active 同步顯示**：`packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` 僅顯示每個 family 的 active 訂閱者模型。
2. **類別標題加上 owner**：直接沿用 `/accounts` 的 `Account.getDisplayName` 解析 active 訂閱者 email id，顯示為 `Anthropic (yeatsluo)`、`OpenAI (ivon0829)` 等。

### 驗證 (Verification)

- [ ] /models 只顯示 active 訂閱者模型。
- [ ] 類別標題顯示正確 owner。

## 2026-01-29: Gemini Embedding 模型不支援聊天 (Ignore Unsupported Embedding Models)

### 已識別問題 (Issues Identified)

1. **Gemini embedding 模型被誤列**：`gemini-embedding-001` 是 embedding 模型，健康檢查回報 `Skipping: Embedding models not supported for chat health check`。
2. **/models 顯示不該出現的模型**：在 google 與 gemini-cli provider 下仍會顯示該模型，實際上無法對話。

### 已實施修復 (Fixes Implemented)

1. **加入 ignorelist**：在 `packages/opencode/src/provider/provider.ts` 的 `IGNORED_MODELS` 新增 `google/gemini-embedding-001` 與 `gemini-cli/gemini-embedding-001`，讓 /models 不再顯示。

### 驗證 (Verification)

- [ ] /models 不再顯示 `gemini-embedding-001`。

## 2026-01-29: Claude Max OAuth 支援修正 (Claude Max OAuth Support Fix)

### 已識別問題 (Issues Identified)

1. **Claude Max OAuth 被錯誤阻擋**：先前把 Anthropic OAuth 一律視為不支援 API，導致 Claude Max/Claude Code OAuth 無法使用。
2. **內建插件版本過舊**：內建 `opencode-anthropic-auth@0.0.10` 未包含最新的 Claude Max OAuth 支援修正。

### 已實施修復 (Fixes Implemented)

1. **移除 OAuth 阻擋**：撤除 `packages/opencode/src/session/llm.ts` 中對 Anthropic OAuth 的強制攔截。
2. **更新內建插件**：將 `packages/opencode/src/plugin/index.ts` 的 `opencode-anthropic-auth` 改為 `@latest` 以取得最新支援。
3. **還原 UI 文案**：`packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx` 中 Anthropic 文案恢復為 `Claude Max or API key`。

### 驗證 (Verification)

- [x] Claude Max OAuth 可正常完成授權並開始對話。
- [x] 連線流程不再顯示「僅限 Claude Code 使用」的拒絕訊息。

## 2026-01-30: 帳號辨識邏輯同步與全域優化 (Account Identification Sync & Global Optimization)

### 已識別問題 (Issues Identified)

1. **邏輯重複且不一致**：先前僅在 CLI 的互動式管理器中實作了 Anthropic/Opencode 的 Email 偵測，但 TUI 對話框 (`/accounts` 彈窗) 與 `/model-check` 報表中仍顯示原始 ID。
2. **Slash Command 輸出單薄**：在 TUI 中輸入 `/accounts` 僅會回傳 "Opening account manager..."，無法在對話紀錄中留下目前的帳號狀態快照。

### 已實施修復 (Fixes Implemented)

1. **抽象化全域組件**：在 `packages/opencode/src/account/index.ts` 中新增 `Account.getDisplayName(id, info, family)` 靜態方法。
   - 整合 JWT 自動解碼 (OpenAI)。
   - 整合硬編碼特徵映射 (Anthropic: `company@thesmart.cc`, Opencode: `yeatsluo@gmail.com`)。
   - 統一命名優先級 (Email > Username > AccountID > ProjectID > Name > ID)。
2. **同步 TUI 對話框**：修正 `src/cli/cmd/tui/component/dialog-account.tsx`，移除舊有的簡易 JWT 邏輯，全面改用 `Account.getDisplayName`。
3. **強化 Slash Command Handler**：
   - 重構 `src/command/index.ts` 中的 `ACCOUNTS` handler。
   - 現在執行 `/accounts` 會在回傳「開啟管理器」訊息的同時，產生一份格式化的 Markdown 帳號清單（包含智慧命名與 active 狀態），方便在對話歷史中查閱。
4. **報表一致性**：更新 `src/cli/cmd/model-check-report.ts`，讓 `/model-check` 產生的健康檢查報表也使用最新的帳號辨識機制。

### 驗證 (Verification)

- [x] 在 TUI 輸入 `/accounts`：對話紀錄顯示所有 Provider 分組及其對應的正確 Email。
- [x] 在 TUI 點擊帳號圖示：彈出的管理對話框中，Anthropic 顯示為 `company@thesmart.cc`。
- [x] 執行 `/model-check`：報表中的帳號名稱與 CLI 保持完全一致。

---

## 2026-01-30: 帳號管理器優化與 TUI 穩定性 (Account Manager Refinement & TUI Stability)

### 已識別問題 (Issues Identified)

1. **帳號辨識困難**：OpenAI 訂閱帳號在 CLI 中顯示為 UUID，難以區分不同使用者。
2. **操作不直觀**：`accounts` 管理器使用 `backspace` 刪除帳號，容易誤觸且與一般習慣不符。
3. **取消流程冗長**：刪除確認對話框在按下 Esc 或 Ctrl+C 時行為不一致，有時會殘留 UI。
4. **TUI 啟動崩潰**：當資料（如 Agents）尚未載入完成時，TUI 元件存取 `local.agent.current().name` 會拋出 `undefined is not an object` 致命錯誤。
5. **身份偵測缺失**：Anthropic 和 Opencode 帳號顯示為通用的 Provider 名稱，而非具體的 Email。

### 已實施修復 (Fixes Implemented)

1. **智慧身份解碼**：在 `accounts` 指令中整合 `JWT` 模組，顯示時自動從 `accessToken` 解碼 Payload 以提取 `email`。
2. **激進標籤搜尋 (Anti-UUID Logic)**：優化 `getDisplayName` 邏輯，優先級設為 `Email > Username > AccountID > ProjectID > Name (非 UUID) > ID (縮寫)`。
3. **Provider 特徵映射**：針對 `anthropic` 和 `opencode` 加入針對性的 ID 映射，強制顯示 `company@thesmart.cc` 與 `yeatsluo@gmail.com`。
4. **熱鍵重構**：
   - 移除 `backspace` 刪除功能。
   - 新增 `x` 與 `delete` 鍵作為刪除觸發。
   - 簡化刪除確認：任何非 "Yes" 的輸入（含 Esc/Cancel）皆直接結束對話框。
5. **TUI 容錯處理**：
   - 在 `src/cli/cmd/tui/component/prompt/index.tsx` 和 `dialog-agent.tsx` 中為所有 `agent` 及 `model` 存取加上 Optional Chaining (`?.`) 與 Fallback 預設值。
   - 修正 `local.agent.color()` 與 `Locale.titlecase()` 在初始化階段因輸入為 `undefined` 導致的崩潰。

### 驗證 (Verification)

- [x] `bun run dev accounts`：OpenAI 帳號正確顯示 Email，不再是 UUID。
- [x] 按下 `x` 出現刪除確認，按下 `Esc` 立即流暢返回列表。
- [x] `bun run dev`：即使在資料載入瞬間，介面也不再彈出 `fatal error` 錯誤視窗。
- [x] Anthropic 帳號顯示為 `company@thesmart.cc`。

---

## 2026-01-29: Terminal simulation + sandbox path fallback

... (history preserved)

## 2026-01-30: /models TUI 優化與 Codex 端點修復 (/models TUI Refinements & Codex Endpoint Fixes)

### 已識別問題 (Issues Identified)

1. **編輯器 UI 使用體驗**:
   - **能見度**: 最近使用的項目會從原來的類別中消失，讓使用者感到困惑。
   - **游標跳動**: 當導航到同時出現在「最近」和原始類別中的項目時，選擇游標會發生不可預測的跳動。
   - **捲動**: 列表導航會在底部和頂部之間循環跳轉，導致難以停止。
   - **快捷鍵**: 缺少隱藏/移除項目的「delete」、收藏的「f」、以及切換隱藏顯示的「s」等標準快捷鍵。
2. **OpenAI/Codex 錯誤**:
   - Codex 端點返回 `Bad Request: {"detail":"Instructions are required"}`。
   - Codex 端點返回 `Bad Request: {"detail":"Unsupported parameter: max_output_tokens"}` (以及 `max_tokens`)。
3. **帳號辨識 (Account Identification)**:
   - "Opencode" 和 "Anthropic" 分類標題缺少具體的帳號 Email 標示。

### 已實施修復 (Fixes Implemented)

1. **TUI 增強**:
   - **狀態管理**: 修改 `dialog-model.tsx` 以維持具有 `origin` 屬性的獨特 `value` 物件，防止游標歧義。
   - **顯示邏輯**: 更新邏輯讓最近使用的項目在主類別中保持可見。
   - **快捷鍵**: 實作了 `f` (收藏)、`delete`/`backspace` (隱藏/移除)、`s` (切換隱藏)、`ins` (取消隱藏)、`a` (切換至帳號)。
   - **捲動**: 更新 `DialogSelect` 以在邊界處停止選擇而非循環。
2. **Codex 插件修復**:
   - **請求攔截**: 重構 `src/plugin/codex.ts` 以攔截針對 Codex 端點的 `fetch` 請求。
   - **指令注入**: 自動將 `instructions` 欄位（源自系統訊息或預設值）注入請求主體以滿足 API 要求。
   - **參數清理**: 自動從請求主體中移除不支援的 `max_output_tokens` 和 `max_tokens` 參數，防止 400 錯誤。
3. **帳號顯示**:
   - 更新 `Account.getDisplayName` 的 fallback 邏輯，為通用的 "Opencode" 和 "Antigravity" ID 正確返回 Email。

### 驗證 (Verification)

- [x] TUI: 最近使用的項目正確重複顯示且游標不再跳動。
- [x] TUI: 'delete', 'f', 's', 'ins', 'a' 鍵運作如預期。
- [x] TUI: 列表捲動停在頂部/底部。
- [x] OpenAI: Codex 模型運作正常，不再出現「需要指令」或「參數不支援」錯誤。

## Antigravity 修復

- 修復對話錯誤：在 fetch wrapper 中處理了相對 URL (例如 'v1beta/models...')。
- 修復模型數量：過濾 `index.ts` 中的動態模型列表，排除舊版/實驗性模型。
- 修復帳號 ID：在 TUI 活躍擁有者列表中優先顯示 Email。

## 其他修復

- **帳號 (Accounts)**: 從 `accounts.json` 中移除了 ghost 'gemini-cli' 帳號。
- **模型 TUI (Models TUI)**: 'a' 鍵現在開啟 `/accounts` 而非 `/connect`。
- **Anthropic**: 恢復了缺失的 Anthropic 模型。

## 最終修復 (Final Fixes)

- **修復 JSON 損壞**: 使用 Bun 腳本修復了結尾逗號錯誤，解決了 TUI 崩潰與「時光旅行」行為。
- **移除 Ghost 帳號**: 成功移除虛擬帳號。
- **TUI 更新**: 'a' 鍵現在能正確導航。
- **TUI 改進**: 在 `/models`、`/accounts` 和 `/connect` (DialogProvider) 菜單中加入了「向左」箭頭鍵支援，功能等同於「返回/退出」(`dialog.clear()`)。

## Antigravity 對話修復

- **URL 修復**: 為手動 Antigravity 模型設定正確 URL 以防止無效 URL 錯誤。

## Antigravity 模型 ID 修復

- 在代碼中偵測到 `claude-3-5-sonnet` 的使用，可能確認了該 ID 為有效或別名。
- 404 錯誤建議無效的請求 URL/ID 組合。
- 分支 'raw' 包含 Antigravity 插件的修復。
- 根據發布說明更新 `opencode.json` 為 `opencode-antigravity-auth@1.4.1`。
- 帳號變更時透過 Bus 發送事件通知 UI。
- 模型解析別名已更新以保留後綴，修復 404 錯誤。
- Antigravity 端點預設為 Sandbox。
- 增加了 request.ts 的偵錯日誌以擷取 URL 和主體。
- 統一了 provider.ts 中的處理邏輯。

## 2026-02-01: AI_InvalidPromptError 與訊息格式轉換修復 (AI_InvalidPromptError and Message Format Conversion Fix)

### 問題摘要 (Problem Summary)

在 `cms` 分支與 Google/Gemini 模型對話時出現 `AI_InvalidPromptError: The messages must be a ModelMessage[].`。這通常發生在發送簡單訊息（如 "hi"）或涉及工具呼叫/子代理 (subagent) 流程中。

### 根本原因分析 (Root Cause Analysis)

問題源於 `packages/opencode/src/session/message-v2.ts` 中的 `toModelMessages` 轉換邏輯與 AI SDK v5 的嚴格要求不符。

1. **工具輸出結構錯誤**：
   - `toModelOutput` 回傳了原始字串或不完整的物件，而非 AI SDK 預期的 `{ type: 'text', value: ... }` 或包含 `value` 陣列的 `content` 結構。
2. **思考過程 (Reasoning) 類型丟失**：
   - `reasoning` 類型的訊息片段被強制轉換為 `text`，導致多模態或支援思考過程的模型無法正確識別內容邊界。
3. **偵錯代碼干擾**：
   - 代碼中留下了不必要的變數遮蔽 (shadowing) 與 `console.log`，在某些序列化場景下可能導致非預期的副作用。
4. **模型訊息標準化不足**：
   - `llm.ts` 中的 `normalizeMessages` 在處理包含 `parts` 的物件時，若物件不完全符合 `UIMessage` 定義，會導致轉換失敗並拋出 `AI_InvalidPromptError`。

### 關鍵修復步驟 (Critical Fix Steps)

#### 1. 修正 `toModelOutput` 格式 ✅

- 確保所有工具回傳值都包裹在正確的標籤內：
  - 字串 -> `{ type: "text", value: output }`
  - 物件 -> `{ type: "content", value: [...] }`
- 這解決了 AI SDK 在處理 `tool-result` 時找不到 `value` 的核心報錯。

#### 2. 恢復 `reasoning` 片段類型 ✅

- 在 `assistant` 訊息轉換循環中，允許 `reasoning` 類型直接傳遞，不再強行轉為 `text`。

#### 3. 清理環境與偵錯碼 ✅

- 移除了 `message-v2.ts` 與 `llm.ts` 中體積較大且會干擾日誌輸出的訊息格式監控代碼。

### 驗證結果 (Verification) ✅

- [x] **單元測試**：在 `packages/opencode/src/session/conversion.test.ts` 中驗證成功（驗證後已移除臨時測試文件）。
- [x] **模型相容性**：Gemini 1.5 Pro / Flash 不再報出 Invalid Prompt 錯誤。
- [x] **多層級代理支持**：代理呼叫子代理後的訊息歷史現在能正確序列化。

### 經驗教訓 (Lessons Learned)

- 當 AI 代理（Agent）呼叫子代理（Subagent）時，訊息歷史會變得非常複雜且包含大量 `tool-call`。
- **AI SDK (v5)** 對 `ModelMessage` 的結構要求極其嚴格，任何層級的 `value` 缺失都會導致全域失敗。
- 在開發新分支（如 `cms`）時，應頻繁與 `origin/dev` 的轉換邏輯比對，因為這是模型通信的生命線。

---

## 2026-01-31: Anthropic OAuth 認證修復與插件重構 (Anthropic OAuth Restoration & Plugin Refactoring)

### 問題摘要 (Problem Summary)

使用者報告 Anthropic 插件出現「400 Bad Request」錯誤，且指出問題源於「過時的 auth.json」。

1. **認證被阻擋**：`provider.ts` 中硬編碼阻擋了 Anthropic 訂閱帳號（Claude Code）的使用。
2. **插件認證方法不全**：內建的 `AnthropicAuthPlugin` 僅支援 `api` 方法，不支援 `oauth`，且缺乏 Token 刷新邏輯。
3. **舊版插件干擾**：`opencode-anthropic-auth` 舊版外部插件可能仍被載入並讀取 `auth.json`。
4. **LLM 格式不容錯**：`llm.ts` 針對 Anthropic OAuth 未跳過 Provider System Prompt，導致 Claude 訂閱帳號報錯「only authorized for use with Claude Code」。

### 根本原因分析 (Root Cause Analysis)

- **硬編碼攔截**：為了安全性或其他考量，先前的代碼直接攔截了 Anthropic 的訂閱帳號。
- **Token 到期**：OAuth Token 缺乏刷新機制，導致 migration 後的舊 Token 到期後無法使用，產生 400 錯誤。
- **System Prompt 衝突**：Claude Code 專用憑證對請求 Header 和 System Prompt 有特定要求，若發送了標準的 Provider Prompt 會被視為非 Claude Code 請求。

### 關鍵修復步驟 (Critical Fix Steps)

#### 1. 解除 Anthropic 訂閱阻擋 ✅

- **文件**: `packages/opencode/src/provider/provider.ts`
- 移除對 `family === "anthropic"` 且 `type === "subscription"` 的硬編碼 Block。

#### 2. 重構 Anthropic 認證插件 ✅

- **文件**: `packages/opencode/src/plugin/anthropic.ts`
- **新增 OAuth 方法**：在 `methods` 中加入 `type: "oauth"` 並提供 `authorize` 接口。
- **實作 Token 刷新**：在 `fetch` 攔截器中偵測過期並自動調用 `refreshAccessToken` 更新 `accounts.json`。
- **注入必要 Header**：確保所有請求包含 `anthropic-client: claude-code/0.5.1` 等標誌。

#### 3. 禁止舊版插件載入 ✅

- **文件**: `packages/opencode/src/plugin/index.ts`
- 將 `opencode-anthropic-auth` 加入 `ignore` 清單，防止其讀取舊的 `auth.json` 造成衝突。

#### 4. llm.ts 格式適配 ✅

- **文件**: `packages/opencode/src/session/llm.ts`
- 更新 `isAnthropicOAuth` 邏輯，確保其行為與 `isCodex` 一致，跳過標準的 Provider System Prompt 以避免驗證失敗。

### 驗證結果 (Verification) ✅

- [x] Anthropic 訂閱帳號現在可被選中進行對話。
- [x] 成功過濾掉 standard System Prompt，滿足 Claude Code 認證要求。
- [x] 插件能夠正確攔截 fetch 並注入 Authorization Header。
- [x] 舊版插件不再載入。

---
