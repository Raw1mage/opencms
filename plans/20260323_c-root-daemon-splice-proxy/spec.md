# Spec

## Purpose
- 將 C root gateway splice proxy 從 prototype 收斂為可驗收的 daemonization hardening 版本，確保認證、路由、使用者隔離、TUI attach 契約與 runtime 驗證一致。

## Requirements

### Requirement: Gateway SHALL validate JWT claims before proxying
The system SHALL 在任何已登入後續請求進入 splice proxy 前，完成可驗證的 JWT claims 驗證，而非僅檢查簽章。current issuance reality 與 target contract 的差異必須先被明文化，再進入實作。

#### Scenario: Valid JWT routes to the correct user daemon
- **GIVEN** 使用者已透過 PAM 登入並持有合法 JWT cookie
- **WHEN** browser 建立新的 HTTP/SSE/WebSocket 連線
- **THEN** gateway 先依 planner 鎖定的 claim contract 驗證 token（現況 evidence 為 `sub` + `exp`，target contract 為 `sub` / `uid` / `exp` 或等效可驗證 identity source），再以該 identity 導向對應的 per-user daemon

#### Scenario: Expired or malformed JWT fails fast
- **GIVEN** request 攜帶過期、缺 claim、簽章錯誤或 decode 失敗的 JWT
- **WHEN** gateway 嘗試驗證 cookie
- **THEN** gateway 回傳未授權回應，不建立 splice proxy，也不以其他 daemon 作為 fallback

### Requirement: Gateway SHALL route by authenticated user identity
The system SHALL 以經驗證的使用者 identity 精準選擇 daemon，而不是以 first-available 或 registry 順序決定目標。

#### Scenario: Two logged-in users remain isolated
- **GIVEN** alice 與 bob 各自擁有獨立 per-user daemon
- **WHEN** alice 攜帶 alice 的 JWT 發出請求
- **THEN** gateway 只會連到 alice 的 daemon socket，不得連到 bob 的 daemon

#### Scenario: Missing daemon triggers explicit adopt-or-spawn flow
- **GIVEN** request 已驗證出使用者 identity，但 registry 中尚無 ready daemon
- **WHEN** gateway 處理該 request
- **THEN** gateway 依 discovery-first 契約先 adopt，失敗後再 spawn，並在 timeout / failure 時回傳明確錯誤

### Requirement: Gateway SHALL make daemon lifecycle observable and bounded
The system SHALL 對 adopt / spawn / stale socket cleanup / child exit / timeout 提供明確 lifecycle 行為與驗證點。

#### Scenario: Stale discovery or socket is rejected
- **GIVEN** discovery file 指向不存在或已死亡 PID，或 socket 已失效
- **WHEN** gateway 嘗試 adopt daemon
- **THEN** gateway 明確視為 adopt 失敗，清理 stale state，進入 spawn 或回報錯誤，而不是默默重用錯誤資訊

#### Scenario: Child daemon startup timeout surfaces failure
- **GIVEN** gateway 已 fork+setuid+exec per-user daemon
- **WHEN** socket readiness 在 timeout 內未出現
- **THEN** gateway 中止該 startup、保留可觀測錯誤，且不把該 daemon 標成 ready

### Requirement: TUI attach contract SHALL use explicit auto-spawn
The system SHALL 對 `--attach` 模式採用單一明確契約：找不到 daemon 時顯式 auto-spawn，並在 spec / design / architecture / event 中保持一致。

#### Scenario: Attach auto-spawns when daemon is missing
- **GIVEN** 使用者執行 `opencode --attach`
- **WHEN** 本機尚無可用 daemon
- **THEN** 系統顯式啟動 per-user daemon、等待 discovery readiness，成功後 attach；若啟動失敗或逾時則明確報錯，不得 silent fallback

### Requirement: Hardening SHALL include runtime verification matrix
The system SHALL 將 compile success、single-user runtime、multi-user isolation、SSE/WS forwarding 分開驗收，不得僅以 gcc 編譯成功代表功能完成。

#### Scenario: Verification distinguishes static and runtime evidence
- **GIVEN** gateway source 已可編譯
- **WHEN** 驗收 hardening work
- **THEN** 驗證紀錄必須區分 static compile、JWT/routing correctness、single-user login flow、multi-user isolation、SSE/WS proxy forwarding

## Acceptance Checks
- JWT validation path 明確覆蓋 signature、decode、claim presence、expiration、identity extraction。
- Gateway route target 由 verified identity 決定，程式中不存在 first-daemon demo routing。
- adopt / spawn / timeout / stale cleanup 各自有明確錯誤路徑與驗證證據。
- `--attach` 契約在 plan artifacts、event、architecture 中一致。
- 驗證清單至少包含：gcc compile、single-user login API、SSE forwarding、WebSocket forwarding、two-user isolation。
- 在進入實作前，planner artifacts 必須先明確標註哪些行為屬於現況 prototype、哪些是 hardening 目標契約。
