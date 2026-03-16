# Design: openclaw_reproduction

## Context

- 先前存在兩個 `openclaw*` plan，已合併為單一主計畫。
- 2026-03-16：kill-switch 控制面 Phase A-D 已交付，成為本計畫第一個具體實作切片。
- 計畫現進入 UI 表面、基礎設施擴展、與後續 Trigger/Queue 切片階段。

## Consolidation Strategy

- 保留 benchmark findings，內化到單一主計畫。
- 保留 scheduler substrate 的 build entry slice。
- 舊 plan 保留作 reference history，避免破壞可追溯性。
- kill-switch 子 specs（`specs/20260316_kill-switch/`）保留作實作細節參考，authority 歸本計畫。

## Consolidated Conclusions

### OpenClaw traits worth learning

- always-on gateway / daemon
- lane-aware queue
- heartbeat / cron as first-class trigger sources
- isolated autonomous job sessions
- restart / drain / host observability lifecycle

### Opencode already has

- approved mission gate
- todo-driven continuation
- pending continuation queue
- supervisor / lease / retry / anomaly evidence
- explicit approval / decision / blocker gates

### Portable next

- generic trigger model（Slice 2）
- lane-aware run queue（Slice 3）
- workflow-runner as generic orchestrator

### Deferred later

- isolated jobs
- heartbeat / wakeup substrate
- daemon lifecycle / host-wide scheduler health

---

## Slice 1 Design: Kill-switch 控制面

### Architecture

```
Operator ──▶ Web Admin UI / TUI / CLI
                    │
                    ▼
            API Layer (Hono)
            POST /api/v2/admin/kill-switch/trigger
            POST /api/v2/admin/kill-switch/cancel
            POST /api/v2/admin/kill-switch/status
            POST /api/v2/admin/kill-switch/tasks/:sessionID/control
                    │
                    ▼
            ┌─────────────────────┐
            │  KillSwitchService  │
            │  - State management │
            │  - MFA verification │
            │  - Audit logging    │
            │  - Snapshot trigger  │
            └────────┬────────────┘
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
    Control       State       Snapshot
    Transport     Store       Backend
    (Local/Redis) (Memory)   (Local/MinIO)
```

### State Model

- States: `inactive` → `soft_paused` → `hard_killed` → `inactive`（cancel）
- State key: JSON object with `active`, `initiator`, `reason`, `initiated_at`, `mode`, `scope`, `ttl`, `snapshot_url`
- Cooldown: 5s per operator; Idempotency: 10s window for same initiator+reason

### Control Protocol

- Sequence number + ACK model（monotonic per-session）
- Events: task_started, task_progress, task_completed, task_failed, task_heartbeat
- Controls: pause, resume, cancel, snapshot, set_priority
- ACK timeout: 5s → fallback to force-cancel via `SessionPrompt.cancel()`

### Soft vs Hard Kill

- **Soft**: mark state → reject new tasks (409) → send graceful-shutdown signal via control channel
- **Hard**: after `soft_timeout` → force-terminate remaining workers → write final audit

### Snapshot Orchestration

- Async job: collects system logs (1000 lines), active sessions, outstanding tasks, provider usage
- Storage: local (default) or MinIO/S3 (via env)
- Signed URLs with 1-week expiry
- Non-blocking on failure（audit logs the failure reason）

### RBAC Model

- `kill_switch:trigger`: global kill（requires MFA）
- `task:control`: per-session control（no MFA required）
- All actions logged to audit trail

### Delivered Files (Phase A-D)

- `packages/opencode/src/server/killswitch/service.ts` — core service
- `packages/opencode/src/server/routes/killswitch.ts` — API routes
- `packages/opencode/src/cli/cmd/killswitch.ts` — CLI commands
- `packages/app/src/components/settings-kill-switch.ts` — frontend helpers
- Tests: `service.test.ts`, `killswitch.test.ts`, `session.killswitch-gate.test.ts`, `settings-kill-switch.test.ts`

### Real-time Status Push Pattern（DD-1 resolved: SSE）

Codebase 100% SSE-native（`streamSSE` from Hono），無 WebSocket 基礎設施。Kill-switch 即時狀態推送複用現有 Bus → SSE pipeline：

