# 偵錯日誌 (Debug Log)

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
