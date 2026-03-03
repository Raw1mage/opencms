# Event: webapp runtime rearchitecture (post user-worker rollback)

Date: 2026-03-03
Status: In Progress

## 需求

1. repo 程式透過 install 後成為系統服務，安裝後 binary 不依賴 repo 內容。
2. 系統使用者可透過 PAM 登入工作，各有自己的 userhome/runtime/session。
3. 開發期間建立完整 log 機制，利於除錯。

## 範圍 (IN/OUT)

### IN

- Phase 0 止血：降低 user-worker cutover 對 webapp 穩定性的影響。
- 調整 user-worker 路由旗標語義，改為 explicit experimental opt-in。
- 補齊 env 模板說明，避免誤開全路由切換。
- 規劃後續替代架構（gateway + per-user daemon）遷移路線。

### OUT

- 本輪不直接完成全新 multi-user daemon 架構實作。
- 本輪不移除所有 user-worker 代碼（先 freeze，避免大爆炸改動）。
- 本輪不處理 UI redesign。

## 任務清單

- [x] 建立重構事件檔，記錄新需求與邊界。
- [x] Phase 0：加上 `OPENCODE_USER_WORKER_EXPERIMENTAL=1` 才允許 route flags 生效。
- [x] 更新 `templates/system/opencode.env` 的旗標說明。
- [x] 跑 targeted typecheck/lint。
- [x] Phase 1 骨架：新增 per-user daemon manager（僅診斷，不切流）。
- [x] 新增 diagnostics API：`GET /experimental/user-daemon`。
- [x] Phase 1.5：新增 lazy-start hook stub（systemd --user start）與啟動健康欄位。
- [x] Phase 2（最小切流）：僅 `config` 路由導入 per-user daemon strict 模式。
- [x] Phase 2b（strict 擴展）：`account.list` 導入 per-user daemon strict 模式。
- [x] Phase 2c（strict 擴展）：`account` mutation（setActive/remove/toggle）導入 per-user daemon strict 模式。
- [x] 記錄 TUI 插曲：滑鼠無法聚焦 text input，需 `ctrl-x-b` 才恢復輸入。
- [x] Phase 2d（strict 擴展）：`session.list` 導入 per-user daemon strict 模式（解決 web/TUI 列表分岐）。
- [x] Phase 2e（strict 擴展）：`session.status` 與 `model.preferences` 導入 per-user daemon strict 模式。
- [x] Phase 2f（strict 擴展）：`session.top` 導入 per-user daemon strict 模式。
- [x] Phase 3（strict 擴展）：`session` 關鍵 mutation 導入 per-user daemon strict 模式。
- [x] Phase 4（strict 擴展）：`session` 其餘 mutation（message/part/prompt/command/shell/revert）導入 per-user daemon strict 模式。
- [x] Phase 5（strict 擴展）：`session` 其餘 read（get/children/todo/diff/messages/message.get）導入 per-user daemon strict 模式。
- [x] 插播修復：web prompt footer OpenAI quota 顯示與 TUI 對齊（週用量不再長時間 `--`）。
- [x] Phase 6（退場前置）：新增 user-worker decommission guard（需 `LEGACY_FORCE` 才可啟用）。
- [x] Phase 7a（退場清理）：移除 `config/account/model` routes 中的 user-worker 分支。
- [x] Phase 7b（退場清理）：移除 `session` routes 中全部 user-worker 分支。
- [x] Phase 8（退場清理）：移除 server runtime 對 `UserWorkerManager` 的依賴並刪除 manager 實作檔。
- [x] Phase 9（退場清理）：移除 user-worker CLI command 與 RPC schema 檔案。
- [x] Phase 10（Web UX 去重）：移除右側 File Tree 內與 Review 重複的「changes/all」分頁，只保留單一「All files」檢視。

## 架構決策（草案）

- 現況 user-worker 模式在「99% 單一使用者」場景下複雜度過高，且全路由開關易造成整體不穩。
- 短期策略：以 fail-safe 方式將 worker routing 退回 explicit opt-in。
- 中期策略：改為「gateway + 持久 per-user daemon（PAM + user home 原生 XDG）」；避免 per-request worker RPC。

## Phase 1 實作藍圖（下一步）

1. **Gateway / User Daemon 邊界**
   - Gateway: PAM 登入、cookie/session、轉發與審計。
   - User Daemon: 使用者自己的 XDG runtime/data/config；執行 session/config/account/model API。
2. **連線機制**
   - 優先 Unix domain socket: `/run/user/<uid>/opencode.sock`。
   - 不可用時 fallback localhost random port（僅本機 loopback）。
3. **生命週期**
   - 首次登入時 lazy-start `opencode-user@<uid>`。
   - 閒置回收（TTL）與健康檢查端點。
4. **觀測性**
   - 每請求附 `requestId`/`user`/`route`/`targetDaemon`。
   - gateway / daemon 分層 log 並可串連 correlation id。

## Debug Checkpoints

### Baseline

- 近 24 小時存在多個 user-worker cutover commit，且系統 env 開啟多個 `OPENCODE_USER_WORKER_ROUTE_*`。
- webapp 出現隨機錯誤（含瀏覽器崩潰碼 `STATUS_BREAKPOINT` 報告），推定與高風險切流路徑相關。

### Execution

- `UserWorkerManager.enabled()` 改為雙重門檻：
  - `OPENCODE_USER_WORKER_ENABLED=1`（或 skeleton）
  - `OPENCODE_USER_WORKER_EXPERIMENTAL=1`
- 全部 routing gate (`routeSessionMutationEnabled`, `routeConfigGetEnabled`, `routeAccountMutationEnabled` 等) 改為依賴 `enabled()`。
- `prewarmEnabled()` 改為依賴 `enabled()`，避免未進入 experimental 模式時仍嘗試 worker prewarm。
- `templates/system/opencode.env` 新增說明：route flags 僅在 `OPENCODE_USER_WORKER_EXPERIMENTAL=1` 下生效。
- 新增 startup 可觀測性：
  - `UserWorkerManager.logRuntimeModeOnce()` 於 app 啟動時輸出 routing 模式。
  - 若 route flags 已開但未設 experimental，會明確警告「flags ignored」。
  - 若 experimental 真正啟用，也會警告目前運行於實驗模式。
- Phase 1 最小骨架：
  - 新增 `server/user-daemon/manager.ts`，維護 per-user daemon socket 觀測快照（`/run/user/<uid>/opencode.sock`）。
  - 由 `LinuxUserExec.resolveLinuxUserUID()` 解析 uid，建立 `username -> uid -> socketPath` 映射。
  - 在 `createApp()` middleware 中以 `RequestUser.username()` 做 `UserDaemonManager.observe()`（僅觀測，不轉發流量）。
  - 新增 `GET /experimental/user-daemon` 供管理面診斷目前觀測到的 daemon 狀態。
  - 新增 env 模板旗標：`OPENCODE_PER_USER_DAEMON_EXPERIMENTAL=1`（預設關閉）。
