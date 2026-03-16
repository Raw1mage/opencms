# Tasks: openclaw_reproduction

## Phase 0 — Consolidation & Benchmark

- [x] 0.1 Merge benchmark and scheduler substrate planning into single active plan
- [x] 0.2 Mark older openclaw plans as reference-only authority
- [x] 0.3 Capture OpenClaw control-plane traits from local `refs/openclaw`
- [x] 0.4 Classify already-present / portable-next / substrate-heavy / incompatible patterns
- [x] 0.5 Complete planner contract rewrite (`packages/opencode/src/tool/plan.ts`)
- [x] 0.6 Complete runner/prompt contract rewrite (`runner.txt`, `plan.txt`, `claude.txt`, `system.ts`)
- [x] 0.7 Complete bootstrap/capability policy rewrite (`AGENTS.md`, `enablement.json`)
- [x] 0.8 Complete easier plan mode (plan/build semantics, transition contract)
- [x] 0.9 Complete web-monitor-restart-control flow
- [x] 0.10 Sync `docs/ARCHITECTURE.md` and event records

## Phase 1 — Kill-switch Backend

- [x] 1.1 Deliver planner artifacts: implementation-spec.md, spec.md, design.md — owner: planner
- [x] 1.2 Implement state store + API endpoints (status, trigger, cancel, per-session control) — files: `killswitch/service.ts`, `routes/killswitch.ts`
- [x] 1.3 Integrate RBAC + MFA checks into API — owner: backend/security
- [x] 1.4 Integrate scheduling gate into agent startup / scheduler path — file: `routes/session.ts`
- [x] 1.5 Implement soft-pause signaling (local transport) — owner: infra
- [x] 1.6 Implement timeout-driven force termination (hard-kill) — owner: infra
- [x] 1.7 Implement snapshot generator + audit writes — owner: infra/ops
- [x] 1.8 Implement CLI commands (status/trigger/cancel) — file: `cli/cmd/killswitch.ts`
- [x] 1.9 Implement frontend helper functions — file: `settings-kill-switch.ts`
- [x] 1.10 Deliver unit + integration tests (13 tests passing)

## Phase 2 — Kill-switch UI 表面

- [x] 2.1 Design decision: SSE vs WebSocket — **Resolved: SSE** — codebase 100% SSE-native, zero WebSocket infrastructure
- [x] 2.2 Web Admin UI — owner: frontend
  - [x] 2.2a API integration (trigger/cancel/status + MFA challenge flow) — file: `settings-general.tsx`
  - [x] 2.2b BusEvent `killswitch.status.changed` + Bus.publish + SSE push — files: `event.ts`, `service.ts`, `event-reducer.ts`, `types.ts`
  - [x] 2.2c 替換 `window.confirm()` 為 double-click confirmation pattern（Confirm Trigger / Confirm Cancel）
  - [x] 2.2d Snapshot toggle checkbox
  - [x] 2.2e SSE event 驅動即時狀態更新（`sync.data.killswitch_status` via `ksStatus()` memo）
  - [x] 2.2f Styled status indicator（active=red badge, inactive=green badge）
- [x] 2.3 TUI integration: Kill-Switch category in admin dialog — Status/Trigger/Cancel with DialogPrompt + DialogConfirm + MFA flow

## Phase 3 — Kill-switch 基礎設施擴展

- [x] 3.1 Implement Redis pub/sub control transport adapter — `ioredis` dual-connection pub/sub with channel `ks:control:{sessionID}` / `ks:ack:{requestID}:{seq}`, lazy init, timeout race
- [x] 3.2 Implement MinIO/S3 snapshot backend — `aws4fetch` AwsClient PUT to `{endpoint}/{bucket}/killswitch/snapshots/{requestID}.json`, error-resilient (returns null on failure, does not block kill path)

## Phase 4 — Kill-switch 安全審查與運維

- [x] 4.1 Security team review and sign-off — **APPROVED** (2026-03-16) — production API enablement unblocked
- [x] 4.2 E2E Web path test: UI → API → state change → snapshot — `killswitch.e2e.test.ts` — 5 tests: full lifecycle, MFA rejection, cooldown, RBAC, snapshot verification
- [x] 4.3 Runbook + postmortem template — `specs/20260316_kill-switch/runbook.md` — trigger/cancel paths (Web/TUI/CLI/API), env vars, troubleshooting, escalation, postmortem template

