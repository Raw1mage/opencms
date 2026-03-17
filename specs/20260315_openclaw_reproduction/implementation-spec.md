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
- ~~本輪不直接移植 OpenClaw channel-centric product features~~ — channel 概念已取消 (2026-03-17)，改為 channel-to-workspace refactor
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

### Phase 5 — Continuous Worker（done）

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

#### 5B — Multi-source Trigger（done）

Deliverables: `RunTrigger` 介面定義、`TriggerEvaluator` gate evaluation、mission continuation 降階、新 trigger type scaffold。

- `session/trigger.ts`: RunTrigger union (Continuation | Api), TriggerGatePolicy, evaluateGates(), buildContinuationTrigger(), buildApiTrigger() ✅
- `workflow-runner.ts`: planAutonomousNextAction() refactored to delegate to trigger system, evaluateTriggerGates() generic entry point ✅
- API trigger scaffold: API_GATE_POLICY (respectMaxRounds=false), buildApiTrigger() ✅
- Tests: 83 tests passing (51 existing + 32 new trigger/gate tests) ✅
- Stop gate verified: all 14 ContinuationDecisionReasons produce identical results ✅

### Phase 6 — Lane-aware Run Queue（done）

Deliverables: `RunQueue` 介面、lane policy、supervisor 重構、workflow-runner 改為 queue consumer。

**要解決的問題**：pending continuation queue 是簡單的 per-session key-value，supervisor 全掃無優先級，無法區分緊急/普通/背景任務。一旦有多個 worker（收信助手 + 開發者 + 小編），需要分道管理。

**影響的核心檔案**：
- `packages/opencode/src/session/workflow-runner.ts` — `ensureAutonomousSupervisor()` + `resumePendingContinuations()` 重構為 queue drain
- 新增 `packages/opencode/src/session/queue.ts` — `RunQueue` 介面 + lane 實作
- 新增 `packages/opencode/src/session/lane-policy.ts` — 並發限制、搶佔、overflow 策略

- `session/queue.ts`: RunQueue namespace — enqueue/remove/peek/listLane/listAll/drain/countByLane, QueueEntry Zod schema ✅
- `session/lane-policy.ts`: 3 lanes (critical cap 2, normal cap 4, background cap 2), triggerPriorityToLane(), laneHasCapacity() ✅
- `enqueuePendingContinuation()` → delegates to `RunQueue.enqueue()`, legacy key backward compat ✅
- `clearPendingContinuation()` → delegates to `RunQueue.remove()` (all lanes + legacy) ✅
- `listPendingContinuations()` → reads from RunQueue with legacy fallback ✅
- `RunQueue.drain()` respects per-lane concurrency caps and preferred session ✅
- Tests: 99 tests passing (83 Phase 5B + 16 Phase 6) ✅

### Stage 3 — Isolated Jobs + Heartbeat + Daemon Lifecycle（D.1-D.3）

IDEF0 functional decomposition and GRAFCET state machines: `specs/20260315_openclaw_reproduction/diagrams/`

#### Phase 8 — Isolated Job Sessions（D.1）

Deliverables: scoped session key namespace, CronSessionTarget factory, lightContext bootstrap, cron job store, delivery routing, session retention reaper, run-log JSONL.

IDEF0 reference: A1 (Manage Isolated Job Sessions) → A11-A14
GRAFCET reference: opencode_a1_grafcet.json (Session Lifecycle)
OpenClaw benchmark: `refs/openclaw/src/cron/types.ts`, `refs/openclaw/src/cron/isolated-agent/session.ts`

- 8a. **Session Key Namespace** — `cron:<jobId>:run:<uuid>` for isolated sessions, `agent:<agentId>:main` for main sessions. Session.create() extended with optional `keyNamespace` parameter.
- 8b. **Cron Job Store** — `~/.config/opencode/cron/jobs.json` with Zod schema. CronJobState tracks nextRunAtMs, runningAtMs, lastRunStatus, consecutiveErrors, lastErrorReason. CRUD: create/read/update/delete/list.
- 8c. **Light Context Bootstrap** — `lightContext: true` skips workspace file injection. Cron-prefixed system prompt with minimal token footprint. Reuses existing Session.create() + system prompt registry.
- 8d. **Delivery Routing** — announce (post to main session) / webhook (HTTP POST with bearer auth) / none. Per-job config. Chunking per channel format rules.
- 8e. **Session Retention and Run-log** — Reaper prunes by `cron.sessionRetention` (default 24h). Run-log JSONL at `~/.config/opencode/cron/runs/<jobId>.jsonl`, auto-pruned at 2MB + 2000 lines.

