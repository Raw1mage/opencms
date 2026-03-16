# Spec: openclaw_reproduction

## Purpose

定義單一 OpenClaw reproduction 主計畫，將 benchmark、implementation planning、及所有衍生實作切片收斂為同一 authority。

---

## Slice 0: Planning Authority

### Requirement: Single planning authority

The OpenClaw-aligned runner work SHALL be tracked through a single active plan package.

#### Scenario: multiple historical openclaw plans exist

- **GIVEN** earlier benchmark and substrate plan packages exist
- **WHEN** the workstream is consolidated
- **THEN** a single active plan must become the execution authority and the older packages must be treated as reference history only

### Requirement: Benchmark and implementation slices coexist in the same plan

The active plan SHALL contain both benchmark conclusions and phased implementation slices.

#### Scenario: user asks what to build next

- **GIVEN** OpenClaw research has already been done
- **WHEN** the active plan is consulted
- **THEN** it must explain both the benchmark findings and the recommended next build slice

---

## Slice 1: Kill-switch 控制面

### Requirement: Kill-switch trigger path

Authorized operators SHALL be able to trigger a global kill-switch via Web / TUI / API.

#### Scenario: operator triggers kill-switch

- **GIVEN** an operator with `kill_switch:trigger` permission
- **WHEN** the operator POSTs to `/api/v2/admin/kill-switch/trigger` with `reason` and valid MFA
- **THEN** the system returns `request_id` and `snapshot_url`, marks global state as `soft_paused`, and writes an audit entry

#### Scenario: duplicate trigger within cooldown window

- **GIVEN** a kill-switch was triggered by the same operator within the last 5 seconds
- **WHEN** the operator triggers again with the same reason
- **THEN** the system returns the same `request_id` (idempotent) without creating a new state transition

### Requirement: Scheduling gate

New task scheduling SHALL be blocked when kill-switch is active.

#### Scenario: new task submitted while kill-switch active

- **GIVEN** kill-switch state is `soft_paused` or `hard_killed`
- **WHEN** a client POSTs a new message or async prompt to a session
- **THEN** the system returns 409 Conflict with error code `KILL_SWITCH_ACTIVE`

### Requirement: Soft-pause semantics

Running tasks SHALL receive a graceful shutdown signal before force termination.

#### Scenario: soft-pause window

- **GIVEN** kill-switch has been triggered
- **WHEN** the soft_timeout has not yet elapsed
- **THEN** running workers receive a graceful-shutdown signal via control channel and may complete current step

### Requirement: Hard-kill semantics

Tasks still running after soft_timeout SHALL be forcefully terminated.

#### Scenario: hard-kill after timeout

- **GIVEN** soft_timeout has elapsed and workers are still running
- **WHEN** the system checks remaining workers
- **THEN** force-terminate via process kill or SessionPrompt.cancel(), write termination reason to audit

### Requirement: Cancel path

Authorized operators SHALL be able to cancel the kill-switch to resume normal operation.

#### Scenario: operator cancels kill-switch

- **GIVEN** kill-switch is active
- **WHEN** an authorized operator POSTs to cancel endpoint
- **THEN** state returns to `inactive`, new task scheduling is re-enabled, audit entry is written

### Requirement: Snapshot and audit

Every kill-switch trigger SHALL generate a system snapshot and audit trail.

#### Scenario: snapshot on trigger

- **GIVEN** kill-switch is triggered
- **WHEN** the trigger is accepted
- **THEN** an async snapshot job collects system logs (1000 lines), active sessions, outstanding tasks, provider usage; uploads to storage; links `snapshot_url` in audit

#### Scenario: snapshot failure

- **GIVEN** snapshot generation fails
- **WHEN** the system completes the trigger
- **THEN** state write still succeeds and audit records the snapshot failure reason

### Requirement: RBAC and MFA

Kill-switch trigger SHALL require role-based access control and multi-factor authentication.

#### Scenario: unauthorized trigger attempt