## Phase 5 — Continuous Worker

### 5A — Plan-trusting Continuation Mode（P0）

- [x] 5A.1 定義 plan-trusting mode 啟動條件 — `isPlanTrusting()`: mission.executionReady + source=openspec_compiled_plan + contract=implementation_spec
- [x] 5A.2 planAutonomousNextAction() 在 plan-trusting mode 下跳過 max_continuous_rounds — `workflow-runner.ts` L716
- [x] 5A.3 handleSmartRunnerStopDecision() 在 plan-trusting mode 下短路 — `prompt.ts` L893 plan-trusting 直接 return continue
- [x] 5A.4 tasks.md integrity 豁免 — `mission-consumption.ts` L220：tasks.md 的修改是進度不是汙染，移除 tasks integrity check
- [x] 5A.5 測試：isPlanTrusting 5 tests + max_continuous_rounds bypass 3 tests + tasks.md integrity exemption 2 tests + blocker regression — 84 tests passing

### 5B — Multi-source Trigger（P1）

- [x] 5B.1 定義 RunTrigger 介面（type, source, payload, priority, gatePolicy）— `session/trigger.ts`: RunTrigger union (Continuation | Api), TriggerGatePolicy, TriggerPriority
- [x] 5B.2 提取 TriggerEvaluator：gate evaluation 從 planAutonomousNextAction() 分離 — `trigger.ts:evaluateGates()` + `workflow-runner.ts:evaluateTriggerGates()`
- [x] 5B.3 Mission continuation 降階為 RunTrigger { type: "continuation" } — `planAutonomousNextAction()` internally builds continuation trigger via `buildContinuationTrigger()`
- [x] 5B.4 新增 type: "api" trigger scaffold + gate evaluation 驗證 — `buildApiTrigger()` with `API_GATE_POLICY` (respectMaxRounds=false)
- [x] 5B.5 回歸測試：14 種 ContinuationDecisionReason 全部覆蓋，gate 語意不變 — 83 tests passing (51 existing + 32 new)

## Phase 6 — Lane-aware Run Queue

- [x] 6.1 Define `RunQueue` interface spec with priority lanes — `session/queue.ts`: QueueEntry schema, enqueue/remove/peek/listLane/listAll/drain/countByLane
- [x] 6.2 Upgrade pending continuation queue to generic RunQueue — `enqueuePendingContinuation()` delegates to `RunQueue.enqueue()`, `clearPendingContinuation()` delegates to `RunQueue.remove()`, legacy key compat preserved
- [x] 6.3 Refactor workflow-runner to generic run orchestrator — `listPendingContinuations()` reads from RunQueue with legacy fallback, `resumePendingContinuations()` benefits from lane-ordered listing
- [x] 6.4 Define and implement lane policy — `session/lane-policy.ts`: critical(cap 2)/normal(cap 4)/background(cap 2), `triggerPriorityToLane()`, `laneHasCapacity()`, `RunQueue.drain()` respects caps
- [x] 6.5 Unit + integration tests — 99 tests passing (83 Phase 5B + 16 Phase 6: lane policy 5 + RunQueue 11)

## Stage 3 — Isolated Jobs + Heartbeat + Daemon Lifecycle（D.1-D.3）

IDEF0/GRAFCET diagrams: `specs/20260315_openclaw_reproduction/diagrams/`

### D.1 — Isolated Job Sessions（Phase 8）

- [ ] D.1.1 Define session key namespace scheme — main session `agent:<agentId>:main` vs isolated `cron:<jobId>:run:<uuid>` — IDEF0: A11
- [ ] D.1.2 Implement `CronSessionTarget` type (`"main" | "isolated"`) and session factory — creates fresh Session.Info with scoped key, no parent context carryover
- [ ] D.1.3 Implement `lightContext` bootstrap mode — skip workspace file injection, provide cron-prefixed system prompt with minimal token footprint — IDEF0: A12
- [ ] D.1.4 Implement cron job store — `~/.config/opencode/cron/jobs.json` persistence, CRUD operations, Zod schema with CronJobState (nextRunAtMs, runningAtMs, lastRunStatus, consecutiveErrors) — benchmark: `refs/openclaw/src/cron/types.ts`
- [ ] D.1.5 Implement delivery routing — announce/webhook/none per job config, post summary to main session if configured, chunk per channel format rules — IDEF0: A13
- [ ] D.1.6 Implement session retention reaper — prune expired cron run-sessions by age (default 24h), trim run-log JSONL by size (2MB) and line count (2000) — IDEF0: A14
- [ ] D.1.7 Implement run-log JSONL — append-only per-job log at `~/.config/opencode/cron/runs/<jobId>.jsonl`, auto-pruning on retention check