```
KillSwitchService.setState() / clearState()
  → Bus.publish(Event.KillSwitchChanged, state)
    → SSE stream at /api/v2/event
      → event-reducer.ts case "killswitch.status.changed"
        → store.killswitch_status = reconcile(state)
```

關鍵檔案：
- `packages/opencode/src/server/event.ts` — 定義 `KillSwitchChanged` BusEvent
- `packages/opencode/src/server/killswitch/service.ts` — 在狀態變更後 Bus.publish
- `packages/app/src/context/global-sync/event-reducer.ts` — 前端 reducer handler
- `packages/app/src/context/global-sync/types.ts` — store 新增 `killswitch_status` 欄位

### Design Decisions

| ID | Decision | Options | Status |
|----|----------|---------|--------|
| DD-1 | 即時狀態推送機制 | SSE vs WebSocket | **resolved: SSE** — codebase 100% SSE-native |
| DD-2 | MFA 整合方式 | 複用現有系統 vs 新建 | pending — scaffolding 已有 generateMfa/verifyMfa |
| DD-3 | Snapshot timing vs hard-kill window | 固定 soft_timeout vs 動態延展 | pending |

---

## Slice 2 Design: Continuous Worker（pending）

### 2A — Plan-trusting Continuation Mode（P0：核心痛點）

#### 問題陳述

有完整 implementation spec + approved mission + tasks.md，AI 還是每一步都停下來問「要不要繼續」。

原因是 continuation 有**兩層攔截**，都沒有「信任 plan」模式：

```
prompt.ts 主迴圈
  │
  ├─ 第一層：planAutonomousNextAction()（確定性，workflow-runner.ts L652-723）
  │     ├─ subagent_session → stop（合理）
  │     ├─ autonomous_disabled → stop（合理）
  │     ├─ mission_not_approved → stop（合理）
  │     ├─ blocked → stop（合理）
  │     ├─ approval_needed → stop（合理）
  │     ├─ product_decision_needed → stop（合理）
  │     ├─ wait_subagent → stop（合理）
  │     ├─ todo_complete → stop（合理）
  │     ├─ max_continuous_rounds → stop ← 有 plan 時不該有輪數上限
  │     └─ todo_pending / todo_in_progress → continue ✓
  │
  └─ 第二層：handleSmartRunnerStopDecision()（LLM-based，prompt.ts L863-1045）
        └─ 呼叫 smart-runner-governor（generateObject）做二次判斷
        └─ 可覆蓋第一層的 "continue" 為：
             ├─ ask_user → stop ← plan 已有，不需要再問
             ├─ pause_for_risk → stop ← plan 已被 approved，風險已評估
             ├─ replan_required → stop ← spec 沒變就不需要 replan
             ├─ complete → stop ← 應該信任 todo_complete 而不是 LLM 判斷
             └─ continue → 真正繼續 ✓
```

#### 目標：Plan-trusting Mode

當 session 滿足以下條件時，進入 plan-trusting mode：
- `mission.executionReady === true`
- `mission.contract === "implementation_spec"`
- `mission.source === "openspec_compiled_plan"`
- spec 檔案未被修改（hash 比對或 mtime 比對）

Plan-trusting mode 下的行為：

| 攔截點 | 正常模式 | Plan-trusting mode |
|--------|---------|-------------------|
| `max_continuous_rounds` | N 輪後停 | **跳過**（plan 控制進度，不需輪數限制）|
| smart-runner-governor `ask_user` | 停下問人 | **跳過**（plan 已有，不需再問）|
| smart-runner-governor `pause_for_risk` | 停下怕風險 | **跳過**（plan 已被 approved）|
| smart-runner-governor `replan_required` | 停下重新規劃 | **跳過，除非 spec dirty**（spec 沒變就不需要 replan）|
| smart-runner-governor `complete` | 停下說做完了 | **改用 todo_complete 判斷**（信任 todo 狀態而不是 LLM）|
| kill-switch | 停 | **不變**（blocker）|
| approval_needed | 停 | **不變**（blocker，如果 requireApprovalFor 有設）|
| blocked / provider error | 停 | **不變**（blocker）|
| todo_complete | 停 | **不變**（真的做完了）|

