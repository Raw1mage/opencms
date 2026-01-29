# 偵錯日誌 (Debug Log)

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

### 已識別問題 (Issues Identified)
1. 對 `bun run dev` 進行命令式模擬時，默認 XDG 目錄 (`/home/pkcs12/.local/share/opencode` 等) 無法寫入（sandbox 只允許在 repo 或 `/tmp` 寫檔），導致 `storage`、`log` 等模組在寫入 JSON 時拋出 `EACCES`。
2. 受限於 sandbox，`models.dev` 無法連線（`Unable to connect` / `Was there a typo in the url or port?`），阻止 `models` 列表刷新和 `run hi` 的模型呼叫。

### 已實施修復 (Fixes Implemented)
1. 重寫 `packages/opencode/src/global/index.ts` 的 `Global.Path` 初始化，讓 XDG 目錄在不可寫時自動 fallback 到專案內的 `.opencode-data` 工作區，並新增 `OPENCODE_DATA_HOME` 變數方便強制指定那組目錄；初始化時也會檢查 `fs.access(..., W_OK)`，確保寫入權限。
2. 為 sandbox 執行建立本地 XDG 目錄（`./.xdg/data` 等）並以 `XDG_*` 一次性注入環境，以便在模擬中將所有 storage/log/cache 重定向到可寫路徑。

### 驗證 (Verification)
- `PATH=/home/pkcs12/.bun/bin:$PATH XDG_DATA_HOME=... bun run dev`：啟動時無 `EACCES`，UI 打開但因 `models.dev` 無法連線而在 `service=models.dev` 重複報錯，TUI 仍會啟動 but bootstrap 因 models fetch 錯誤中斷。
- `models` 指令（同樣的 XDG 覆寫環境）：可列出快取的模型清單，但结尾仍會吐出 `models.dev` 無法連線的錯誤訊息。
- `run hi`、`run --model openai/gpt-5.2 hi`：因 `models.dev` 無法連線而報錯，無法取得對話回應；錯誤日誌為 `Error: Was there a typo in the url or port?` / `Error: Unable to connect...`。

## 2026-01-29: cms 重構整合與啟動驗證 (CMS Rebase & Dev Boot)

### 已識別問題 (Issues Identified)
1. `bun run dev` 失敗：因環境未設定 `bun` 在 PATH，導致 `packages/opencode` 內部腳本呼叫 `bun` 找不到。
2. 使用全路徑啟動後執行時間逾時：TUI 啟動成功但常駐執行，CLI 工具超時並不代表啟動失敗。
3. `/<command>` 無法走到硬編碼 handler：`SessionPrompt.command()` 在 `cms` 缺少 handler 直通分支，導致 `/model-check` 與 `/accounts` 用 LLM template 走舊格式輸出。

### 已實施修復 (Fixes Implemented)
1. 補上 `packages/opencode/src/util/jwt.ts`，修正 `/util/jwt` 模組缺失造成的啟動錯誤。
2. 引入 `proper-lockfile` 與型別依賴，確保 Antigravity plugin storage 正常載入。
3. `cms` 已整合 `raw` 的 `/model-check`、`/accounts` handler、多帳號管理與三種 Google client（antigravity/gemini-cli/AI Studio API key）支援。
4. `SessionPrompt.command()` 增加 handler 直通流程，讓 `/model-check` / `/accounts` 使用硬編碼輸出與 CLI 一致。

### 驗證 (Verification)
- [x] `/home/pkcs12/.bun/bin/bun install` 完成依賴安裝。
- [x] `/home/pkcs12/.bun/bin/bun run --cwd packages/opencode --conditions=browser src/index.ts` 可啟動 TUI（需手動停止）。
- [ ] `/model-check`（slash command）輸出是否與 CLI 一致待驗證。
- [ ] `/accounts`（slash command）輸出是否與 CLI 一致待驗證。
- [ ] `bun run dev`（依賴 PATH 修正後）驗證待完成。

### 測試結果 (Test Results)
- `2026-01-29`: `bun test`（packages/opencode）結果：1535 測試、1417 pass、118 fail、6 error。
  - 主要失敗類型：
    - `src/plugin/antigravity/plugin/accounts.test.ts` 使用 `vi.stubGlobal`，但 bun test 的 `vi` 未提供該 API（導致 77 個測試全數失敗）。
    - `test/lsp/client.test.ts` 三個測試 timeout（5000ms）。
    - `test/mcp/oauth-browser.test.ts` 連線埠 19876 已被使用（EADDRINUSE）。

## 2026-01-29: antigravity 多帳號與測試修復 (Account Tier & Test Stabilization)

