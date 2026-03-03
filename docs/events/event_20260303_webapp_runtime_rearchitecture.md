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
