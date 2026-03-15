# Proposal: openclaw_reproduction

## Why

- OpenClaw benchmark 與 scheduler substrate plan 本質上屬於同一條 workstream：先理解成熟 7x24 agent 控制面，再把可移植核心落到 opencode runner。
- 為避免 authority 分裂，現在收斂為單一主計畫 `openclaw_reproduction`。

## Effective Requirement Description

1. 以 OpenClaw 為 benchmark，理解 7x24 agent 的控制面。
2. 將差距分析直接轉成 opencode 的 phased implementation plan。
3. 先從 Trigger + Queue substrate 開始，避免直接跳進 full daemon rewrite。

## Constraints

- 不可新增 silent fallback
- 不可把 OpenClaw 的 channel-centric product assumptions 直接照搬
- 不可讓多份 plan 同時作為同一 workstream 的主 authority

## Decision Summary

- `openclaw_runner_benchmark` 與 `openclaw_scheduler_substrate` 合併為 `openclaw_reproduction`
- 新主 plan 同時包含 benchmark findings 與 build-facing execution slices