- **GIVEN** a user without `kill_switch:trigger` permission
- **WHEN** the user attempts to trigger
- **THEN** the system returns 403 Forbidden

#### Scenario: MFA challenge

- **GIVEN** an authorized operator triggers without MFA code
- **WHEN** the system processes the request
- **THEN** the system returns a `mfa_challenge` response requiring TOTP verification before state change

### Requirement: Per-session control

Operators SHALL be able to control individual sessions (pause/cancel) without global kill-switch.

#### Scenario: per-session pause

- **GIVEN** an operator with `task:control` permission
- **WHEN** the operator sends a control command (pause/cancel) to a specific session
- **THEN** only that session is affected; other sessions continue normally

### Requirement: CLI control

Kill-switch operations SHALL be available via CLI.

#### Scenario: CLI trigger

- **GIVEN** the operator runs `opencode killswitch trigger --reason <text>`
- **WHEN** the CLI connects to the server (local or remote via `--attach`)
- **THEN** the trigger is processed identically to the API path

---

## Slice 1-E: Kill-switch UI 表面（pending）

### Requirement: Web Admin UI

The Web Admin panel SHALL provide a kill-switch control surface.

#### Scenario: operator uses Web Admin to trigger

- **GIVEN** an authenticated admin user on the Web Admin panel
- **WHEN** the user clicks the kill-switch button
- **THEN** a confirmation modal appears with reason field, snapshot toggle, and MFA input; upon confirmation the trigger API is called and real-time status is displayed

### Requirement: TUI integration

The TUI SHALL provide a kill-switch hotkey and confirmation flow.

#### Scenario: operator uses TUI hotkey

- **GIVEN** an operator in the TUI session
- **WHEN** the operator presses the kill-switch hotkey
- **THEN** a confirmation prompt appears; upon confirmation the trigger is sent and status indicator updates

---

## Slice 1-F: Kill-switch 基礎設施擴展（pending）

### Requirement: Redis control transport

The control transport layer SHALL support Redis pub/sub for multi-instance deployments.

#### Scenario: multi-instance kill-switch propagation

- **GIVEN** opencode is running on multiple instances behind a load balancer
- **WHEN** kill-switch is triggered on one instance
- **THEN** the Redis transport propagates the signal to all instances within 1 second

### Requirement: MinIO/S3 snapshot backend

The snapshot backend SHALL support object storage (MinIO/S3) for production deployments.

#### Scenario: snapshot upload to S3

- **GIVEN** `OPENCODE_MINIO_*` environment variables are configured
- **WHEN** a snapshot is generated
- **THEN** the snapshot is uploaded to the configured bucket with a signed URL (1-week expiry)

### Requirement: Security review sign-off

The kill-switch public API SHALL NOT be enabled in production without security team sign-off.

#### Scenario: pre-production gate

- **GIVEN** kill-switch implementation is code-complete
- **WHEN** deployment to production is requested
- **THEN** the deployment is blocked until security review task is marked as signed-off

---

## Slice 2: Trigger Model Extraction（pending）

### Requirement: Generic trigger model

系統 SHALL 抽取通用的 `RunTrigger` 抽象，將任務啟動從 session-local continuation 解耦。

#### Scenario: mission continuation 降階為 trigger source

- **GIVEN** 現有 `planAutonomousNextAction()` 的 14 種判斷全部耦合在 workflow-runner 中
- **WHEN** RunTrigger 介面實作完成
- **THEN** mission continuation 成為 `RunTrigger { type: "continuation" }` — 其中一種 trigger source

#### Scenario: API 直接觸發 run

- **GIVEN** 使用者想從 API 直接啟動一次 run（不透過 chat 訊息）
- **WHEN** 使用者 POST 到 trigger API 並帶上 session/payload
- **THEN** 系統建立 `RunTrigger { type: "api" }` 並走共用的 gate evaluation 路徑

#### Scenario: gate evaluation 共用

