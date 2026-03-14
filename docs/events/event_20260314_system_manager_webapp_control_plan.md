# Event: system-manager webapp control plan

Date: 2026-03-14
Status: Completed
Branch: cms
Workspace: /home/pkcs12/projects/opencode

## 需求

- 讓 system-manager 在 webapp 對話中不只可切 session，還能進一步：
  - rename session
  - 切目前 session 的 provider / account / model（session-local execution）
  - 切全域 active account / model preference（global control-plane）
- 明確區分 session-local 與 global 語意，避免同名歧義。
- 改用正式 server/API route，不再直接改 storage/config/state 檔案作為主要控制方式。

## 範圍 (IN / OUT)

### IN

- `packages/mcp/system-manager/src/index.ts`
- `manage_session.rename`
- `manage_session.set_execution`
- `switch_account`
- `switch_model`
- 對應 server route / API 契約對齊
- 測試與 event 記錄

### OUT

- 新增 fallback 機制
- session list/search/fork 其他功能重構
- Web UI 元件改版

## 任務清單

- [x] 確認 system-manager 與 server route 的當前契約
- [x] 實作 `manage_session.rename` 走 `session.update`
- [x] 實作 `manage_session.set_execution` 作為 session-local execution 切換
- [x] 實作 `switch_account` / `switch_model` 改走正式 API 並維持 global-only 語意
- [x] 補最小測試與驗證
- [x] 更新 event 與 architecture sync

## Debug Checkpoints

### Baseline

- `manage_session.rename` 原先直接改 `storage/session/<id>/info.json`。
- `switch_account` 原先直接改 `accounts.json`。
- `switch_model` 原先直接改 `model.json` recent state。
- server 其實已存在正式 API：
  - `PATCH /session/:sessionID` (`session.update`)
  - `POST /account/:family/active` (`account.setActive`)
  - `GET/PATCH /model/preferences`

### Execution

- `manage_session` 新增 `set_execution` operation，作為 session-local execution 切換入口。
- `manage_session.rename` 改為走 `session.update({ title })`。
- `manage_session.set_execution` 改為走 `session.update({ execution })`。
- `switch_account` 改為走 `account.setActive` route。
- `switch_model` 改為走 `model.preferences` route，維持 global-only 語意。
- `manage_session` tool schema 已同步納入 `set_execution` / `providerId` / `accountId` / `modelID` 參數。

### Validation

- `bun test "/home/pkcs12/projects/opencode/packages/mcp/system-manager/src/system-manager-http.test.ts" "/home/pkcs12/projects/opencode/packages/mcp/system-manager/src/system-manager-session.test.ts"`
- 結果：9 pass / 0 fail ✅
- Additional regression:
  - `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/tool/registry.test.ts"`
- 結果：21 pass / 0 fail ✅
- 驗證重點：
  - `manage_session.rename` 走 `PATCH /session/:sessionID`
  - `manage_session.set_execution` 走 `PATCH /session/:sessionID` with `execution`
  - `switch_account` 走 `POST /account/:family/active`
  - `switch_model` 走 `GET/PATCH /model/preferences`
  - planner/build phase 不再依賴 system-reminder control prompt

## Interim Notes

- 目前 `switch_model` 透過 `model.preferences.favorite` 把目標 model 提到最前；這是現有正式 API 內可用、最接近「全域模型偏好」的可寫入口。
- 若後續需要真正的「recent/default current model」專用 route，應另開 server contract，而不是回退到直接寫 `model.json`。
- 本次並行收斂 planner/build phase 控制面：plan mode agent 若要傳達資訊給 build mode agent，應只透過 planner artifacts 與 `plan_exit` handoff metadata，不再依賴 system-reminder prompt text。
- 後續路線收斂：與其新增 resolver agent/tool，不如優先強化 MCP surface/description/enablement，讓 agent 在既有 tool selection 流程中更容易理解 session-based semantics、歧義時先用 `question`、且不得 silent fallback。

## Architecture Sync

- Architecture Sync: Updated (shared planner/runtime section)
- 比對依據：本次 system-manager 改良依賴的 session-local/global 邊界，已與 `docs/ARCHITECTURE.md` 既有 `Session execution identity contract` / `Control-plane vs session-local selection boundary` 保持一致；另同步補上 planner/build 正式 handoff 契約，避免後續再用 prompt text 充當控制面。
