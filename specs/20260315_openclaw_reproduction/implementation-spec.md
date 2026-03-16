# Implementation Spec: openclaw_reproduction

## Goal

將 OpenClaw 對標研究與 scheduler substrate implementation planning 收斂為單一主計畫：以 OpenClaw 的 7x24 agent 控制面為 benchmark，為 opencode 制定並逐步實作一條可驗證的 reproduction 路線，讓 runner 從 session-local continuation engine 演進為 trigger-driven autonomous scheduler substrate。

## Scope

### IN

- OpenClaw 本地 `refs/openclaw` 架構 / control-plane 研究
- kill-switch 全生命週期（spec → backend → UI → security review → runbook）
- generic trigger model、lane-aware run queue 的 phased planning 與實作
- planner/runner/bootstrap contract 維護
- 相關 event / handoff / architecture sync authority

### OUT

- 本輪不直接做 full daemon rewrite
- 本輪不直接做 recurring scheduler persistence store
- 本輪不直接移植 OpenClaw channel-centric product features
- 本輪不新增 fallback mechanism
- 跨集群 multi-region replication

## Assumptions

- OpenClaw 的本地 code/doc 足以作為主要 benchmark 證據來源。
- 現有 autorunner 已具備 approved mission、todo-driven continuation、supervisor / lease / anomaly evidence。
- kill-switch 的 local transport + local snapshot 足以作為 Phase A-D 的交付基礎。
- Redis/MinIO 擴展可在後續 phase 獨立交付，不影響核心邏輯。

## Stop Gates

- 若 reproduction 提案需要引入 silent fallback、隱式 authority recovery、或違反 fail-fast 原則，必須停下並列為 rejected。
- 若實作需要直接擴張到 recurring scheduler persistence、daemon restart loop、或 host-wide worker lifecycle，必須先做 phase split 與 approval。
- 若 trigger / queue 抽象化會破壞現有 approved mission / approval / decision gate semantics，必須停下補 spec，不得邊做邊猜。
- kill-switch 公開 API 須通過安全審查（task `12-security-review`）方可啟用。
- 所有 API 單元測試、RBAC 驗證測試、E2E Web 路徑測試必須通過。

## Critical Files

### Specs

- `specs/20260315_openclaw_reproduction/{proposal,spec,design,implementation-spec,tasks,handoff}.md`
- `specs/20260316_kill-switch/{spec,design,implementation-spec,tasks,control-protocol,rbac-hooks,snapshot-orchestration}.md`

### Kill-switch Implementation

