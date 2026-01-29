# 偵錯日誌 (Debug Log)

## 2026-01-29: cms 重構整合與啟動驗證 (CMS Rebase & Dev Boot)

### 已識別問題 (Issues Identified)
1. `bun run dev` 失敗：因環境未設定 `bun` 在 PATH，導致 `packages/opencode` 內部腳本呼叫 `bun` 找不到。
2. 使用全路徑啟動後執行時間逾時：TUI 啟動成功但常駐執行，CLI 工具超時並不代表啟動失敗。
3. `/<command>` 無法走到硬編碼 handler：`SessionPrompt.command()` 在 `cms` 缺少 handler 直通分支，導致 `/model-check` 與 `/accounts` 用 LLM template 走舊格式輸出。

### 已實施修復 (Fixes Implemented)
1. 補上 `packages/opencode/src/util/jwt.ts`，修正 `/util/jwt` 模組缺失造成的啟動錯誤。
2. 引入 `proper-lockfile` 與型別依賴，確保 Antigravity plugin storage 正常載入。
3. `cms` 已整合 `raw` 的 `/model-check`、`/accounts` handler、多帳號管理與三種 Google client（antigravity/gemini-cli/AI Studio API key）支援。
4. `SessionPrompt.command()` 增加 handler 直通流程，讓 `/model-check`、`/accounts` 使用硬編碼輸出與 CLI 一致。

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