#### Phase 9 — Heartbeat / Wakeup Substrate（D.2）

Deliverables: schedule expression engine (at/every/cron), active hours gating, system event queue, HEARTBEAT_OK suppression, wake mode dispatch, throttle integration.

IDEF0 reference: A2 (Schedule Trigger Evaluation) → A21-A24
GRAFCET reference: opencode_a2_grafcet.json (Heartbeat Supervision)
OpenClaw benchmark: `refs/openclaw/src/infra/heartbeat-runner.ts`, `refs/openclaw/src/infra/system-events.ts`, `refs/openclaw/docs/automation/cron-vs-heartbeat.md`

- 9a. **Schedule Expression Engine** — 3 kinds: `at` (one-shot ISO timestamp), `every` (interval string "30m"), `cron` (5/6-field with IANA timezone). Deterministic stagger: top-of-hour offset up to 5min by job ID hash, `--stagger` override, `--exact` bypass.
- 9b. **Active Hours Gating** — `activeHours: { start: "HH:MM", end: "HH:MM" }`. Suppress triggers outside window. Compute next eligible fire time when suppressed.
- 9c. **System Event Queue** — In-memory FIFO per session key, max 20 events. `enqueueSystemEvent(text, { sessionKey, contextKey? })` / `drainSystemEventEntries(sessionKey)`. Events injected into heartbeat prompt.
- 9d. **HEARTBEAT_OK Suppression** — Execute heartbeat checklist from HEARTBEAT.md. If no actionable content → emit HEARTBEAT_OK token, suppress delivery. Prevents empty heartbeat noise.
- 9e. **Wake Mode Dispatch** — `"now"`: immediate agent turn via RunTrigger. `"next-heartbeat"`: event enqueued and batched until next scheduled heartbeat. Integrates with AutonomousPolicy throttle governor (cooldown/budget/escalation).

#### Phase 10 — Daemon Lifecycle / Host-wide Scheduler Health（D.3）

Deliverables: gateway lock, signal dispatch, drain state machine, command lane queue, restart loop, generation numbering, lane reset, health endpoint.

IDEF0 reference: A3 (Supervise Daemon Lifecycle) → A31-A35, A4 (Govern Command Lane Execution) → A41-A44, A5 (Emit Host Observability Events)
GRAFCET reference: opencode_a3_grafcet.json (Daemon Lifecycle)
OpenClaw benchmark: `refs/openclaw/src/cli/gateway-cli/run-loop.ts`, `refs/openclaw/src/process/command-queue.ts`

- 10a. **Gateway Lock** — `acquireGatewayLock()` / `releaseLockIfHeld()` via port-based or file-based lock. Prevents multiple daemon instances. Release on shutdown, reacquire on in-process restart.
- 10b. **Signal Dispatch** — SIGTERM/SIGINT → graceful shutdown (SHUTDOWN_TIMEOUT_MS=5s). SIGUSR1 → in-process restart with authorization check. Signal → lifecycle state transition mapping.
- 10c. **Drain State Machine** — `markGatewayDraining()` → set draining flag → reject new enqueues with `GatewayDrainingError` → abort in-flight compaction → wait for active tasks + embedded runs (DRAIN_TIMEOUT_MS=90s) → proceed to shutdown or restart.
- 10d. **Command Lane Queue** — 4 lanes: Main (maxConcurrent=1), Cron (1), Subagent (2), Nested (1). Per-session lanes `session:<key>` for single-threaded execution. Global lane caps overall parallelism. `enqueueCommandInLane<T>()`, `getActiveTaskCount()`, `waitForActiveTasks(timeoutMs)`.
- 10e. **Restart Loop** — Try `restartGatewayProcessWithFreshPid()` (full respawn, better for TCC permissions). Fallback to in-process restart if `OPENCLAW_NO_RESPAWN`. Close HTTP server with `close(reason, restartExpectedMs)`. Loop back to server start.
- 10f. **Generation & Recovery** — Increment `generation` on restart. Stale task completions from previous generation silently ignored. `resetAllLanes()` clears activeTaskIds, bumps generation, re-drains queued entries. `Daemon.info()` exposes session count + lane sizes + generation via health endpoint.

### Stage 4 — Channel-to-Workspace Refactor

**Architectural pivot (2026-03-17)**: Channel is a redundant abstraction that duplicates workspace's role as runtime scope. Both are invisible to the user. Channel's useful features (lane isolation via lanePolicy, kill-switch scope) are refactored into workspace. Channel module is then deleted entirely. Previous Stages B/C/D (channel E2E, channel UI, channel extensions) are cancelled and replaced by this refactoring.