- `packages/opencode/src/server/killswitch/service.ts`
- `packages/opencode/src/server/routes/killswitch.ts`
- `packages/opencode/src/server/routes/session.ts` (scheduling gate)
- `packages/opencode/src/cli/cmd/killswitch.ts`
- `packages/app/src/components/settings-kill-switch.ts`
- `packages/opencode/src/server/event.ts` (KillSwitchChanged BusEvent)
- `packages/app/src/context/global-sync/event-reducer.ts` (SSE → store handler)
- `packages/app/src/context/global-sync/types.ts` (killswitch_status state)
- `packages/app/src/components/settings-general.tsx` (Web Admin UI: badge, confirmation, snapshot toggle)
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` (TUI Kill-Switch category)

### Tests

- `packages/opencode/src/server/killswitch/service.test.ts`
- `packages/opencode/src/server/routes/killswitch.test.ts`
- `packages/opencode/src/server/routes/session.killswitch-gate.test.ts`
- `packages/app/src/components/settings-kill-switch.test.ts`
- `packages/app/src/context/global-sync/event-reducer.test.ts`
- `packages/opencode/src/server/routes/killswitch.e2e.test.ts`

### Ops

- `specs/20260316_kill-switch/security-audit-checklist.md`
- `specs/20260316_kill-switch/runbook.md`

### Reference

- `refs/openclaw/docs/concepts/{agent-loop,queue,multi-agent}.md`
- `refs/openclaw/docs/automation/{cron-jobs,cron-vs-heartbeat}.md`
- `refs/openclaw/docs/cli/daemon.md`
- `refs/openclaw/src/cli/gateway-cli/run-loop.ts`
- `refs/openclaw/src/auto-reply/reply/{agent-runner,queue,queue-policy}.ts`
- `packages/opencode/src/session/{workflow-runner,system,todo}.ts`
- `docs/ARCHITECTURE.md`

---

## Structured Execution Phases

### Phase 0 — Consolidation & Benchmark（done）

- 合併 `openclaw_runner_benchmark` + `openclaw_scheduler_substrate` 為 `openclaw_reproduction`
- 完成 OpenClaw control-plane traits 提煉
- 分類：already-present / portable-next / substrate-heavy / incompatible
- 完成 planner/runner/bootstrap contract rewrite

### Phase 1 — Kill-switch Backend（done）

Deliverables: core service, API routes, RBAC+MFA, scheduling gate, soft/hard kill, snapshot, CLI, audit logging, tests.

- 1-spec: planner artifacts（implementation-spec, spec, design）✅
- 2-core-api: state store + API endpoints ✅
- 3-rbac-mfa: RBAC + MFA 整合 ✅
- 4-agent-check: agent startup / scheduler path check ✅
- 5-soft-kill: soft-pause signaling (local transport) ✅
- 6-hard-kill: timeout-driven force termination ✅
- 7-snapshot: snapshot generator + audit 寫入 ✅
- 8-cli: CLI commands (status/trigger/cancel) ✅
- 11-tests: unit + integration tests (13 tests passing) ✅

### Phase 2 — Kill-switch UI 表面（done）

Deliverables: Web Admin button/modal/status、TUI hotkey/confirmation、SSE real-time push。

- DD-1 resolved: SSE（codebase 100% SSE-native, zero WebSocket infrastructure）✅
- 9-web-ui: API integration, double-click confirmation, snapshot toggle, SSE-driven status, styled badge ✅
- 10-tui: Kill-Switch category in admin dialog (Status/Trigger/Cancel with DialogPrompt + DialogConfirm + MFA flow) ✅
- BusEvent wiring: `killswitch.status.changed` → Bus.publish → SSE → event-reducer → Solid.js store ✅
- Tests: 27 tests passing across 4 test files ✅

### Phase 3 — Kill-switch 基礎設施擴展（done）

Deliverables: Redis transport adapter、MinIO/S3 snapshot backend。

- redis-transport: `ioredis` dual-connection pub/sub — channels `ks:control:{sessionID}` / `ks:ack:{requestID}:{seq}`, lazy init, timeout race ✅
- minio-snapshot: `aws4fetch` AwsClient PUT to `{endpoint}/{bucket}/killswitch/snapshots/{requestID}.json`, error-resilient ✅
- Dependencies added: `ioredis@5.10.0`, `aws4fetch@1.0.20` ✅
- Tests: 34 tests passing across 5 test files ✅

### Phase 4 — Kill-switch 安全審查與運維（done）

Deliverables: security sign-off、E2E test、runbook + postmortem template。

- 12-security-review: 安全團隊 review 並 sign-off — audit checklist delivered ✅, **APPROVED** (2026-03-16) ✅
- e2e-web-test: 完整 UI → API → 狀態變更 → snapshot 端到端驗證 — 5 E2E tests passing ✅
- runbook: 運維手冊 + postmortem template — delivered ✅
- Tests: 39 tests passing across 6 test files ✅

### Phase 5 — Continuous Worker（5A done, 5B pending）

**核心痛點**：有完整 implementation spec + approved mission + tasks.md，AI 還是每一步都停下來問「要不要繼續」。

Deliverables: plan-trusting continuation mode、smart-runner-governor 降權、`maxContinuousRounds` 解除、從對話觸發持續執行。

#### 5A — Plan-trusting Continuation Mode（done）

**要解決的問題**：continuation 不夠 continuous。兩層攔截都沒有「信任 plan」模式：

```
第一層：planAutonomousNextAction()（確定性）
  └─ max_continuous_rounds → N 輪後強制停

第二層：handleSmartRunnerStopDecision()（LLM-based）
  └─ smart-runner-governor 每輪額外呼叫 LLM 判斷「要不要停」
  └─ 可覆蓋第一層的 "continue" 為 ask_user / pause_for_risk / replan_required / complete