- Phase 1.5（lazy-start + health fields）：
  - 當 socket 缺失時，`UserDaemonManager.observe()` 會在 cooldown 內最多觸發一次 lazy-start 嘗試。
  - lazy-start 改為由 gateway 直接執行：`sudo -n systemctl start opencode-user-daemon@<user>.service`（避免 user bus 依賴）。
  - `/experimental/user-daemon` 回傳新增欄位：`lastStartAttemptAt` / `startAttempts` / `lastStartError`。
  - 新增 env 模板控制：
    - `OPENCODE_PER_USER_DAEMON_LAZY_START=1`
    - `OPENCODE_PER_USER_DAEMON_SYSTEMD_UNIT=opencode-user-daemon@.service`
    - `OPENCODE_PER_USER_DAEMON_START_COOLDOWN_MS=30000`
    - `OPENCODE_PER_USER_DAEMON_PORT_BASE=41000`
    - `OPENCODE_PER_USER_DAEMON_PORT_SPAN=20000`
- Phase 2（config 單一路由試切）：
  - `UserDaemonManager.routeConfigEnabled()`：`OPENCODE_PER_USER_DAEMON_EXPERIMENTAL=1` 且 `OPENCODE_PER_USER_DAEMON_ROUTE_CONFIG=1` 才生效。
  - 新增 daemon RPC over unix socket（`/run/user/<uid>/opencode.sock`）HTTP call：
    - `GET /config`
    - `PATCH /config`
  - `ConfigRoutes` 改為 per-user daemon strict path；失敗直接回傳 503 + 錯誤碼，禁止 silent fallback。
  - 新增 env 模板旗標：`OPENCODE_PER_USER_DAEMON_ROUTE_CONFIG=1`。
- Phase 2b（account.list strict）：
  - `UserDaemonManager.routeAccountListEnabled()`：`OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_LIST=1` 時生效。
  - 新增 daemon call：`GET /account`。
  - `AccountRoutes` 的 `GET /account` 改為 daemon strict path；daemon 失敗或 payload 不合法直接回 503。
  - 新增 env 模板旗標：`OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_LIST=1`。
- Phase 2c（account mutation strict）：
  - 新增 daemon calls：
    - `POST /account/:family/active`
    - `DELETE /account/:family/:accountId`
    - `POST /account/antigravity/toggle`
  - `AccountRoutes` 對應 mutation 在 `OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_MUTATION=1` 時走 daemon strict path；失敗直接回 503。
  - 新增 env 模板旗標：`OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_MUTATION=1`。
- Phase 2d（session.list strict）：
  - 新增 `UserDaemonManager.routeSessionListEnabled()` + `callSessionList()`。
  - `SessionRoutes` 的 `GET /session` 在 `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_LIST=1` 時走 daemon strict path；失敗直接回 503。
  - 新增 env 模板旗標：`OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_LIST=1`。
