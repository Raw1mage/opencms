# Proposal: Daemon Agent

## Why

- Cron 只能定時觸發，無法做條件觸發的常駐監控
- "如果能用口語隨口叫出一個 agent 開始背景監守工作，應該是滿酷的事"
- Autonomous runner 之前嘗試在 session 內部做 loop（Stage 5 Drain-on-Stop），結果無限迴圈被停用。Daemon 從外部注入觸發，避開 session 內部狀態機的複雜性

## Effective Requirement Description

1. 設計 Daemon agent 架構：條件觸發、常駐、非同步通知
2. Sense-Judge-Act loop：用工具撈資料 → 評估條件 → 通知或執行動作
3. Daemon 可監測外部系統（網頁、API、log）和 opencode 自身狀態（session idle、tasks.md 進度）
4. 作為 Autonomous Runner 的替代方案：從外部注入 user message 推進 session 工作

## Scope

### IN

- Daemon agent lifecycle（DaemonStore、condition loop、Bus event 發布）
- DaemonSpec 泛用界面（sense / judge / act 配置）
- ProcessSupervisor 整合（kind="daemon"）
- Daemon restart recovery
- task-worker-continuation.ts daemon kind 排除

### OUT

- Codex fork / checkpoint dispatch（→ `/plans/context-dispatch-optimization/`）
- Subagent taxonomy 正式化（→ `/plans/subagent-taxonomy/`）
- 修改 Cron 排程機制

## Constraints

- 必須整合現有 Bus / ProcessSupervisor / Lanes 基礎設施，禁止重複造輪子
- 複用 `cron/delivery.ts` announce 路徑
- Daemon session 不走 completion handoff，不觸發 parent resume

## What Changes

- 新增 `packages/opencode/src/daemon/agent-daemon.ts`（DaemonStore + DaemonRunner）
- `daemon/index.ts`：startup 加入 `DaemonStore.recover()`
- `task-worker-continuation.ts`：daemon kind guard
- `process/supervisor.ts`：新增 `"daemon"` kind

## Origin

拆分自 `/plans/subagent-evolution/`（Phase 4）。詳細設計見原計畫 `phase4-daemon-design.md`。

## Detailed Design Reference

- `/plans/subagent-evolution/phase4-daemon-design.md` — DaemonSpec 界面、Sense/Judge/Act 類型、lifecycle、與 Cron 的界線
- `/plans/subagent-evolution/vision.md` — Daemon 作為 Autonomous Runner 的解法（Section 五）
- `/plans/subagent-evolution/vision-long-term.md` — 可繁殖智能體節點、長期方向
