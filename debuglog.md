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
