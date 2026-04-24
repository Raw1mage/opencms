# Errors: codex-fingerprint-alignment

## Error Catalogue

本 spec 是 header / body 組裝調整，不新增 runtime 錯誤碼。以下列出**可能在實作期間或驗收期間遭遇的失敗模式**，以及判定 / 恢復策略。

### E-FP-001 — Upstream submodule fetch 失敗

- **Trigger**：`git -C refs/codex fetch --tags` 失敗（網路、授權、GitHub 狀態）。
- **User-visible**：Phase 3 卡住。
- **Recovery**：
  1. 檢查網路與 `refs/codex` remote URL；重試 fetch。
  2. 若持續失敗，stop Phase 3，保留 Phase 1 變更在 beta，等網路恢復再繼續。
- **Responsible layer**：執行環境（非 plugin code）。

### E-FP-002 — rust-v0.125.0-alpha.1 tag 不存在

- **Trigger**：`git -C refs/codex rev-parse rust-v0.125.0-alpha.1` 找不到 tag（upstream 可能改 tag 命名或撤回）。
- **User-visible**：Phase 3 stop。
- **Recovery**：
  1. 列出最新 tag 清單：`git -C refs/codex tag --sort=-creatordate | head`。
  2. 回報使用者重新選擇鎖定版本（觸發 `revise` mode 更新 DD-3）。
- **Responsible layer**：執行計畫 / DD-3。

### E-FP-003 — Upstream 於 0.122.0..0.125.0-alpha.1 間新增必要 header / body

- **Trigger**：Phase 3 diff 盤點發現 upstream 新增非 conditional 的欄位。
- **User-visible**：fingerprint 可能仍 > 1%，若忽略。
- **Recovery**：
  1. 紀錄新欄位到 `docs/events/event_<YYYYMMDD>_codex_upstream_diff.md`。
  2. Stop 當前 phase，回報使用者。
  3. 依情況升級為 `revise` mode 擴充本 spec 的 Requirement；或另開 follow-up spec。
- **Responsible layer**：plan-builder lifecycle（mode classification）。

### E-FP-004 — buildCodexUserAgent() 在 WS 路徑取不到

- **Trigger**：Phase 1 inline 補 UA 時，`transport-ws.ts` 無法直接呼叫 `buildCodexUserAgent()`（package 邊界、循環依賴）。
- **User-visible**：實作卡住。
- **Recovery**：
  1. 由 `createCodex()` factory 把 `userAgent` 字串透過 options 傳入（目前 HTTP 路徑已是這條路），在 WS 路徑讀 `this.options.userAgent`。
  2. 若 options 也取不到（例如 getModel 階段沒填）→ 修 `codex-auth.ts:295` 確認永遠填值。
- **Responsible layer**：packages/opencode-codex-provider + packages/opencode/src/plugin/codex-auth.ts。

### E-FP-005 — Unit test 回歸（HTTP 現有 header 集合）

- **Trigger**：Phase 2 統一 buildHeaders 後，`headers.test.ts` 或 `provider.test.ts` 失敗。
- **User-visible**：CI red。
- **Recovery**：
  1. 對照 diff 找出被改掉的輸出欄位。
  2. 若測試斷言過嚴（例如綁死 key 順序），放寬斷言。
  3. 若真的是輸出改了 → 回退到 Phase 2 的最小變動，先保 HTTP path 行為等價。
- **Responsible layer**：packages/opencode-codex-provider。

### E-FP-006 — Beta soak 後第三方判定比例仍 > 0%（零容忍）

- **Trigger**：Phase 1+3 fetch-back 前驗收未達標。驗收門檻 = 100% first-party，任何殘留都算未達標。
- **User-visible**：finalize 延後；繼續 Phase 2+4。
- **Recovery**：
  1. 在 beta 抓 daemon log 實際發送的 header 集合，比對 `data-schema.json`。
  2. 檢查是否漏 header（session_id / x-codex-window-id）或格式不對（UA 版本）。
  3. 若 Phase 1+3 header 皆對齊仍 > 0% → **先完成 Phase 2+4**（統一 buildHeaders + x-client-request-id + Accept），二次 soak。
  4. Phase 1+3+2+4 全做完仍 > 0% → 另開 follow-up spec 處理 TLS/JA3 / Cloudflare cookie 層。
- **Responsible layer**：執行計畫 / acceptance。

### E-FP-007 — XDG 備份缺失

- **Trigger**：跑 `bun test` / 重啟 daemon 時發現 `~/.config/opencode.bak-*-codex-fingerprint/accounts.json` 不存在（依 AGENTS.md XDG 新規則）。
- **User-visible**：若測試寫 XDG → 可能抹掉真實 accounts（前例：2026-04-18 codex-rotation-hotfix）。
- **Recovery**：
  1. **立即 stop**。
  2. 執行白名單備份（見 tasks.md §1.1 的 script）。
  3. 回到 Execution-Ready Checklist 第一項重走。
- **Responsible layer**：AGENTS.md（XDG backup policy）。

### E-FP-008 — Daemon lifecycle 違規

- **Trigger**：實作過程試圖 `kill` / `spawn` daemon、直接 `bun ... serve`、`systemctl restart opencode-gateway`。
- **User-visible**：Bash tool 拋 `FORBIDDEN_DAEMON_SPAWN`，或使用者被迫重新登入。
- **Recovery**：
  1. 取消該指令。
  2. 改呼叫 `system-manager:restart_self` MCP tool。
  3. 若因 rebuild 失敗，讀 gateway log，修正後再呼叫 `restart_self`。
- **Responsible layer**：AGENTS.md（Daemon Lifecycle Authority）。

### E-FP-009 — CODEX_CLI_VERSION 取值判斷錯

- **Trigger**：Phase 3 更新常數時，upstream `Cargo.toml workspace.package.version` 仍是 `0.0.0`（monorepo 常態），若誤填進 CODEX_CLI_VERSION 會讓 UA 變成 `codex_cli_rs/0.0.0 (...)` — 會被 OpenAI 查表直接打回第三方。
- **User-visible**：Phase 3 完成後後台比例反而上升。
- **Recovery**：
  1. 依 DD-4 fallback：用 tag 的語意版本 `0.125.0-alpha.1`。
  2. 修正後重跑 unit test，確認 UA 字串正確。
- **Responsible layer**：design.md DD-4。
