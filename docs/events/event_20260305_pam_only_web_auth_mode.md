# Event: PAM-only Web Auth Mode (remove htpasswd defaulting)

Date: 2026-03-05
Status: Done

## 1. 需求

- 將 Web runtime 預設行為調整為 PAM-only（Linux）。
- 移除 `webctl.sh` 對 `OPENCODE_SERVER_HTPASSWD` 的隱式預設注入，避免 htpasswd 檔案存在時覆蓋 PAM 意圖。
- 保留相容路徑（htpasswd / legacy password）但改為顯式選擇，不再是預設。

## 2. 範圍

### IN

- `packages/opencode/src/server/web-auth-credentials.ts`
- `packages/opencode/src/flag/flag.ts`
- `packages/opencode/src/cli/cmd/web.ts`
- `packages/opencode/src/cli/cmd/serve.ts`
- `webctl.sh`
- `templates/system/opencode.cfg`
- `scripts/tools/start-opencode-web.sh`
- `docs/ARCHITECTURE.md`

### OUT

- 不修改 PAM 底層驗證機制（`su` + PTY 的流程）。
- 不改動非 Linux 平台的既有策略（除必要顯示與 mode 容錯外）。
- 不做 merge/cherry-pick 型整合。

## 3. 任務清單

- [x] 新增 `OPENCODE_AUTH_MODE` 設定面（pam/htpasswd/legacy/auto）。
- [x] 在 Web auth 驗證流程中根據 mode 決定可用 credential source。
- [x] 調整 web/serve 啟動提示文字，顯示實際 auth mode。
- [x] 調整 `webctl.sh`，移除 htpasswd 預設注入並改為 mode-aware 顯示。
- [x] 調整模板 cfg 為 `OPENCODE_AUTH_MODE="pam"` 預設。
- [x] 更新 Architecture 文檔 auth baseline。
- [x] 執行 typecheck 驗證並記錄結果。

## 4. Debug Checkpoints

### Baseline（修改前）

- 症狀：即使使用者要 PAM-only，`webctl.sh` 仍會預設注入 `OPENCODE_SERVER_HTPASSWD=${HOME}/.config/opencode/.htpasswd`。
- 影響：若該檔存在，`web-auth-credentials` 會先走 htpasswd 驗證，與 PAM-only 目標不一致。
- 重現依據：
  - `webctl.sh` 中 `HTPASSWD_PATH` 的預設與 `nohup env` 注入。
  - `web-auth-credentials.ts` 驗證優先序：htpasswd -> legacy env -> PAM(Linux)。

### Execution（修正中）

- 已完成：
  - `Flag` 新增 `OPENCODE_AUTH_MODE`。
  - `web-auth-credentials.ts` 依 mode 分流：
    - `pam`: 只走 PAM（Linux）
    - `htpasswd`: 只走檔案
    - `legacy`: 只走 env 密碼
    - `auto`: 保留舊優先序（htpasswd -> legacy -> PAM）
  - `web.ts` / `serve.ts` 啟動提示改為 mode-aware。
  - `webctl.sh` 改為預設 `OPENCODE_AUTH_MODE=pam`，移除 htpasswd 隱式預設注入。
  - `scripts/tools/start-opencode-web.sh` 改為 PAM 預設。
  - `templates/system/opencode.cfg` 改為 PAM 預設，htpasswd/legacy 改為註解備選。
  - PAM 登入穩定性修補：`verifyPam` 先嘗試 `authenticate-pam`，失敗時再 fallback 到既有 `su` PTY 驗證。
  - PAM mode 的 `usernameHint` 改為 `SUDO_USER -> LOGNAME -> USER` 優先序，避免服務帳號提示誤導登入。
  - 嘗試直接修改 `/etc/opencode/opencode.cfg` 時因權限不足失敗（EACCES），改由使用者在主機 shell 套用。

### Validation（修正後）

- 驗證指令：
  - `bun run typecheck`（workdir: `packages/opencode`）
- 結果：Pass（`tsgo --noEmit` 無錯誤）
- 已知噪音豁免：本次未觸及 `packages/opencode/src/plugin/antigravity/plugin/storage.legacy.ts`，不受該 typecheck 噪音影響。
- Architecture Sync: Verified (Doc updated)
  - 依據：`docs/ARCHITECTURE.md` 第 19 節已同步為 mode-based auth baseline（含 `OPENCODE_AUTH_MODE` 與 PAM-first 描述）。
