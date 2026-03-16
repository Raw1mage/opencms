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

- [ ] 5B.1 定義 RunTrigger 介面（type, source, payload, priority, gatePolicy）
- [ ] 5B.2 提取 TriggerEvaluator：gate evaluation 從 planAutonomousNextAction() 分離
- [ ] 5B.3 Mission continuation 降階為 RunTrigger { type: "continuation" }
- [ ] 5B.4 新增 type: "api" trigger scaffold + gate evaluation 驗證
- [ ] 5B.5 回歸測試：14 種 ContinuationDecisionReason 全部覆蓋，gate 語意不變

## Phase 6 — Lane-aware Run Queue

- [ ] 6.1 Define `RunQueue` interface spec with priority lanes (critical, normal, background)
- [ ] 6.2 Upgrade pending continuation queue to generic RunQueue
- [ ] 6.3 Refactor workflow-runner to generic run orchestrator consuming from RunQueue
- [ ] 6.4 Define and implement lane policy (concurrency limits, priority preemption)
- [ ] 6.5 Unit + integration tests for RunQueue and lane policy

## Deferred（requires explicit approval to enter build）

- [ ] D.1 Isolated job sessions
- [ ] D.2 Heartbeat / wakeup substrate
- [ ] D.3 Daemon lifecycle / host-wide scheduler health