- Phase 2e（session.status + model.preferences strict）：
  - 新增 `UserDaemonManager` 呼叫：
    - `callSessionStatus()` -> `GET /session/status`
    - `callModelPreferencesGet()` -> `GET /model/preferences`
    - `callModelPreferencesUpdate()` -> `PATCH /model/preferences`
  - `SessionRoutes` 的 `GET /session/status` 在 `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_STATUS=1` 時走 daemon strict path。
  - `ModelRoutes` 的 `GET/PATCH /model/preferences` 在 `OPENCODE_PER_USER_DAEMON_ROUTE_MODEL_PREFERENCES=1` 時走 daemon strict path。
  - 新增 env 模板旗標：
    - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_STATUS=1`
    - `OPENCODE_PER_USER_DAEMON_ROUTE_MODEL_PREFERENCES=1`
- Phase 2f（session.top strict）：
  - 新增 `UserDaemonManager.routeSessionTopEnabled()` + `callSessionTop()`。
  - `SessionRoutes` 的 `GET /session/top` 在 `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_TOP=1` 時走 daemon strict path。
  - 新增 env 模板旗標：`OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_TOP=1`。
- Phase 3（session mutation strict）：
  - 新增 `UserDaemonManager.routeSessionMutationEnabled()`。
  - 新增 daemon calls：
    - `callSessionCreate`, `callSessionDelete`, `callSessionUpdate`, `callSessionInit`
    - `callSessionFork`, `callSessionAbort`, `callSessionShare`, `callSessionUnshare`, `callSessionSummarize`
  - `SessionRoutes` 對應 endpoint 在 `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_MUTATION=1` 時走 daemon strict path（失敗直接 503，無 fallback）。
  - 新增 env 模板旗標：`OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_MUTATION=1`。
- Phase 4（session remaining mutation strict）：
  - 新增 daemon calls：
    - `callSessionMessageDelete`, `callSessionPartDelete`, `callSessionPartUpdate`
    - `callSessionPrompt`, `callSessionPromptAsync`, `callSessionCommand`, `callSessionShell`
    - `callSessionRevert`, `callSessionUnrevert`
  - `SessionRoutes` 對應 endpoint 改走 daemon strict path（失敗直接 503，無 fallback）。
- Phase 5（session remaining read strict）：
  - 新增 `UserDaemonManager.routeSessionReadEnabled()`。
  - 新增 daemon calls：
    - `callSessionGet`, `callSessionChildren`, `callSessionTodo`
    - `callSessionDiff`, `callSessionMessages`, `callSessionMessageGet`
  - `SessionRoutes` 對應 read endpoint 改走 daemon strict path（失敗直接 503，無 fallback）。
  - 新增 env 模板旗標：`OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_READ=1`。
- 插播修復（OpenAI quota hint）：
  - `account/quota/openai.ts` 新增 `getOpenAIQuota(accountId, { waitFresh: true })`，在 cold cache 時可等待單帳號 refresh 完成。
  - `server/routes/account.ts` 的 `/account/quota` 對 OpenAI 改用 `getOpenAIQuota(..., { waitFresh: true })`，避免首次載入長時間顯示 `(5hrs:-- | week:--)`。
- Phase 6（user-worker 退場前置）：
  - `UserWorkerManager.runtimeMode()` 新增 `legacyForceEnabled`。
  - `enabled()` 改為需同時滿足：
    - `OPENCODE_USER_WORKER_ENABLED=1`（或 skeleton）
    - `OPENCODE_USER_WORKER_EXPERIMENTAL=1`
    - `OPENCODE_USER_WORKER_LEGACY_FORCE=1`
  - 預設下 user-worker 路由完全封鎖；僅保留緊急回退用明確強制開關。
- Phase 7a（routes cleanup）:
  - `config.ts`：移除 `UserWorkerManager` 分支，僅保留 daemon strict + local path。
  - `account.ts`：移除 `UserWorkerManager` 的 list/mutation 分支，僅保留 daemon strict + local path。
  - `model.ts`：移除 `UserWorkerManager` 的 preferences 分支，僅保留 daemon strict + local path。
  - 此階段仍保留 `session.ts` 中 user-worker 分支，待 Phase 7b 集中清除。
- Phase 7b（session routes cleanup）:
  - `session.ts` 完整移除 `UserWorkerManager` import 與所有 `if (username && UserWorkerManager...)` 分支。
  - session 全路由現況：daemon strict + local path，無 user-worker fallback。
- Phase 8（runtime detach + file cleanup）:
  - `server/app.ts` 移除 `UserWorkerManager.logRuntimeModeOnce()/observe()/prewarm()` 呼叫。
  - 刪除 `server/user-worker/manager.ts`，`server/user-worker/index.ts` 僅保留 `UserWorkerRPC` export（供 CLI command 相容）。
  - `templates/system/opencode.env` 移除 user-worker route flags 區塊，改為 deprecated 提示。
- Phase 9（final user-worker artifact removal）:
  - `index.ts` 移除 `UserWorkerCommand` 註冊與 import。
  - 刪除 `cli/cmd/user-worker.ts`。
  - 刪除 `server/user-worker/rpc-schema.ts` 與 `server/user-worker/index.ts`。
  - `packages/opencode/src` 內已無 `UserWorker*` 參考。

### Side Incident Note (TUI)

- 現象：TUI 中滑鼠點擊無法聚焦 text input，程式未崩潰；以 `ctrl-x-b` 後恢復輸入。
- 判斷：偏焦點狀態機/快捷鍵模式切換問題，非後端 daemon 切流直接導致。
- 後續：需在 TUI 事件層補充 focus-state telemetry 與最小重現步驟記錄。

### Validation

- ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`
- ✅ `bunx eslint packages/opencode/src/server/user-worker/manager.ts packages/opencode/src/server/app.ts`
- ✅ `bunx eslint packages/opencode/src/server/user-daemon/manager.ts packages/opencode/src/server/routes/experimental.ts packages/opencode/src/system/linux-user-exec.ts`
- ✅ `bunx eslint packages/opencode/src/server/user-daemon/manager.ts packages/opencode/src/server/routes/experimental.ts packages/opencode/src/system/linux-user-exec.ts packages/opencode/src/server/app.ts`
- ✅ `bunx eslint packages/opencode/src/server/routes/config.ts packages/opencode/src/server/user-daemon/manager.ts packages/opencode/src/server/routes/experimental.ts packages/opencode/src/server/app.ts`
- ✅ `bunx eslint packages/opencode/src/server/routes/account.ts packages/opencode/src/server/routes/config.ts packages/opencode/src/server/user-daemon/manager.ts`
- ✅ `bunx eslint packages/opencode/src/server/routes/account.ts packages/opencode/src/server/routes/config.ts packages/opencode/src/server/user-daemon/manager.ts packages/opencode/src/server/app.ts`
- ✅ `bash -n install.sh`
- ✅ `bash -n templates/system/opencode-user-daemon-launch.sh`
- 🔜 Runtime follow-up（部署後）
  - 未設定 `OPENCODE_USER_WORKER_EXPERIMENTAL=1` 時，所有 `OPENCODE_USER_WORKER_ROUTE_*` 應不生效。
  - 既有 web routes 應走 legacy in-process path（避免大面積 503）。
  - 啟動 log 應可觀察到 user-worker mode 診斷訊息（active/ignored）。
  - 開啟 `OPENCODE_PER_USER_DAEMON_EXPERIMENTAL=1` 後，`/experimental/user-daemon` 應回傳當前使用者 socket 觀測狀態。
  - 當 socket 缺失時，`startAttempts` 與 `lastStartError` 應可反映 lazy-start 行為。
  - 開啟 `OPENCODE_PER_USER_DAEMON_ROUTE_CONFIG=1` 後，`/config` 走 daemon strict 模式；daemon 失敗應直接回報錯誤，不回退舊路徑。
  - 開啟 `OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_LIST=1` 後，`/account` 應走 daemon strict 模式；daemon 失敗應直接回報錯誤，不回退舊路徑。
  - 開啟 `OPENCODE_PER_USER_DAEMON_ROUTE_ACCOUNT_MUTATION=1` 後，`/account` mutation 應走 daemon strict 模式；daemon 失敗應直接回報錯誤，不回退舊路徑。

## Deployment / Runtime Check (2026-03-03 late round)

- `sudo ./install.sh --system-init -y` 已完成，system unit / launcher / sudoers 均成功安裝。
- `opencode-user-daemon@pkcs12.service` 可成功啟動並監聽 `127.0.0.1:42000`。
- daemon 直連驗證：
  - `GET http://127.0.0.1:42000/config` -> `200`
  - `GET http://127.0.0.1:42000/account` -> `200`
- strict route 行為驗證（停掉 daemon 後）：
  - `GET /config` -> `503 {"code":"DAEMON_REQUEST_FAILED","message":"ECONNREFUSED"}`
  - `GET /account` -> `503 {"code":"DAEMON_REQUEST_FAILED","message":"ECONNREFUSED"}`
  - `POST /account/google/active` -> `503 {"code":"DAEMON_REQUEST_FAILED","message":"ECONNREFUSED"}`

> 註：上述 gateway 驗證使用暫時測試憑證；測試完成後已移除臨時 `OPENCODE_SERVER_USERNAME/OPENCODE_SERVER_PASSWORD/OPENCODE_CLI_TOKEN`。

### Execution Update (system unit path)

1. 新增 system template unit：`templates/system/opencode-user-daemon@.service`（`User=%i`）。
2. 新增 launcher：`templates/system/opencode-user-daemon-launch.sh`，以 uid 計算 daemon port，並設定使用者 XDG 路徑後啟動 `opencode serve`。
3. `install.sh` 已新增：
   - 安裝 `/usr/local/libexec/opencode-user-daemon-launch`
   - 安裝 `/etc/systemd/system/opencode-user-daemon@.service`
   - sudoers 放行 `systemctl start opencode-user-daemon@*.service`