#### 關鍵檔案

- `packages/opencode/src/session/prompt.ts` — `handleSmartRunnerStopDecision()` (L863-1045)：加入 plan-trusting 短路
- `packages/opencode/src/session/workflow-runner.ts` — `planAutonomousNextAction()` (L652-723)：plan-trusting mode 下跳過 `max_continuous_rounds`
- `packages/opencode/src/session/smart-runner-governor.ts` — `getSmartRunnerConfig()` (L1135)：加入 `planTrusting` flag
- `packages/opencode/src/session/mission-consumption.ts` — plan-trusting 條件判斷

### 2B — Multi-source Trigger（P1：擴展性）

#### 問題陳述

目前啟動 run 只能透過 chat 訊息 → continuation。想讓不同 session 扮演不同角色（開發執行者、收信助手、YouTube 小編），需要多源觸發。

#### 目標架構

```
RunTrigger { type, source, payload, priority, gatePolicy }
  ├─ type: "continuation"  → 現有 mission continuation（降階為 trigger source 之一）
  ├─ type: "api"           → API 直接觸發（POST /api/v2/trigger）
  ├─ type: "cron"          → 定時排程
  ├─ type: "webhook"       → 外部事件觸發
  └─ type: "replay"        → 佇列重放

TriggerEvaluator
  ├─ evaluateGates(trigger) → 根據 gatePolicy 判斷是否放行
  │     ├─ mission gate（只有 continuation 型 trigger 需要）
  │     ├─ approval gate（所有 trigger 共用）
  │     ├─ kill-switch gate（所有 trigger 共用）
  │     └─ custom gates（per-trigger 可擴展）
  └─ toQueueEntry(trigger) → 轉為 queue entry（銜接 Phase 6）
```

#### 必須保留的語意（不可破壞的 gate）

| Gate | 現有位置 | 保留方式 |
|------|---------|---------|
| approved mission | `planAutonomousNextAction()` L667-673 | continuation trigger 專屬 gate |
| approval gate (push/destructive/arch) | `detectApprovalGate()` L272-319 | 共用 gate，所有 trigger type 適用 |
| decision gate | `planAutonomousNextAction()` L698-701 | 共用 gate |
| kill-switch scheduling gate | `assertSchedulingAllowed()` | 共用 gate，不可繞過 |

#### 使用者 vision

```
opencode
  ├─ 對話 session（shell）── 永遠可互動
  ├─ worker: 開發計畫執行者（按 implementation spec 跑 tasks）
  ├─ worker: 收信助手（watch email, summarize, reply）
  ├─ worker: YouTube 小編（draft scripts, schedule posts）
  └─ worker: ...任何持續性任務
```

#### 設計決定待定

| ID | 決定 | 選項 | 影響 |
|----|------|------|------|
| DD-4 | RunTrigger 是 interface 還是 discriminated union | interface + type field vs Zod discriminated union | 影響序列化和驗證 |
| DD-5 | Gate evaluation 是同步還是異步 | 同步（current） vs 異步（支援遠端 gate） | 影響 API trigger latency |
| DD-6 | Trigger 的 persistence | 記憶體 vs Storage | 影響重啟後 replay 能力 |

---

## 跨切片設計議題：Worker 呈現與對話並行

### 核心模型：Unix Process Model

採用 Linux multi-process 架構作為設計類比：

```
Terminal（shell）── 永遠可輸入，不被任何 process 佔住
  ├─ command &          → 丟到背景跑（background worker）
  ├─ jobs / ps          → 列出正在跑的 process
  ├─ fg %1              → 把背景 process 拉到前景（看它的輸出）
  ├─ kill %1            → 停掉特定 process
  ├─ kill -9 / shutdown → kill-switch（全停）
  ├─ top                → 即時 dashboard
  └─ crontab            → 排程觸發
```

### 對應關係