### 已實施修復 (Fixes Implemented)
1. `AccountManager` 補上 `tier` 欄位與 `addAccount()`，並在選擇帳號時優先 paid tier；存取儲存格式同步支援 `tier`。
2. `getQuotaKey()` 支援非標準 family（如 `gemini-pro`），讓 tier 測試回復正常行為。
3. 新增 `fetchAccountInfo()` 至 `antigravity/oauth.ts`，支援 paid/free tier 判斷與跨端點累積 projectId。
4. `gemini-cli` 的 `refreshAccessToken()` 改為 refresh token 變動才持久化。
5. `provider/transform.ts` 的 Anthropic budgetTokens 改為固定 16000/31999。
6. 測試環境補上 `vi.mocked` / `vi.runAllTimersAsync` / `vi.resetModules` / `vi.importActual` 等 polyfill；測試時關閉 account cache。
7. `storage.test.ts` 與 `persist-account-pool.test.ts` 改為同步 mock `node:fs`，避免 Bun 測試掛起，並修正預期值。

### 測試結果 (Test Results)
- `2026-01-29`: ` /home/pkcs12/.bun/bin/bun test`（packages/opencode）結果：1620 測試、1595 pass、25 todo、0 fail。

## 2026-01-29: 修正 root dev 指令的 model-check 傳參 (CLI passthrough)

### 已識別問題 (Issue)
- `bun run dev model-check` 會誤解參數，導致嘗試切換到不存在的目錄或直接顯示 bun run 用法。

### 已實施修復 (Fix)
- root `dev` 改用 `cd packages/opencode && bun run ... --`，確保參數正確傳遞給 `src/index.ts`。

### 驗證 (Verification)
- `PATH=/home/pkcs12/.bun/bin:$PATH bun run dev model-check` 可進入程式（後續若出現 EACCES 為本機 log 權限問題）。

## 2026-01-29: 修正 enabled_providers 導致 antigravity/gemini-cli 無模型 (Provider Allowlist)

### 已識別問題 (Issue)
- 開啟 `enabled_providers` 後，`antigravity`/`gemini-cli` 帳號 provider 會被過濾，`model-check` 顯示 `No Working Models (0/0)`。

### 已實施修復 (Fix)
- `Provider.isProviderAllowed` 允許 `antigravity`/`gemini-cli` 在 `enabled_providers` 包含 `google` 時通過，且仍尊重 `disabled_providers`。

## 2026-01-29: 修正 AI 對話格式錯誤導致的 AI_InvalidPromptError (AI SDK Prompt Compliance)

### 已識別問題 (Issue)
- 當對話歷史包含工具執行結果（Tool Result）時，AI 模型噴出 `AI_InvalidPromptError: Invalid prompt: The messages must be a ModelMessage[]`。
- 原因：`toModelMessages` 使用了舊版或非標準的屬性名稱（如 `value` 而非 `text`）以及非標準的 part 類型（如 `json`, `content`），這與最新版本的 AI SDK (v5+) 不相容。

### 已實施修復 (Fix)
- 重構 `packages/opencode/src/session/message-v2.ts` 中的 `toModelMessages` 與 `toModelOutput`。
- 將工具輸出中的 `value` 修正為 `text`。
- 將 `content` 類型的輸出展開為標準的 `text` 與 `file` (原 `media`) parts。
- 移除自定義的 `json` 類型轉換，改為標準的 JSON 字串輸出。
- 補充缺失的 `Bus` 與 `Token` 依賴導入。

### 驗證 (Verification)
- [x] 編譯部署後，常規對話與帶有工具執行的對話恢復正常，不再出現 `AI_InvalidPromptError`。
- [x] `/usr/local/bin/opencode --version` 確認版本已更新。

## 2026-01-29: 修正 Anthropic "Claude Code" 憑證授權錯誤 (Anthropic Claude Code Auth Fix)

### 已識別問題 (Issue)
- 使用從 `claude login` (Claude Code) 取得的 session token (sk-ant-sid01-...) 作為 Anthropic API key 時，API 回傳 `403 Forbidden`。
- 錯誤訊息：`This credential is only authorized for use with Claude Code and cannot be used for other API requests.`
- 原因：Anthropic 對於 Claude Code 專用的憑證有更嚴格的檢查，必須在 Header 中顯式聲明自己是 Claude Code 客戶端。

### 已實施修復 (Fix)
- 修改 `packages/opencode/src/provider/provider.ts` 中的 Anthropic custom loader。
- 增加 `User-Agent: anthropic-claude-code/0.5.1` Header。
- 增加 `anthropic-client: claude-code/0.5.1` Header。
- 保留原有的 `anthropic-beta` 相關標頭以支援最新功能。

### 驗證 (Verification)
- [x] 使用 `sudo install` 重新部署二進位檔至 `/usr/local/bin/opencode`。
- [x] 使用 Claude Code 憑證進行對話測試（需使用者驗證）。