Rationale: workspace already auto-resolves from directory, tracks all attachments (sessions, ptys, workers), and has lifecycle management. Adding lanePolicy + killSwitchScope to workspace covers all channel use cases without a separate module.

Mental model: Project → Workspace (runtime scope with resource control) → Session (one auto runner doing one thing)

#### Phase 11 — Extend Workspace Schema（4.1）

Deliverables: WorkspaceAggregate extended with lanePolicy and killSwitchScope.

- 11a. **LanePolicy on Workspace** — add `lanePolicy: LanePolicySchema` to WorkspaceAggregate with default `{ main: 1, cron: 1, subagent: 2, nested: 1 }`. Move LanePolicySchema from channel/types.ts to workspace/types.ts.
- 11b. **KillSwitchScope on Workspace** — add `killSwitchScope: z.enum(["workspace", "global"])` with default "global". Enum value changes from "channel" to "workspace".
- 11c. **Resolver Defaults** — set defaults in buildRootWorkspace, buildSandboxWorkspace, buildDerivedWorkspace.

#### Phase 12 — Migrate Lanes Module（4.2）

Deliverables: Lanes module uses workspaceId instead of channelId.

- 12a. **API Rename** — registerChannel → registerWorkspace, ChannelLaneConfig → WorkspaceLaneConfig, channelId → workspaceId in all function signatures.
- 12b. **Composite Key Migration** — buildLaneKey(channelId, lane) → buildLaneKey(workspaceId, lane), parseLaneKey updated.
- 12c. **Daemon Boot** — replace ChannelStore.restoreOrBootstrap() with workspace-based lane registration. Resolve workspaces for known project directories; register default lanes as fallback.

#### Phase 13 — Migrate KillSwitch Service（4.3）

Deliverables: KillSwitch uses workspaceId instead of channelId for scoping.

- 13a. **State Schema** — replace channelId with workspaceId in KillSwitch.State.
- 13b. **Scheduling Gate** — assertSchedulingAllowed(channelId?) → assertSchedulingAllowed(workspaceId?).
- 13c. **Busy Session Filter** — listBusySessionIDs resolves workspace from session.directory via workspace registry instead of matching session.channelId. Registry lookup is in-memory O(1).
- 13d. **Routes** — kill-switch /trigger endpoint: channelId → workspaceId in body schema.

#### Phase 14 — Remove Channel from Session（4.4）

Deliverables: Session.Info no longer carries channelId.

- 14a. **Schema Change** — remove channelId from Session.Info zod schema.
- 14b. **Backward Compat** — Zod strips unknown fields; persisted sessions with channelId load without error.
- 14c. **Creation Code** — remove any session creation code that sets channelId.

#### Phase 15 — Delete Channel Module（4.5）

Deliverables: Channel module and all references removed from codebase.

- 15a. **Delete Module** — rm packages/opencode/src/channel/ (types.ts, store.ts, index.ts).
- 15b. **Delete Routes** — rm channel API route file, remove route registration from server setup.
- 15c. **Remove Imports** — clean up channel imports from daemon/index.ts and any other consumers.
- 15d. **Grep Sweep** — verify no channelId/ChannelStore references remain in production code.

#### Phase 16 — Rewrite Tests（4.6）

Deliverables: All tests pass with workspace-based scoping; no channel test artifacts remain.

- 16a. **Lanes Tests** — rewrite lanes.test.ts: per-channel → per-workspace isolation.
- 16b. **KillSwitch Tests** — rewrite killswitch service.test.ts: channel-scoped → workspace-scoped.
- 16c. **Delete Channel Tests** — rm channel store.test.ts, channel API tests, E2E channel-integration.test.ts.
- 16d. **New E2E** — workspace-integration.test.ts: workspace-scoped lane isolation + kill-switch E2E.
- 16e. **Schema Tests** — workspace schema validation tests for lanePolicy + killSwitchScope.
- 16f. **Final Verification** — `bun test` all green, grep for channelId/ChannelStore returns zero hits.

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
- **Stage 4**: channel-to-workspace refactor complete — workspace has lanePolicy + killSwitchScope, lanes use workspaceId, kill-switch scopes to workspace, channel module deleted, all tests pass, zero channelId/ChannelStore references in production code

## Handoff

- This package is the single planning authority for OpenClaw-aligned runner reproduction work.
- Old `openclaw_runner_benchmark` and `openclaw_scheduler_substrate` packages are reference history only.
- `specs/20260316_kill-switch/` is the implementation detail reference for Slice 1.
- Build agent must read `tasks.md` before coding; runtime todo must be materialized from `tasks.md`.
- Next build entry: Stage 4 (Channel-to-Workspace Refactor, Phases 11-16). Requires explicit user approval.