| Unix 概念 | opencode 對應 | 說明 |
|-----------|--------------|------|
| Terminal / Shell | 對話 session | 永遠可輸入，不被 worker 佔住 |
| Process | Worker（一次 run） | 有 worker ID，可在背景執行 |
| PID | Worker ID | 用於 jobs/kill/fg 的識別 |
| `command &` | trigger → background | trigger 送出後 worker 在背景跑 |
| `jobs` / `ps` | `/workers` | 列出所有 active worker |
| `fg %1` | `/attach <id>` | 把 worker 輸出串流到對話中 |
| `kill %1` | `/kill <id>` | 停掉特定 worker |
| `kill -9` / `shutdown` | kill-switch | 全域停止 |
| `top` | worker dashboard | sidebar 或狀態列，即時顯示 |
| `crontab` | cron trigger | 排程觸發 |
| stdout/stderr | worker 的 assistant 輸出 | 背景時靜默，fg 時串流到對話 |
| exit code | worker 完成狀態 | done / failed / killed |

### 設計原則

1. **Terminal ≠ Process** — 對話 session 是 shell，不是 process。現有的「1 session = 1 對話 = 1 worker」必須拆開。
2. **背景是預設** — trigger 產生的 worker 預設在背景跑，不佔住對話。使用者可以隨時 attach 看輸出。
3. **從對話框操作** — 所有 worker 管理透過對話輸入（slash command 或自然語言），不需要另開控制面板。
4. **Dashboard 是 `top`** — sidebar / status bar 是被動顯示，不是互動入口。互動永遠從對話框。

### 架構影響

| 面向 | 現有架構 | Unix Process Model |
|------|---------|-------------------|
| Session 對應 | 1 session = 1 對話 = 1 worker | shell session（對話）+ N worker processes |
| 對話佔用 | assistant 回覆期間，對話被鎖 | 對話永遠可輸入（worker 在背景） |
| Worker 輸出 | 直接寫入對話 message stream | 背景：寫入 worker log；`fg` 時：串流到對話 |
| 狀態顯示 | 最後一條 assistant 訊息 | `top`-like dashboard（sidebar / status bar） |
| 干預方式 | kill-switch 或等結束 | `/kill <id>`、`/pause <id>`、kill-switch |

### 設計決定

| ID | 決定 | 選項 | 狀態 |
|----|------|------|------|
| DD-10 | Shell session 與 worker 的分離方式 | (a) 對話 session 保持現有 schema，worker 是獨立的輕量 entity (b) worker 本身是 sub-session (c) worker 是新的 first-class entity，跟 session 平行 | pending |
| DD-11 | Worker 輸出的儲存與串流 | (a) Worker 輸出寫入獨立 log，`fg` 時 SSE 串流到對話 (b) Worker 輸出寫入對話 message 但標記為 background (c) 混合 | pending |
| DD-12 | Dashboard 呈現 | (a) TUI status bar + Web sidebar (b) 對話窗內浮動 overlay (c) 都支援，使用者可切換 | pending |

### 階段建議

- **Phase 5（backend）**：RunTrigger 介面 + gate evaluation 重構。不動 UI，但 worker 的資料模型要預留 shell/process 分離。
- **Phase 6（backend）**：RunQueue + lane policy。supervisor 可以多 worker 並行消費。Worker entity 的 CRUD 在這裡落地。
- **Phase 7（UI）**：worker dashboard + `/workers` + `/kill` + `/attach` 的 UI 呈現。DD-10~12 必須在此之前決定。

理由：backend 先落地讓 trigger 解耦和 queue 分道可以跑測試驗證；UI 的 shell/process 分離牽扯面更廣，值得獨立規劃。但 Phase 5/6 的資料模型設計**必須預見** Phase 7 的需求，不能到時候才發現 schema 不夠用。

---

## Slice 3 Design: Lane-aware Run Queue（pending）

### 問題陳述

目前的 pending continuation queue 是簡單的 per-session key-value（`Storage["session_workflow_queue"]`），supervisor 每 5 秒全掃一遍，先到先做。問題：

- 沒有優先級：緊急修復和背景任務排同一條隊
- 沒有並發控制（lane 層級）：只有 per-session 的 `resumeInFlight` Set
- supervisor 是全局單例，擴展性受限