### D.2 — Heartbeat / Wakeup Substrate（Phase 9）

- [ ] D.2.1 Define schedule expression engine — 3 kinds: `at` (one-shot ISO timestamp), `every` (fixed interval string), `cron` (5/6-field expression with IANA timezone) — IDEF0: A21
- [ ] D.2.2 Implement deterministic stagger — top-of-hour expressions offset by up to 5min based on job ID hash to reduce thundering herd, `--stagger` override, `--exact` bypass
- [ ] D.2.3 Implement active hours gating — `activeHours: { start: "HH:MM", end: "HH:MM" }` filter, suppress triggers outside window, compute next eligible fire time — IDEF0: A22
- [ ] D.2.4 Implement system event queue — in-memory FIFO per session key (max 20 events), `enqueueSystemEvent(text, { sessionKey, contextKey? })`, `drainSystemEventEntries(sessionKey)` — IDEF0: A23, benchmark: `refs/openclaw/src/infra/system-events.ts`
- [ ] D.2.5 Implement HEARTBEAT_OK smart suppression — execute heartbeat checklist from HEARTBEAT.md, if no actionable content return HEARTBEAT_OK token and suppress delivery
- [ ] D.2.6 Implement wake modes — `wakeMode: "now"` (immediate agent turn) vs `"next-heartbeat"` (event waits for next scheduled heartbeat run) — IDEF0: A23/A24
- [ ] D.2.7 Integrate heartbeat with AutonomousPolicy throttle governor — respect cooldown/budget/escalation from Phase 5, HEARTBEAT.md checklist as heartbeat prompt source

### D.3 — Daemon Lifecycle / Host-wide Scheduler Health（Phase 10）

- [ ] D.3.1 Implement gateway lock — `acquireGatewayLock()` / `releaseLockIfHeld()` via port-based or file-based mechanism, prevent multiple daemon instances — IDEF0: A31
- [ ] D.3.2 Implement signal handlers — SIGTERM/SIGINT → graceful shutdown, SIGUSR1 → in-process restart with authorization check — IDEF0: A32, benchmark: `refs/openclaw/src/cli/gateway-cli/run-loop.ts`
- [ ] D.3.3 Implement drain state machine — `markGatewayDraining()` → reject new enqueues with `GatewayDrainingError` → wait active tasks (DRAIN_TIMEOUT_MS=90s) → proceed — IDEF0: A33
- [ ] D.3.4 Implement command queue with lane types — Main/Cron/Subagent/Nested lanes, per-lane `maxConcurrent` (1/1/2/1), per-session lanes for single-threaded execution — IDEF0: A41, benchmark: `refs/openclaw/src/process/command-queue.ts`
- [ ] D.3.5 Implement per-lane concurrency limits and priority drain pump — dequeue when active < maxConcurrent, track taskId and generation, emit diagnostic if queue wait > 2s — IDEF0: A43
- [ ] D.3.6 Implement process restart loop — try full process respawn via `restartGatewayProcessWithFreshPid()`, fallback to in-process restart if `OPENCLAW_NO_RESPAWN`, close HTTP server with `restartExpectedMs` — IDEF0: A34
- [ ] D.3.7 Implement generation numbers — increment on restart cycle, stale task completions from previous generation ignored by lane pump — IDEF0: A35
- [ ] D.3.8 Implement `resetAllLanes()` post-restart recovery — clear activeTaskIds, bump generation, re-drain queued entries — IDEF0: A44
- [ ] D.3.9 Wire `Daemon.info()` to active session count, lane queue sizes, and generation number — expose via health endpoint for operator observability — IDEF0: A5
- [ ] D.3.10 Implement retry policy — transient errors (rate_limit, overload, 5xx) → exponential backoff (30s→1m→5m→15m→60m), permanent errors (auth, config) → disable immediately — benchmark: OpenClaw CronJobState error classification