4. `UserDaemonManager` 連線改為 `127.0.0.1:<derived-port>`（不再依賴 user-bus + `systemctl --user`）。

### Remaining Hard Tasks (before production enable)

1. 規劃 user-worker 完全退場與 session/model 路由遷移。
2. 補 daemon 對應的健康端點與 correlation-id 追蹤，提升線上可觀測性。
3. 補部署 smoke test 腳本（自動化驗證 service/unit/strict route/error code）。

### Smoke Test Automation Added

- 新增：`scripts/smoke-systemd-strict-daemon.sh`
  - 檢查 systemd service 狀態（web + per-user daemon）
  - 檢查關鍵 env flags（daemon strict 開關 + worker experimental 關閉）
  - 驗證 `GET /experimental/user-daemon`, `GET /config`, `GET /account` 為 200
  - 可選 strict-down 測試：`OPENCODE_SMOKE_CHECK_STRICT_DOWN=1`
- 注意：strict-down 測試需要 `OPENCODE_TEST_BASIC_AUTH=<user:pass>`，因 Bearer token 不會綁定 `RequestUser`，無法覆蓋 per-user strict 路由分支。

### Session Sync Verification (Web vs TUI)

- 現象：web 與 TUI session 列表不一致。
- 根因：`RequestUser` 未綁定時（例如使用 Bearer token），`/session` 不會進入 per-user daemon strict 分支，會讀取 gateway in-process storage。
- 修正：新增 `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_LIST=1` + `SessionRoutes` daemon strict routing（`GET /session`）。
- 驗證：
  - 使用 Basic Auth（有 username）時，web `/session?directory=/home/pkcs12/projects/opencode` 與 daemon `/session` 結果 `same_ids_set=True`。
  - 使用 Bearer token 時仍可能看到不同集合（預期行為，因無 user binding）。

### Identity Rule Hardening (TUI backdoor)

- 新規則：CLI token 請求必須攜帶 `x-opencode-user`，否則一律 `401 CLI_USER_REQUIRED`。
- 實作：
  - `server/app.ts` 在 Bearer token 分支強制檢查 `x-opencode-user`，並用 `LinuxUserExec.sanitizeUsername()` 驗證。
  - `cli/cmd/tui/worker.ts` 在 in-process fetch 與 RPC fetch 自動附加 `x-opencode-user`（來源：`OPENCODE_EFFECTIVE_USER || USER || LOGNAME`）。
- 目的：確保 TUI「後門路徑」仍具有明確使用者身分，並與 per-user daemon strict routing 一致。

### Runtime Verification (Phase 2e)

