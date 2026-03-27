# Proposal

## Why

- OpenCode 的 cron durability 在 repo 內已分散於舊 spec、近期 bugfix、與 architecture 描述之間；目前缺的是把「已完成什麼」與「還缺什麼」重新收斂成單一 active plan。
- 2026-03-27 連續兩個 cron 事件已證明：問題不只是排程精度，還包括真實 per-user daemon 啟動路徑是否真的把 heartbeat lifecycle 接起來。若不把這些基線沉澱清楚，後續很容易重複 debug 或誤判 durability 尚未落地。

## Original Requirement Wording (Baseline)

- "plan_enter plans/20260327_durable-cron-scheduler/"

## Requirement Revision History

- 2026-03-27: 使用者以 plan mode 開啟 `durable-cron-scheduler`。
- 2026-03-27: 在 planning clarification 中確認本 plan 採「收斂現況」定位，而不是重寫完整 scheduler/channels spec。

## Effective Requirement Description

1. 將 durable cron scheduler 的已實作基線正式收斂：jobs persistence、boot recovery、minute-level heartbeat、serve-path lifecycle wiring。
2. 把剩餘工作聚焦為 live validation、regression hardening、與文件同步，而不是再展開更大架構面。

## Scope

### IN

- 收斂 `specs/scheduler-channels/` 與 2026-03-27 cron event 的有效現況。
- 規劃 durable cron scheduler 剩餘 hardening slices。
- 明確規範 build 時要驗證哪些 operator-visible evidence。

### OUT

- 不重開 channel model、per-channel lane isolation、channel-scoped kill-switch 的新設計。
- 不重做 `/system/tasks` UI 功能面。
- 不引入新的 fallback scheduling behavior。

## Non-Goals

- 不把本 plan 當成 `scheduler-channels` 的替代整包重寫。
- 不在沒有證據的情況下宣稱 scheduler architecture 仍需大改。

## Constraints

- 必須遵守 fail-fast 原則，不能靠補跑或 silent fallback 隱藏 lifecycle 問題。
- 規劃需對齊既有 architecture SSOT 與 docs/events evidence。
- 若進入 build，應優先做最小可驗證 hardening slices。

## What Changes

- 新 plan 會把 durable cron scheduler 的 current-state contract 寫清楚，讓後續 build agent 不必再從舊 spec 與零散事件重建心智模型。
- 變更重點會落在 runtime verification、regression test coverage、以及 planning/docs contract，而非大幅修改 production code surface。

## Capabilities

### New Capabilities

- Durable scheduler baseline contract: 明確定義哪些 durability 能力已成立、哪些仍待驗證。

### Modified Capabilities

- Cron planning workflow: 從「重寫 durability spec」改為「以現況收斂 + hardening」為主。
- Operator validation contract: 從隱含需求改為明確要求 run-log 與 execution log 的 live evidence。

## Impact

- `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/*`
- `docs/events/event_20260327_durable_cron_scheduler_plan.md`
- 後續 build 可能影響 `packages/opencode/src/cron/*`, `packages/opencode/src/server/server.ts`, 與對應 test files