- **GIVEN** 任何類型的 RunTrigger 進入系統
- **WHEN** TriggerEvaluator 執行 gate evaluation
- **THEN** kill-switch gate 和 approval gate 對所有 trigger type 生效；mission gate 和 spec-dirty check 只對 continuation 型 trigger 生效

#### Scenario: approved mission gate 保留

- **GIVEN** 一個 `type: "continuation"` 的 RunTrigger
- **WHEN** session 沒有 approved mission（`mission.executionReady !== true`）
- **THEN** trigger 被拒絕，原因 `mission_not_approved`，行為與現行完全一致

#### Scenario: approval gate 保留

- **GIVEN** 任何類型的 RunTrigger 即將執行的 todo 帶有 `push` / `destructive` / `architecture_change` 標記
- **WHEN** `workflow.autonomous.requireApprovalFor` 包含該 gate type
- **THEN** trigger 被暫停等待人工核准，行為與現行 `approval_needed` stop reason 一致

#### Scenario: kill-switch 攔截所有 trigger

- **GIVEN** kill-switch 為 active 狀態
- **WHEN** 任何類型的 RunTrigger 嘗試進入 queue
- **THEN** trigger 被拒絕（409 KILL_SWITCH_ACTIVE），與現行 `assertSchedulingAllowed()` 行為一致

### Requirement: 新 trigger types 可插拔

系統 SHALL 支援新增 trigger type 而不需修改核心 evaluation 邏輯。

#### Scenario: 新增 cron trigger type

- **GIVEN** 開發者想新增 `type: "cron"` trigger
- **WHEN** 開發者實作 `RunTrigger { type: "cron", source: "scheduler", payload: { schedule, taskSpec } }`
- **THEN** 該 trigger 自動走共用 gate evaluation，不需修改 `TriggerEvaluator`

---

## Slice 3: Lane-aware Run Queue（pending）

### Requirement: 分道佇列

pending continuation queue SHALL 升級為帶優先級通道的通用 `RunQueue`。

#### Scenario: trigger 根據 priority 入隊

- **GIVEN** 一個 RunTrigger 通過 gate evaluation
- **WHEN** trigger 被轉為 QueueEntry
- **THEN** 系統根據 `trigger.priority` 分配到對應 lane（critical / normal / background）

#### Scenario: critical lane 優先消費

- **GIVEN** critical lane 有待處理 entry，normal lane 也有待處理 entry
- **WHEN** supervisor 執行 drain
- **THEN** critical lane 的 entry 先被消費

#### Scenario: lane 並發限制

- **GIVEN** normal lane 的 concurrency limit 是 4
- **WHEN** 已有 4 個 normal lane entry 在執行中
- **THEN** 新的 normal entry 等待，不會超過 cap

#### Scenario: workflow-runner 成為 queue consumer

- **GIVEN** workflow-runner 目前直接從 `listPendingContinuations()` 全掃
- **WHEN** RunQueue 實作完成
- **THEN** workflow-runner 改為從 `RunQueue.dequeue()` 取 entry，按 lane 優先級處理

#### Scenario: per-session 序列化保留

- **GIVEN** 同一 session 有多個 QueueEntry
- **WHEN** supervisor 嘗試同時處理它們
- **THEN** 同一 session 同一時間只有一個 entry 在執行（保留現有 `resumeInFlight` 語意）

#### Scenario: failure backoff 保留

- **GIVEN** 一個 QueueEntry 執行失敗，failure category 是 `provider_rate_limit`
- **WHEN** supervisor 下次嘗試該 entry
- **THEN** 遵循指數退避（`15s * 2^(step-1)`, max 5min），與現行行為一致

#### Scenario: kill-switch 阻擋 dequeue

- **GIVEN** kill-switch 為 active
- **WHEN** supervisor 嘗試 dequeue
- **THEN** 所有 lane 的 dequeue 被暫停（enqueue 仍可接受，但不消費）

---

## Deferred Slices（requires explicit approval to enter build）

### Slice D-1: Isolated job sessions
### Slice D-2: Heartbeat / wakeup substrate
### Slice D-3: Daemon lifecycle / host-wide scheduler health
