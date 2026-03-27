# Implementation Spec

> Promotion Status: Promoted from `/plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler` to `/specs/20260327_plan-enter-plans-20260327-durable-cron-scheduler` on 2026-03-28.

## Goal

- 收斂 OpenCode durable cron scheduler 的現況，將已完成的 durability 修復納入基線，並把剩餘缺口聚焦為可執行的 runtime validation 與 hardening 工作。

## Scope

### IN

- 盤點 2026-03-27 前後已完成的 cron durability 修復：persisted job state、boot recovery、minute-level heartbeat、serve/unix-socket lifecycle wiring。
- 重新定義 durable cron scheduler 的當前 execution baseline，避免與舊的 `specs/scheduler-channels/` 全量 spec 重複。
- 規劃剩餘工作：live daemon/runtime smoke validation、`listenUnix()` lifecycle wiring regression guard、operator-visible run-log evidence 檢查。
- 明確列出 build agent 應更新的 event / architecture 同步責任。

### OUT

- 不重寫 channel / per-channel lanes / kill-switch 多頻道架構。
- 不重做 scheduled tasks UI。
- 不重寫 cron expression engine、retry policy、run-log schema。
- 不新增 fallback scheduler 或補跑機制來掩蓋 runtime wiring 問題。

## Assumptions

- `CronStore` 的 jobs persistence、`Heartbeat.recoverSchedules()`、以及 `Server.listenUnix()` 啟動 lifecycle wiring 已存在於目前工作樹或近期修復基線中。
- 本次 plan 的主要價值是收斂「現在什麼已經是真的」與「還缺哪個驗證/保護層」，而非重新發明 scheduler architecture。
- 真正 authoritative 的長期結構仍以 `specs/architecture.md` 為準；本 plan 只是這次 planning / build 的 active contract。

## Stop Gates

- 若 live runtime smoke evidence 顯示目前 `serve --unix-socket` 仍未穩定產生 run log 或 execution log，必須停下重新做 root-cause planning，不得用 fallback 補救。
- 若 build 過程需要擴大到 channel / multi-session orchestration redesign，必須回到 planning，不能把該範圍偷偷併入本次 implementation。
- 若需要 destructive git/runtime actions（例如清 daemon state、刪 production-like cron data、push/merge），必須先取得使用者批准。

## Critical Files

- `packages/opencode/src/cron/heartbeat.ts`
- `packages/opencode/src/cron/store.ts`
- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/daemon/index.ts`
- `packages/opencode/src/server/routes/cron.ts`
- `packages/opencode/src/cron/heartbeat.test.ts`
- `packages/opencode/src/cron/store.test.ts`
- `docs/events/event_20260327_cron_not_running_on_schedule.md`
- `docs/events/event_20260327_cron_no_execution_log_runtime_lifecycle.md`
- `docs/events/event_20260327_durable_cron_scheduler_plan.md`

## Structured Execution Phases

- Phase 1: Baseline consolidation — reconcile the durable scheduler truth across existing specs, architecture docs, and 2026-03-27 cron events.
- Phase 2: Runtime evidence hardening — add/adjust regression coverage and live validation slices around daemon boot, heartbeat registration, and run-log visibility.
- Phase 3: Documentation sync — update event log plus architecture verification so future sessions can treat durable cron behavior as current-state knowledge rather than tribal memory.

## Validation

- Targeted tests: `bun test packages/opencode/src/cron/heartbeat.test.ts` and `bun test packages/opencode/src/cron/store.test.ts`.
- If a new server/lifecycle regression test is added, run the exact targeted test file for that slice.
- Live operator validation: start the real web/daemon runtime through `./webctl.sh dev-start` or refresh path, create or wait for a due cron job, then confirm run-log JSONL and `/system/tasks` execution log both move.
- Documentation validation: confirm event log and architecture sync statement reflect the final implementation truth.

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must treat the 2026-03-27 cron events as baseline evidence, not as obsolete noise.
- Build agent must prefer small hardening slices over architecture expansion.