### 現有架構（要改的部分）

```
Storage["session_workflow_queue", sessionID] → PendingContinuationInfo
  └─ { sessionID, messageID, createdAt, roundCount, reason, text }

ensureAutonomousSupervisor() — 5s 輪詢
  └─ resumePendingContinuations()
       └─ listPendingContinuations() → 全掃
            └─ 逐個 resume（per-session 鎖 via resumeInFlight Set）
```

### 目標架構（參考 OpenClaw queue.md）

```
RunQueue
  ├─ lanes:
  │     ├─ critical  — kill-switch recovery, approval responses（cap: 2）
  │     ├─ normal    — mission continuation, API triggers（cap: 4）
  │     └─ background — cron, webhook, replay（cap: 2）
  │
  ├─ enqueue(entry: QueueEntry) → 根據 trigger.priority 分配 lane
  ├─ dequeue(lane?) → 取最高優先級 lane 的下一個 entry
  ├─ peek() → 查看各 lane 狀態
  └─ drain() → supervisor 呼叫，按 lane 優先級消費

QueueEntry
  ├─ trigger: RunTrigger（來自 Phase 5）
  ├─ sessionID: string
  ├─ lane: "critical" | "normal" | "background"
  ├─ enqueuedAt: number
  ├─ lease: { owner, expiresAt, retryAt }（保留現有 lease 機制）
  └─ failureState: { count, category, backoffUntil }（保留現有 failure classification）

LanePolicy
  ├─ concurrencyLimit: per-lane 最大同時執行數
  ├─ preemption: critical 可搶佔 background 的 slot
  └─ overflow: 超過 cap 時的行為（reject / wait / spill to next lane）
```

### 必須保留的機制

| 機制 | 現有位置 | 保留方式 |
|------|---------|---------|
| per-session 序列化 | `resumeInFlight` Set | QueueEntry 層級的 session lock |
| lease backpressure | `leaseOwner`, `leaseExpiresAt` | 移入 QueueEntry.lease |
| failure classification | `ResumeFailureCategory` 6 種 | 移入 QueueEntry.failureState |
| exponential backoff | `15s * 2^(step-1)`, max 5min | 保留公式，per-entry |
| kill-switch 檢查 | `assertSchedulingAllowed()` | dequeue 時檢查（非 enqueue 時） |

### 設計決定待定

| ID | 決定 | 選項 | 影響 |
|----|------|------|------|
| DD-7 | Queue persistence | 記憶體 vs Storage vs Redis | 重啟後 queue 是否保留 |
| DD-8 | Supervisor 架構 | 單一輪詢 vs per-lane consumer | 擴展性 |
| DD-9 | Preemption 策略 | hard preempt（kill background run）vs soft（等 slot 釋放） | 使用者體驗 |

---

## OpenClaw 參考對照

| OpenClaw 概念 | opencode 現狀 | Phase 5/6 目標 |
|--------------|--------------|---------------|
| 多源觸發（steer/followup/collect/interrupt） | 只有 continuation | RunTrigger 多型 |
| per-session lane + global lane | per-session 鎖，無 global lane | RunQueue 三道 lane |
| queue dedup + debounce | 無 | QueueEntry dedup（Phase 6） |
| queue-policy.ts resolveAction | planAutonomousNextAction() | TriggerEvaluator.evaluateGates() |
| agent-runner.ts | workflow-runner.ts | workflow-runner 改為 queue consumer |

---

## Risks

- ~~若 kill-switch UI 使用 SSE 推送，需先解決 ghost responses 的 SSE 問題~~ — Phase 2 已交付，SSE 穩定
- ~~Redis transport 需確認 multi-instance pub/sub 的 message ordering guarantee~~ — Phase 3 已交付
- Trigger model extraction 若破壞現有 approved mission gate semantics，必須停下補 spec
- 若太早把 deferred slices 混進 build，會重新掉入 full scheduler complexity
- Phase 5 的 `planAutonomousNextAction()` 重構涉及 14 種判斷路徑，測試覆蓋必須完整
- Phase 6 的 queue persistence 選擇影響重啟行為，需要 DD-7 先決定
