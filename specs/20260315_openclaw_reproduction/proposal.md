# Proposal: openclaw_reproduction

## Why

- OpenClaw benchmark 與 scheduler substrate plan 本質上屬於同一條 workstream：先理解成熟 7x24 agent 控制面，再把可移植核心落到 opencode runner。
- 為避免 authority 分裂，現在收斂為單一主計畫 `openclaw_reproduction`。
- 2026-03-16 起，kill-switch 控制面實作（Phase A-D）已交付，計畫進入 UI 表面與基礎設施擴展階段。

## Original Requirement Wording (Baseline)

- "以 OpenClaw 為 benchmark，理解 7x24 agent 的控制面"
- "將差距分析直接轉成 opencode 的 phased implementation plan"
- "先從 Trigger + Queue substrate 開始，避免直接跳進 full daemon rewrite"

## Requirement Revision History

- 2026-03-15: 合併 `openclaw_runner_benchmark` 與 `openclaw_scheduler_substrate` 為單一主計畫
- 2026-03-15: 完成 planner contract rewrite、runner/prompt contract rewrite、bootstrap policy rewrite、easier plan mode、web-monitor-restart-control
- 2026-03-16: 新增 kill-switch 作為 OpenClaw 控制面的第一個具體實作切片；Phase A-D 已交付（backend service, API, RBAC+MFA, scheduling gate, soft/hard kill, snapshot, CLI, tests）
- 2026-03-16: 識別後續工作：kill-switch UI 表面（Web Admin + TUI）、基礎設施擴展（Redis transport + MinIO/S3）、安全審查、Trigger model extraction、lane-aware run queue

## Effective Requirement Description

1. 以 OpenClaw 為 benchmark，理解 7x24 agent 的控制面。
2. 將差距分析直接轉成 opencode 的 phased implementation plan。
3. 先從 Trigger + Queue substrate 開始，避免直接跳進 full daemon rewrite。
4. Kill-switch 控制面作為第一個具體實作切片，需完整交付（API → UI → 安全審查 → Runbook）。
5. 後續 Trigger model extraction 與 lane-aware run queue 作為第二、三實作切片。

## Scope

### IN

- OpenClaw 本地 `refs/openclaw` 架構 / control-plane 研究
- kill-switch 全生命週期（spec → backend → UI → security review → runbook）
- generic trigger model、lane-aware run queue 的 phased planning 與實作
- planner/runner/bootstrap contract 維護

### OUT

- 本輪不直接做 full daemon rewrite
- 本輪不直接做 recurring scheduler persistence store
- 本輪不直接移植 OpenClaw channel-centric product features
- 本輪不新增 silent fallback mechanism
- 跨集群 multi-region replication（視部署而定，另案處理）

## Non-Goals

- provider-side 連帶自動重啟
- OpenClaw channel-centric product assumptions 的直接照搬

## Constraints

- 不可新增 silent fallback
- 不可把 OpenClaw 的 channel-centric product assumptions 直接照搬
- 不可讓多份 plan 同時作為同一 workstream 的主 authority
- kill-switch 公開 API 須通過安全審查方可啟用

## Decision Summary

- `openclaw_runner_benchmark` 與 `openclaw_scheduler_substrate` 合併為 `openclaw_reproduction`
- 新主 plan 同時包含 benchmark findings 與 build-facing execution slices
- kill-switch 為第一實作切片（Phase A-D done, Phase E-F pending）
- Trigger model extraction 為第二實作切片（pending）
- Lane-aware run queue 為第三實作切片（pending）
