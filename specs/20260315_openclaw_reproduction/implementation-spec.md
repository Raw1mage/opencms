# Implementation Spec

## Goal

- 將 OpenClaw 對標研究與 scheduler substrate implementation planning 收斂為單一主計畫：以 OpenClaw 的 7x24 agent 控制面為 benchmark，為 opencode 制定並逐步實作一條可驗證的 reproduction 路線，讓 runner 從 session-local continuation engine 演進為 trigger-driven autonomous scheduler substrate。

## Scope

### IN

- OpenClaw 本地 `refs/openclaw` 架構 / control-plane 研究
- `workflow-runner`、continuation queue、mission contract、supervisor 的差距分析
- generic trigger model、lane-aware run queue、workflow-runner orchestration refactor 的 phased planning
- 後續 isolated job sessions / heartbeat / wakeup / daemon lifecycle 的 deferred roadmap
- 相關 event / handoff / architecture sync authority

### OUT

- 本輪不直接做 full daemon rewrite
- 本輪不直接做 recurring scheduler persistence store
- 本輪不直接移植 OpenClaw channel-centric product features
- 本輪不新增 fallback mechanism

## Assumptions

- OpenClaw 的本地 code/doc 足以作為主要 benchmark 證據來源。
- 現有 autorunner 已具備 approved mission、todo-driven continuation、supervisor / lease / anomaly evidence，這些應保留並降階為 scheduler 的 trigger source 之一。
- 第一個實作 slice 應從 Trigger + Queue substrate 開始，而非直接跨進 daemon lifecycle。

## Stop Gates

- 若 reproduction 提案需要引入 silent fallback、隱式 authority recovery、或違反 fail-fast 原則，必須停下並列為 rejected。
- 若實作需要直接擴張到 recurring scheduler persistence、daemon restart loop、或 host-wide worker lifecycle，必須先做 phase split 與 approval。
- 若 trigger / queue 抽象化會破壞現有 approved mission / approval / decision gate semantics，必須停下補 spec，不得邊做邊猜。

## Critical Files

- `/home/pkcs12/projects/opencode/refs/openclaw/docs/concepts/agent-loop.md`
- `/home/pkcs12/projects/opencode/refs/openclaw/docs/concepts/queue.md`
- `/home/pkcs12/projects/opencode/refs/openclaw/docs/concepts/multi-agent.md`
- `/home/pkcs12/projects/opencode/refs/openclaw/docs/automation/cron-jobs.md`
- `/home/pkcs12/projects/opencode/refs/openclaw/docs/automation/cron-vs-heartbeat.md`
- `/home/pkcs12/projects/opencode/refs/openclaw/docs/cli/daemon.md`
- `/home/pkcs12/projects/opencode/refs/openclaw/src/cli/gateway-cli/run-loop.ts`
- `/home/pkcs12/projects/opencode/refs/openclaw/src/auto-reply/reply/{agent-runner,queue,queue-policy}.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/system.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/todo.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt/{runner,plan}.txt`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260315_openclaw_reproduction.md`
- `/home/pkcs12/projects/opencode/specs/20260315_openclaw_reproduction/{proposal,spec,design,tasks,handoff}.md`

## Structured Execution Phases

- Phase 1 — OpenClaw benchmark capture
  - 提煉 OpenClaw 的 always-on daemon/gateway、lane-aware queue、heartbeat/cron triggers、isolated sessions、restart/drain lifecycle。
- Phase 2 — Portability classification
  - 將 OpenClaw 特徵分成：already-present / portable-next / substrate-heavy / incompatible。
- Phase 3 — Reproduction entry slice
  - 以最低風險方式抽出 `RunTrigger` 與 `RunLane`，將 mission continuation 降階為 trigger source 之一。
- Phase 4 — Queue and orchestrator refactor planning
  - 將 pending continuation queue 升級成 generic run queue，讓 `workflow-runner` 轉為 generic run orchestrator。
- Phase 5 — Deferred roadmap
  - 將 isolated jobs / heartbeat / wakeup / daemon lifecycle 留作後續 phases，需顯式 approval 才進 build。

## Validation

- benchmark evidence must cite concrete local OpenClaw code/doc traits
- plan must distinguish portable vs substrate-heavy vs incompatible
- first build slice must define unit/regression/integration validation for Trigger + Queue changes
- architecture docs must express planner authority vs trigger authority separation once implementation begins

## Handoff

- This package is now the single planning authority for OpenClaw-aligned runner reproduction work.
- Old `openclaw_runner_benchmark` and `openclaw_scheduler_substrate` packages are reference history only.
- First build entry remains Trigger + Queue substrate unless explicitly expanded by user approval.