```

**目標**：當 session 有 approved mission + executionReady + tasks.md 時，worker 按 plan 跑到底，只在真正的 blocker 才停。

**真正的 blocker（應該停）**：
- kill-switch active
- provider auth error / rate limit exhausted
- test failure（task 執行結果不符預期）
- approval gate（push / destructive / architecture_change）— 如果 requireApprovalFor 有設
- workflow.state === "blocked"
- todo_complete（全做完了）

**不該停的（plan-trusting mode 下應跳過）**：
- smart-runner-governor 的 `ask_user`（plan 已經有了，不需要再問）
- smart-runner-governor 的 `pause_for_risk`（plan 已被 approved，風險已評估）
- smart-runner-governor 的 `replan_required`（spec 沒變就不需要 replan）
- `max_continuous_rounds`（有 plan 時不應有輪數上限）

**影響的核心檔案**：
- `packages/opencode/src/session/prompt.ts` — `handleSmartRunnerStopDecision()` (L863-1045)：加入 plan-trusting 短路
- `packages/opencode/src/session/workflow-runner.ts` — `planAutonomousNextAction()` (L652-723)：plan-trusting mode 下移除 `max_continuous_rounds` 檢查
- `packages/opencode/src/session/smart-runner-governor.ts` — `getSmartRunnerConfig()`：加入 `planTrusting` flag

**實作步驟**（全部完成）：
- 5A.1 `isPlanTrusting()` helper — `workflow-runner.ts` ✅
- 5A.2 `planAutonomousNextAction()` plan-trusting bypass for `max_continuous_rounds` ✅
- 5A.3 `handleSmartRunnerStopDecision()` plan-trusting short-circuit — `prompt.ts` ✅
- 5A.4 `consumeMissionArtifacts()` tasks.md integrity 豁免（根因修復：tasks.md 改變是進度不是汙染）✅
- 5A.5 測試：84 tests passing across 3 test files ✅

#### 5B — Multi-source Trigger（P1：擴展性）

**要解決的問題**：目前啟動 run 只能透過 chat 訊息 → continuation。想讓不同 session 扮演不同角色（開發執行者、收信助手、YouTube 小編），需要多源觸發。

Deliverables: `RunTrigger` 介面定義、`TriggerEvaluator` gate evaluation、mission continuation 降階、新 trigger type scaffold。

**影響的核心檔案**：
- `packages/opencode/src/session/workflow-runner.ts` — 重構 `planAutonomousNextAction()` 為 `TriggerEvaluator`
- `packages/opencode/src/session/prompt.ts` — 重構 `enqueueAutonomousContinue()` 為通用 trigger → queue 路徑
- 新增 `packages/opencode/src/session/trigger.ts` — `RunTrigger` 型別定義 + `TriggerEvaluator`

**實作步驟**：
- 5B.1 定義 `RunTrigger` 介面（type, source, payload, priority, gatePolicy）
- 5B.2 提取 `TriggerEvaluator`：gate evaluation 從 `planAutonomousNextAction()` 分離
- 5B.3 Mission continuation 降階：改為 `RunTrigger { type: "continuation" }` 走通用路徑
- 5B.4 新增 `type: "api"` trigger scaffold + gate evaluation 驗證
- 5B.5 回歸測試：14 種 `ContinuationDecisionReason` 全部覆蓋，gate 語意不變

**Prerequisite**: 5A complete — continuation 先要能持續跑，多源觸發才有意義
**Stop gate**: 若 gate evaluation 重構破壞現有 approved mission / approval / decision gate 語意，必須停下

### Phase 6 — Lane-aware Run Queue（pending）

Deliverables: `RunQueue` 介面、lane policy、supervisor 重構、workflow-runner 改為 queue consumer。

**要解決的問題**：pending continuation queue 是簡單的 per-session key-value，supervisor 全掃無優先級，無法區分緊急/普通/背景任務。一旦有多個 worker（收信助手 + 開發者 + 小編），需要分道管理。

**影響的核心檔案**：
- `packages/opencode/src/session/workflow-runner.ts` — `ensureAutonomousSupervisor()` + `resumePendingContinuations()` 重構為 queue drain
- 新增 `packages/opencode/src/session/queue.ts` — `RunQueue` 介面 + lane 實作
- 新增 `packages/opencode/src/session/lane-policy.ts` — 並發限制、搶佔、overflow 策略

**實作步驟**：
- 6.1 定義 `RunQueue` 介面（enqueue, dequeue, peek, drain）+ `QueueEntry` 型別
- 6.2 實作三道 lane：critical（cap 2）, normal（cap 4）, background（cap 2）
- 6.3 遷移 `enqueuePendingContinuation()` → `RunQueue.enqueue()`，保留 lease + failure state
- 6.4 重構 supervisor：從全掃改為 `RunQueue.drain()` 按 lane 優先級消費
- 6.5 測試：lane policy enforcement、per-session 序列化、failure backoff、kill-switch 阻擋 dequeue

**Prerequisite**: Phase 5 complete — `RunTrigger` 介面必須先定義，queue 才能根據 trigger type 分配 lane

### Deferred Phases（requires explicit approval）

- Phase D-1: Isolated job sessions
- Phase D-2: Heartbeat / wakeup substrate
- Phase D-3: Daemon lifecycle / host-wide scheduler health

---

## Validation

- Benchmark evidence must cite concrete local OpenClaw code/doc traits
- Plan must distinguish portable vs substrate-heavy vs incompatible
- Kill-switch: acceptance criteria from `specs/20260316_kill-switch/implementation-spec.md`
  1. Authorized user POSTs trigger → returns accepted + request_id + snapshot_url
  2. After trigger: new tasks rejected, existing tasks enter graceful window, status readable
  3. After soft_timeout: remaining tasks forcefully terminated, audit contains final state + snapshot
  4. Audit entries recorded for trigger/cancel with required fields
- Trigger model: unit/regression/integration validation for RunTrigger changes
- Queue: validation for lane policy enforcement and orchestrator dispatch
- Architecture docs must express planner authority vs trigger authority separation

## Handoff

- This package is the single planning authority for OpenClaw-aligned runner reproduction work.
- Old `openclaw_runner_benchmark` and `openclaw_scheduler_substrate` packages are reference history only.
- `specs/20260316_kill-switch/` is the implementation detail reference for Slice 1.
- Build agent must read `tasks.md` before coding; runtime todo must be materialized from `tasks.md`.
- Next build entry: Phase 5 (Trigger Model Extraction) → Phase 6 (Lane-aware Run Queue). Requires explicit user approval per stop gate #2.
