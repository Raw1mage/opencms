# Event: legacy runtime data cleanup

Date: 2026-03-08
Status: Done

## 需求

- 清理 repo 工作樹中的 legacy runtime data，避免把使用者 home/XDG 下的敏感資料鏡像帶進 repo。
- 確認 `accounts.json` / `ignored-models.json` 的 canonical runtime 位置仍是 XDG user-home，而不是 `<repo>/config/data/`。
- 修正文件與 ignore 規則，避免未來再次把 runtime secrets 同步回 repo。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/config/data/`
- `/home/pkcs12/projects/opencode/.gitignore`
- `/home/pkcs12/projects/opencode/docs/DOCKER.md`
- `/home/pkcs12/projects/opencode/specs/system-prompt/hooks.md`
- 必要的 event/validation 記錄

### OUT

- 本輪不處理 git history rewrite
- 本輪不處理 user-home runtime 檔案本身的內容輪替

## 任務清單

- [x] 確認 repo 內 legacy runtime data 的實際使用情況
- [x] 移除 repo 內不該存在的 legacy runtime data 鏡像
- [x] 補強 ignore 與文件，避免再次回流

## Debug Checkpoints

### Baseline

- 使用者指出 repo 中不應存在 `accounts.json`，應仰賴 user-home/XDG runtime 儲存。
- 靜態搜尋確認 runtime `Account` 模組實際讀寫 `~/.config/opencode/accounts.json`，repo `config/data/accounts.json` 並非正常 runtime SSOT。
- 現況 `config/data/accounts.json` 含真實機密，屬高風險 legacy data 副本。

### Execution

- 確認 runtime SSOT：
  - `packages/opencode/src/account/index.ts` 實際讀寫 `Global.Path.user/accounts.json`，而 `Global.Path.user === ~/.config/opencode/`。
  - `config/data/accounts.json` 只屬 legacy mirror / 工作樹殘留，並非正常 runtime 路徑。
- 清理 repo 內 legacy runtime data：
  - 刪除 `/home/pkcs12/projects/opencode/config/data/accounts.json`
  - 刪除 `/home/pkcs12/projects/opencode/config/data/ignored-models.json`
- 補強 ignore：
  - `.gitignore` 從單檔 ignore `config/data/accounts.json` 擴大為 `/config/data/*.json`，避免 `mcp-auth.json`、`ignored-models.json`、未來其他 runtime mirror 再回流。
- 修正文檔：
  - `docs/DOCKER.md` 不再把 `accounts.json` / `mcp-auth.json` 描述成應同步進 repo `./config/data/` 的內容。
  - `specs/system-prompt/hooks.md` 將 `accounts.json` 執行期位置修正為 `~/.config/opencode/`。

### Validation

- `git check-ignore -v /home/pkcs12/projects/opencode/config/data/accounts.json` ✅
- `git status --short` ✅（legacy runtime data 已從工作樹移除/標記刪除）
- `eslint` 對 `.gitignore` / `.md` 僅回報「no matching configuration」warning，無語法性錯誤；本 repo 不將此視為 blocker。✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅清理工作樹 legacy runtime data 與修正文檔路徑描述，未改變 repo architecture 分層與 runtime 邊界。
