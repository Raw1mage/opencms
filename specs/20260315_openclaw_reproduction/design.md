# Design: openclaw_reproduction

## Context

- 先前存在兩個 `openclaw*` plan：
  - `openclaw_runner_benchmark`（研究 authority）
  - `openclaw_scheduler_substrate`（build-facing authority）
- 雖然短期有助於收斂，但長期造成同一 workstream 的 authority 分裂。

## Consolidation Strategy

- 保留 benchmark findings，但將其內化到新的單一主計畫。
- 保留 scheduler substrate 的 build entry slice，但不再讓它獨立作為 active authority。
- 舊 plan 保留作 reference history，避免破壞可追溯性。

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

- generic trigger model
- lane-aware run queue
- workflow-runner as generic orchestrator

### Deferred later

- isolated jobs
- heartbeat / wakeup substrate
- daemon lifecycle / host-wide scheduler health

## Risks

- 若 consolidation 只改命名、不改 authority 描述，後續仍會不清楚哪份 plan 才是 active。
- 若太早把 deferred slices 混進第一輪 build，會重新掉入 full scheduler complexity。