- 已開啟 strict flags：
  - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_STATUS=1`
  - `OPENCODE_PER_USER_DAEMON_ROUTE_MODEL_PREFERENCES=1`
- 驗證結果（Bearer + `x-opencode-user: pkcs12`）：
  - web `/session/status` 與 daemon `/session/status` key set 一致
  - web `/model/preferences` 與 daemon `/model/preferences` 完全一致
  - `PATCH /model/preferences`（no-op payload）roundtrip 成功

### Runtime Verification (Phase 2f)

- 已開啟 strict flag：`OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_TOP=1`
- 驗證結果（Bearer + `x-opencode-user: pkcs12`）：
  - web `/session/top` 與 daemon `/session/top` 長度一致
  - `same_order=True`, `same_set=True`

### Runtime Verification (Phase 3)

- 驗證結果（Bearer + `x-opencode-user: pkcs12`）：
  - `POST /session` -> `200`
  - `PATCH /session/:id` -> `200`
  - `DELETE /session/:id` -> `200`
- strict 失敗語義驗證：
  - stop daemon 後 `POST /session` -> `503 {"code":"DAEMON_REQUEST_FAILED","message":"ECONNREFUSED"}`

### Runtime Verification (Phase 4)

- 驗證結果（Bearer + `x-opencode-user: pkcs12`）：
  - `POST /session` -> `200`
  - `POST /session/:id/unrevert` -> `200`
  - `DELETE /session/:id` -> `200`
- strict 失敗語義驗證：
  - stop daemon 後 `POST /session/:id/unrevert` -> `503 {"code":"DAEMON_REQUEST_FAILED","message":"ECONNREFUSED"}`

### Runtime Verification (Phase 5)

- 驗證結果（Bearer + `x-opencode-user: pkcs12`）：
  - web `/session/:id` 與 daemon `/session/:id` 一致
  - web `/session/:id/message?limit=3` 與 daemon 結果一致（長度與首筆 id）
- strict 失敗語義驗證：
  - stop daemon 後 `GET /session/:id` -> `503 {"code":"DAEMON_REQUEST_FAILED","message":"ECONNREFUSED"}`

### Runtime Verification (Phase 8/9 decommission)

- full rebuild/reinstall 完成（移除 user-worker artifacts 後）。
- `scripts/smoke-systemd-strict-daemon.sh` 驗證通過：
  - 正常路徑：`GET /experimental/user-daemon`, `GET /config`, `GET /account` -> `200`
  - strict-down：暫時 mask per-user daemon 後，`GET /config` 與 `GET /account` -> `503`
- 結論：在已移除 user-worker runtime/CLI artifact 後，per-user daemon strict 模式仍正常運作。

### UX Copy Alignment (Web ↔ TUI)

- 使用者回報：Web「審查 / 變更」文案容易被理解為「本次工作階段歷史變更」，與 TUI 的 working-tree 語義不一致。
- 調整：
  - `packages/ui/src/i18n/en.ts`: `ui.sessionReview.title` -> `Working tree changes`
  - `packages/ui/src/i18n/zht.ts`: `ui.sessionReview.title` -> `工作樹變更`
  - `packages/app/src/i18n/en.ts`: `session.review.empty/noChanges` 改為 `working tree` 語義
  - `packages/app/src/i18n/zht.ts`: `session.review.empty/noChanges` 改為 `目前工作樹沒有未提交變更 / 沒有工作樹變更`
- 目標：讓 Web 和 TUI 都明確表示「當下 git working tree 狀態」，避免誤判為 session 歷史變更。

### UX Simplification (Review vs File Tree dedup)

- 使用者確認「Review」與 File Tree 的「changes」清單語義重疊，造成重複資訊與操作負擔。
- 調整：
  - `packages/app/src/pages/session/session-side-panel.tsx`
    - 移除 File Tree 內 `changes/all` tabs。
    - 保留單一 `All files` 標頭 + `FileTree`，並持續顯示 modified/kind 標記。
  - `packages/app/src/pages/session.tsx`
    - 移除與 File Tree tab 狀態耦合的舊邏輯（`fileTreeTab`/`setFileTreeTabValue`/review diff focus coupling）。
    - 更新 `SessionSidePanel` 傳參以符合新介面。
  - `packages/app/src/pages/session/index.tsx`
    - 同步移除已刪除的 `SessionSidePanel` 舊 props 傳遞。
- 驗證：
  - ✅ `bun run typecheck`（workdir: `packages/app`）
  - ✅ `bun eslint packages/app/src/pages/session.tsx packages/app/src/pages/session/index.tsx packages/app/src/pages/session/session-side-panel.tsx`

### Runtime Deploy + webctl 流程簡化（2026-03-03 晚間）

- 使用者回報「新 UI 未生效」，原因為 source 變更尚未重新部署到 systemd 生產服務。
- 執行部署時遇到權限阻塞：
  - `dist/opencode-frontend.tar.gz` 與 `packages/app/dist/*` 存在 root 擁有檔，導致 build unlink/rm `EACCES/Permission denied`。
  - 處置：`sudo chown -R $(id -un):$(id -gn) dist packages/app/dist` 後重跑安裝。
- 重新部署結果：
  - `./webctl.sh install --yes` 成功（含 frontend build + binary build + systemd reload/restart）。
  - `./webctl.sh status` 顯示健康且版本更新為 `0.0.0-cms-202603031454`。
- 同步簡化 `webctl.sh` 操作流程：
  - 新增 `dev-refresh`：`build-frontend + restart`（開發流程一鍵化）。
  - 新增 `web-refresh`：source repo 下執行 `install --yes` + `web-restart`（生產重編重啟一鍵化）。
  - 已更新 `help` 與 command routing。
  - 驗證：`bash -n webctl.sh`、`./webctl.sh help`。

### Language Default Correction（Traditional Chinese first）

- 使用者回報 webapp 初始語言仍常落到簡體中文。
- 根因：`detectLocale()` 對 `zh-*` 的 matcher 過於寬鬆，僅 `zh-Hant` 會被判定為 `zht`，`zh-TW/zh-HK/zh-MO` 會被一般 `zh` 規則攔截。
- 修正：`packages/app/src/context/language.tsx`
  - `zht` matcher 擴充為 `zh` + (`hant` | `tw` | `hk` | `mo`)。
  - 仍保留無匹配時 fallback 為 `zht` 的產品預設。
- 驗證：
  - ✅ `bun eslint packages/app/src/context/language.tsx`
  - ✅ `bun run typecheck`（workdir: `packages/app`）
  - ✅ `./webctl.sh web-refresh` 後 `./webctl.sh status`：`version=0.0.0-cms-202603031500`

### Review 視窗命名與 Git diff 顯示修復

- 使用者需求：
  - 將「上一輪變更」更名為「當下變動」。
  - 將「工作樹變更」更名為「Git變動」。
  - 修復目前 Git diff 無法顯示（列表有檔案但內容空白）。
- 命名調整：
  - `packages/ui/src/i18n/zht.ts`
    - `ui.sessionReview.title`：`Git變動`
    - `ui.sessionReview.title.lastTurn`：`當下變動`
  - `packages/ui/src/i18n/zh.ts`
    - `ui.sessionReview.title`：`Git变动`
    - `ui.sessionReview.title.lastTurn`：`当下变动`
  - `packages/app/src/i18n/zht.ts` / `packages/app/src/i18n/zh.ts`
    - `session.review.empty/noChanges` 文案同步改為 Git 語義。
- Bug root cause：
  - `sync.session.diff()` 只使用 `client.file.status()`，但把 `before/after` 固定塞空字串，導致 `SessionReview` diff renderer 沒有內容可畫。
- 修復：
  - `packages/app/src/context/sync.tsx`
    - 保留 `file.status()` 做變更檔案來源。
    - 逐檔呼叫 `client.file.read({ path })`，並由 `patch.hunks` 還原 `before/after` 內容（新增 `gitContentsFromPatch`）。
    - 新增檔 fallback：若為 added 且 patch 不可用，使用 `content` 作為 `after`。
  - `packages/opencode/src/file/index.ts`
    - 修正 deleted file 情境：檔案不存在時，若 git 可取 `HEAD:<file>`，回傳 `patch/diff`（old -> empty）讓前端可渲染刪除 diff。
- 驗證：
  - ✅ `bun eslint packages/app/src/context/sync.tsx packages/app/src/i18n/zht.ts packages/app/src/i18n/zh.ts packages/ui/src/i18n/zht.ts packages/ui/src/i18n/zh.ts packages/opencode/src/file/index.ts`
  - ✅ `bun run typecheck`（workdir: `packages/app`）
  - ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`
  - ✅ `./webctl.sh web-refresh`，`./webctl.sh status`：`version=0.0.0-cms-202603031510`

### Data Path RCA（二次修復：空白 Git 變動面板）

- 使用者回報：即使有編輯，`Git變動` 面板仍常停留在「目前 Git 沒有未提交變更」。
- 重新追查 data path：
  1. `pages/session.tsx`（目前主路徑）只在 `session_diff` 未存在時呼叫一次 `sync.session.diff(id)`。
  2. 若首次載入時為空陣列，後續本地檔案變更不會觸發 force refresh（快取黏住）。
  3. `pages/session/index.tsx` 已有 `statusType===idle` 時 `force` 刷新，但 `session.tsx` 缺失該邏輯，造成雙實作行為漂移。
- 修正：
  - `packages/app/src/pages/session.tsx`
    - 將 diff 觸發改為：`sync.session.diff(id, { force: statusType === "idle" })`
    - 移除 `session_diff 已存在就 return` 的一次性 gate。
    - 對齊 `session/index.tsx` 的刷新語義，避免 stale empty cache。
- 驗證：
  - ✅ `bun eslint packages/app/src/pages/session.tsx`
  - ✅ `bun run typecheck`（workdir: `packages/app`）
  - ✅ `./webctl.sh web-refresh`，`./webctl.sh status`：`version=0.0.0-cms-202603031522`

### Data Path RCA（三次修復：Git safe.directory 導致 status 假空）

- 症狀：使用者提供同一路徑 `/home/pkcs12/projects/opencode`，Web 端 `Git變動` 仍為空。
- 重新定位後判定：
  - Web 服務以 system user 執行，git 命令在「非 repo owner」情境可能被 `safe.directory` 限制。
  - `File.status()` / `File.read()` 內 git 調用採 `.nothrow().text()`，失敗時輸出空字串，前端會被誤導成「無變更」。
- 修正：`packages/opencode/src/file/index.ts`
  - 所有 review 路徑用到的 git 命令補上 `-c safe.directory=*`：
    - `diff --numstat HEAD`
    - `ls-files --others --exclude-standard`
    - `diff --name-only --diff-filter=D HEAD`
    - `diff <file>` / `diff --staged <file>`
    - `show HEAD:<file>`（含 deleted-file fallback）
- 驗證：
  - ✅ `bun eslint packages/opencode/src/file/index.ts`
  - ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`
  - ✅ `./webctl.sh web-refresh`，`./webctl.sh status`：`version=0.0.0-cms-202603031527`

### Data Path RCA（四次修復：directory scope fallback 誤導）

- 使用者仍回報 `Git變動` 長期空白；重新比對 middleware data path 後，發現核心風險在 `server/app.ts`：
  - 有 auth user + home 時，directory 會被 user-home scope 邏輯重寫。
  - 當登入帳號與專案擁有者不同（常見於 service account / 預設帳號），請求路徑可能被靜默改寫到另一個 home，導致 File.status() 永遠空。
- 重寫 directory 解析策略（最小必要重寫）：
  - 相對路徑仍以 user home 為基準解析。
  - 絕對路徑不再因「超出 user home」被強制回退。
  - 仍保留不存在路徑 fallback 與 `X-Opencode-Resolved-Directory` header。
- 變更檔案：
  - `packages/opencode/src/server/app.ts`
- 驗證：
  - ✅ `bun eslint packages/opencode/src/server/app.ts`
  - ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`

### Debug Checkpoints（五次：建立可觀測診斷面）

#### Baseline

- 使用者於同一路徑 `/home/pkcs12/projects/opencode` 持續回報 `Git變動` 空白。
- 既有修補（cache force/safe.directory/directory scope）仍無法從 UI 端閉環驗證。
- 缺口：缺少「請求當下」的可觀測資料（request user / resolved directory / git exit code / stderr）。

#### Execution

- 新增 server-side 診斷 checkpoint（無侵入主流程）：
  - `packages/opencode/src/server/routes/experimental.ts`
    - 新增 `GET /experimental/review-checkpoint`
    - 回傳：
      - `requestUser`
      - `directory`, `worktree`, `project(vcs/id/name)`
      - `File.status()` 結果數量與 sample
      - git checkpoint（`diff --numstat` / `status --porcelain`）exit code + stderr/sample
- 強化 `File.status()` 內部可觀測性：
  - `packages/opencode/src/file/index.ts`
    - 改用 `util/git` 收集每段 git 指令 `exitCode/stderr`。
    - 支援 `OPENCODE_DEBUG_REVIEW_CHECKPOINT=1` 時寫入 checkpoint log（`checkpoint:file.status`）。

#### Validation

- ✅ `bun eslint packages/opencode/src/file/index.ts packages/opencode/src/server/routes/experimental.ts`
- ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`
- ✅ `./webctl.sh web-refresh`，`./webctl.sh status`：`version=0.0.0-cms-202603031550`

### Debug Checkpoints（六次：線上請求可觀測化）

#### Baseline

- 即使 backend locally 可得 status，仍無法從使用者 UI 證明「前端請求當下」看到的是同一路徑與同一份狀態。

#### Execution

- `packages/opencode/src/server/routes/file.ts`
  - `/file/status` 回應新增 headers：
    - `X-Opencode-Review-Directory`
    - `X-Opencode-Review-Count`
  - 可直接在 Browser Network 觀測「此請求實際解析的目錄與狀態筆數」。
- `packages/opencode/src/server/routes/experimental.ts`
  - 保留 `GET /experimental/review-checkpoint` 供深度診斷（requestUser/directory/project/git exit）。

#### Validation

- ✅ `bun eslint packages/opencode/src/server/routes/file.ts packages/opencode/src/file/index.ts packages/opencode/src/server/routes/experimental.ts`
- ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`
- ✅ `./webctl.sh web-refresh`，`./webctl.sh status`：`version=0.0.0-cms-202603031553`
- ✅ `curl /api/v2/file/status?directory=/home/pkcs12/projects/opencode` 可見 headers：
  - `X-Opencode-Resolved-Directory: /home/pkcs12/projects/opencode`
  - `X-Opencode-Review-Directory: /home/pkcs12/projects/opencode`
  - `X-Opencode-Review-Count: 17`

### UX 文案改名 + Debug 面收斂

#### Baseline

- 使用者要求文案更名：
  - `Git變動` → `累積異動`
  - `當下變動` → `最新異動`
  - `審查`（tab 標題）→ `異動清單`
- 同時要求依建議收斂 debug 面：保留輕量 checkpoint，重型 diagnostics 改為 debug-only。

#### Execution

- 文案調整：
  - `packages/ui/src/i18n/zht.ts`
  - `packages/ui/src/i18n/zh.ts`
  - `packages/app/src/i18n/zht.ts`
  - `packages/app/src/i18n/zh.ts`
- Debug 面收斂：
  - `packages/opencode/src/server/routes/experimental.ts`
    - `GET /experimental/review-checkpoint` 新增 gate：`OPENCODE_DEBUG_REVIEW_CHECKPOINT=1` 才開放，否則回 `404 CHECKPOINT_DISABLED`。
  - `packages/opencode/src/server/routes/file.ts` 的 `X-Opencode-Review-*` headers 保留（輕量可觀測）。

#### Validation

- ✅ `bun eslint packages/ui/src/i18n/zht.ts packages/ui/src/i18n/zh.ts packages/app/src/i18n/zht.ts packages/app/src/i18n/zh.ts packages/opencode/src/server/routes/experimental.ts`
- ✅ `bun run typecheck`（workdir: `packages/app`）
- ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`
- ✅ `./webctl.sh web-refresh`，`./webctl.sh status`：`version=0.0.0-cms-202603031604`

### Debug Checkpoints（七次：Web 對話非即時刷新）

#### Baseline

- 使用者回報：在 webapp 送出 prompt 後，AI 回覆不會即時出現在對話中，需手動 refresh 才看到最新內容。
- 觀察：此症狀符合跨進程事件流（SSE）偶發漏送時，UI 僅靠事件驅動而沒有持續快照補水。

#### Execution

- 在 `packages/app/src/components/prompt-input.tsx` 新增「工作中 message 快照 watchdog」：
  - 條件：`session.status !== idle`（working）期間啟用。
  - 行為：每 1.5 秒強制呼叫 `sync.session.read(sessionID, 300, { force: true })`。
  - 目的：即使 SSE 延遲/漏送，也能以快照路徑持續補水，讓 assistant 回覆在不 refresh 頁面的情況下出現。

#### Validation

- ✅ `bun eslint packages/app/src/components/prompt-input.tsx`
- ✅ `bun run typecheck`（workdir: `packages/app`）
- ⚠️ `./webctl.sh web-refresh` 在當前執行環境被 `sudo no new privileges` 阻擋，需於可 sudo 的主機會話執行部署。

### Ops policy fix（sudo / no_new_privileges）

- 使用者要求：禁止透過 root-hop（`sudo -u root ... sudo -u <owner> ...`）進行自動切換。
- 調整：
  - `webctl.sh` 的 `ensure_repo_owner_identity()` 僅保留「直接切換到 repo owner」策略。
  - 移除 root-hop fallback，錯誤訊息改為明確提示需要 direct sudo rights。
- 補強：
  - `install.sh` 在 sudo 受限（如 `no_new_privileges`）時提供明確提示，避免誤導為密碼或帳號問題。

### Ops preflight（webctl 非互動 sudo 檢查）

- 目的：在進入 `install/web-*` 流程前，提早明確失敗，避免執行到中途才被 `sudo no_new_privileges` 中斷。
- 變更：
  - `webctl.sh`
    - 新增 `requires_privileged_command()`
    - 新增 `ensure_non_interactive_sudo()`
    - 於 main 入口先執行 preflight（`ensure_repo_owner_identity` 後）
    - `install --help` 例外放行（不需提權即可看說明）
- 驗證：
  - ✅ `bash -n webctl.sh`
  - ✅ `./webctl.sh help`

### Ops optimization（web-refresh 壓力降載）

- 使用者回饋：`webctl.sh web-refresh` 每次都跑完整 install/system package 流程，壓力太大。
- 調整：
  - `webctl.sh`
    - `web-refresh` 預設改為 fast mode：`do_install --yes --skip-system`（跳過系統套件安裝步驟）。
    - 新增 `OPENCODE_WEB_REFRESH_FULL_BOOTSTRAP=1` 可切回完整 bootstrap。
  - `install.sh`
    - 新增 Linux 依賴檢測（git/curl/unzip/xz/jq/pkg-config/cc/openssl）
    - 若已滿足，直接略過 package manager 安裝。
- 驗證：
  - ✅ `bash -n webctl.sh`
  - ✅ `bash -n install.sh`
  - ✅ `./webctl.sh help` 已顯示 `OPENCODE_WEB_REFRESH_FULL_BOOTSTRAP`

### Debug Checkpoints（八次：prompt 執行中 UI 不刷新）

#### Baseline

- 使用者實測回報：送出 prompt 後 backend 有工作，但前端看不到 assistant 內容增量；需手動 refresh 才看到完整回覆。

#### Execution

- `packages/app/src/context/sync.tsx`
  - 修正 `session.sync(..., { force: true })` 行為：force 時必定重抓 messages（不再被 `hasMessages && hydrated` 短路）。
- `packages/app/src/components/prompt-input.tsx`
  - working 期間增加 message snapshot watchdog（每 1.5s 強制 `session.sync(..., { force: true })`）。
- `packages/app/src/components/prompt-input/submit.ts`
  - prompt 送出時先設定 `session_status=busy`（確保 watchdog 啟動，不依賴 SSE `session.status` 及時送達）。
  - 將 snapshot hydration 輪詢改為與 `promptAsync` 並行執行，而非等待 `promptAsync` 返回後才補水。
  - 完成後回寫 `session_status=idle`。

#### Validation

- ✅ `bun eslint packages/app/src/components/prompt-input/submit.ts packages/app/src/components/prompt-input.tsx packages/app/src/context/sync.tsx`
- ✅ `bun run typecheck`（workdir: `packages/app`）
- ⚠️ `./webctl.sh web-refresh` 於目前受限 shell 被 preflight 阻擋（non-interactive sudo unavailable）；需在主機正常 shell 執行部署。

### Debug Checkpoints（九次：事件優先、靜默才補輪詢）

- 使用者質疑是否「只能靠輪詢才會更新畫面」。
- 調整策略：
  - `packages/app/src/components/prompt-input.tsx`
    - 新增 `lastRealtimeAt`，由 SSE 事件（`session.status`、`message.part.updated`）更新。
    - message watchdog 改為「事件優先」：僅在 stream 靜默超過 2.5 秒時才觸發強制 `session.sync(..., { force: true })`。
  - 目的：平時維持事件驅動，僅在疑似漏事件時啟用補水。
- 驗證：
  - ✅ `bun eslint packages/app/src/components/prompt-input.tsx`
  - ✅ `bun run typecheck`（workdir: `packages/app`）

### Debug Checkpoints（十次：assistant 回覆判斷不應依賴時間戳）

- 症狀：使用者仍回報 UI 停在 user 輸入處，refresh 才看到 AI 回覆。
- 根因補充：submit 輪詢中的 `hasAssistantReply` 先前以 `assistant.created >= optimisticMessage.created` 判斷，會受 client/server 時鐘差影響，導致已存在 assistant 仍被判定為 false。
- 修正：
  - `packages/app/src/components/prompt-input/submit.ts`
    - `hasAssistantReply` 改為僅判斷 snapshot 是否含 assistant message（不比較 timestamp）。
    - 在 `await promptRun` 後新增一次「最終一致性 hydrate」：強制抓 `session.messages` 並回寫 message/part store，避免 SSE 時序與時間戳差造成終態漏顯示。
- 驗證：
  - ✅ `bun eslint packages/app/src/components/prompt-input/submit.ts`
  - ✅ `bun run typecheck`（workdir: `packages/app`）

### Debug Checkpoints（十一次：第二句觸發第一句回覆顯示）

- 使用者新線索：輸入第二句時，第一句的 AI 回覆才出現，表示非「必須 refresh」，而是「顯示時機延遲」。
- 根因：submit 輪詢停止條件仍可能被「舊 assistant 訊息」污染；`promptDone && hasAssistantReply` 在歷史中已有 assistant 時無法正確辨識「本輪新回覆」，導致首輪完成後未即時停在新狀態。
- 修正：
  - `packages/app/src/components/prompt-input/submit.ts`
    - 送出前建立 `knownAssistantIDs`（以當前 store 內既有 assistant 訊息為基線）。
    - 輪詢與最終一致性 hydrate 都改為判斷「是否出現不在基線中的新 assistant message id」。
    - 最終一致性 hydrate 改為短暫重試（最多 8 次、每次 500ms）處理寫入延遲。
- 驗證：
  - ✅ `bun eslint packages/app/src/components/prompt-input/submit.ts`
  - ✅ `bun run typecheck`（workdir: `packages/app`）

### Debug Checkpoints（十二次：回覆期間捲動位置飄到中段）

- 使用者回報：即時回覆可見，但串流過程中時間軸會跳到中上段，未持續跟隨最新內容。
- 調整：
  - `packages/app/src/pages/session.tsx`
  - `packages/app/src/pages/session/index.tsx`
    - `createAutoScroll` 的 `working` 改為 `status().type !== "idle"`（不再常駐 active）。
    - 新增 running-turn 鎖底機制：status 非 idle 時每 200ms 強制 `forceScrollToBottom()`，維持「追蹤最底部最新內容」。
    - 同步更新 scroll state，避免 UI 誤判底部狀態。
- 驗證：
  - ✅ `bun eslint packages/app/src/pages/session.tsx packages/app/src/pages/session/index.tsx`
  - ✅ `bun run typecheck`（workdir: `packages/app`）

### Debug Checkpoints（十三次：思考鏈/Tool call 首次不即時）

- 使用者回報：正式文字可即時，但思考鏈（tool steps）常要 refresh 才出現；一旦出現後可持續更新。
- 根因假設與修正：
  - 主 session 輪詢補水只抓 `session.id` 的 messages/parts；若中間步驟由 task 子 session 產生，前端缺少該子 session 的快照補水，會出現「主回答即時、步驟延遲」現象。
  - `packages/app/src/components/prompt-input/submit.ts`
    - 新增 `extractTaskSessionIDs()`：從 tool part `state.metadata.sessionId` 蒐集子 session。
    - 新增 `hydrateTaskSnapshots()`：對每個 task session 拉 `session.messages` 並回寫 globalSync store。
    - 主輪詢與最終一致性 hydrate 都同步補水 task sessions。
- 驗證：
  - ✅ `bun eslint packages/app/src/components/prompt-input/submit.ts`
  - ✅ `bun run typecheck`（workdir: `packages/app`）

### Debug Checkpoints（十四次：回滾強制貼底）

- 使用者確認需求：對話頁不得強制貼底，需保留上捲閱讀歷史能力。
- 處置：
  - 回滾 `session.tsx` / `session/index.tsx` 中「每 200ms forceScrollToBottom」鎖底機制。
  - 保留原有 auto-scroll（使用者未上捲時跟隨；上捲後可停留）。
- 驗證：
  - ✅ `bun eslint src/pages/session.tsx src/pages/session/index.tsx`（workdir: `packages/app`）
  - ✅ `bun run typecheck`（workdir: `packages/app`）

### Debug Checkpoints（十五次：關閉 daemon session mutation 做 A/B）

- 目的：驗證「web prompt 不即時」是否由 per-user daemon mutation 路徑導致事件鏈斷裂。
- 執行：
  - `/etc/opencode/opencode.env`
    - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_MUTATION=0`
  - `./webctl.sh web-restart`
  - `./webctl.sh status`
- 結果：
  - systemd service 正常重啟（`opencode-web.service` running）
  - Health: `{"healthy":true,"version":"0.0.0-cms-202603031721"}`
- 待驗證（使用者實測）：
  - web prompt 的 chain-of-thought / tool steps 是否恢復首輪即時顯示
  - 對話區是否仍有中段隨機閃爍/跳捲現象

### Debug Checkpoints（十六次：web 狀態卡在 working）

- 使用者回報：TUI 已 idle 等待輸入，但 web 仍顯示 working 未停止。
- 判斷：這更指向 session.status 路由鏈路不同步。
- 執行 A/B：
  - `/etc/opencode/opencode.env`
    - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_STATUS=0`
    - （前一步已為 `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_MUTATION=0`）
  - `./webctl.sh web-restart`
  - `./webctl.sh status`
- 結果：
  - service running
  - health version: `0.0.0-cms-202603031721`
- 待使用者實測：
  - web 是否能在 TUI idle 後同步回到 idle（停止顯示工作中）

### Debug Checkpoints（十七次：關閉所有 session daemon 路由做純基線）

- 目的：排除 per-user daemon 對 session 事件鏈的干擾，驗證 web realtime 是否恢復到 origin/dev 行為。
- `/etc/opencode/opencode.env` 調整：
  - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_LIST=0`
  - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_STATUS=0`
  - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_READ=0`
  - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_TOP=0`
  - `OPENCODE_PER_USER_DAEMON_ROUTE_SESSION_MUTATION=0`
- 執行：
  - `./webctl.sh restart`（dev mode）
  - `./webctl.sh status`（health `version=local`）
- 待驗證（使用者實測）：
  - web 發話是否恢復完整即時（含 chain/tool）
  - web working 狀態是否能在實際 idle 時結束
  - 亂跳捲動/閃爍是否消失

### Debug Checkpoints（十八次：閃爍跳轉收斂，開頁預設觸底）

- 使用者回報：
  - 不再回捲到中上段，但仍在原地/底部間高頻跳動（疑似 scroll 競態）。
  - refresh 進頁後停在頂部，期望自動觸底。
- 分析：
  - `use-session-hash-scroll.ts` 在 messages 更新期間會反覆套用 hash 導向邏輯，與 auto-follow 同時作用，造成拉扯。
  - 初次載入仍可能套用 hash/舊定位而非明確觸底。
- 修正（不再新增輪詢補丁）：
  - `packages/app/src/pages/session/use-session-hash-scroll.ts`
    - session 初次 ready 時：
      - 強制 `forceScrollToBottom()`
      - 清除 hash（`clearMessageHash()`）
      - 重置 active message 為最新
    - 後續消息變化時，僅處理 `pendingMessage` 導向；不再把 URL hash 當作每次更新的持續導向來源。
    - `hashchange` 仍保留，僅在使用者主動 hash 變動時套用。
- 驗證：
  - ✅ `bun eslint src/pages/session/use-session-hash-scroll.ts`（workdir: `packages/app`）
  - ✅ `bun run typecheck`（workdir: `packages/app`）

### Debug Checkpoints（十九次：降低週期閃爍 + 分段視覺一致化）

- 使用者回饋：
  - tool/thinking 顯示期間仍有週期性閃爍（約 2~3 秒節奏）。
  - 報告分段在 web 版缺少明確分隔線，空白過大。
- 修正：
  - `packages/app/src/components/prompt-input.tsx`
    - session status watchdog 每 3 秒拉取後，先比較目前狀態與新狀態；相同則不寫回 store，避免無效重渲染造成週期閃爍。
  - `packages/ui/src/components/markdown.css`
    - `hr` 從「隱形大空白」改為可見分隔線，並縮小上下間距（`margin: 1rem 0`）。
    - 讓 web 呈現更接近 TUI 報告分段感。
- 驗證：
  - ✅ `bun eslint src/components/prompt-input.tsx`（workdir: `packages/app`）
  - ✅ `bun run typecheck`（workdir: `packages/app`）
