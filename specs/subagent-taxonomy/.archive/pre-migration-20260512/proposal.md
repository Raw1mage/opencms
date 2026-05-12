# Proposal: Subagent Taxonomy Formalization

## Why

- 四種 agent 行為模式（Executor / Researcher / Cron / Daemon）混用同一套機制，缺乏正式分類
- 導致錯誤的架構選擇（例如用 task() 做 daemon 工作）
- 不同類型 subagent 應使用不同 model tier（researcher → small model，executor → parent model），目前沒有自動路由

## Effective Requirement Description

1. 正式化四種 agent 類型的 taxonomy，明確各自的 dispatch 合約
2. 實作 model tier routing：根據 subagent_type 自動選擇 model 等級
3. 評估 Researcher 類型的平行執行可行性（single-child invariant 放寬）

## Scope

### IN

- Subagent taxonomy 文件化（Executor / Researcher / Cron / Daemon）
- Model tier routing 實作（`resolveSmallModel()` 整合）
- Parallel subagent 可行性評估 addendum

### OUT

- Codex fork / checkpoint dispatch（→ `/plans/context-dispatch-optimization/`）
- Daemon agent 實作（→ `/plans/daemon-agent/`）
- Parallel subagent 完整實作（本 plan 只做評估）

## What Changes

- `task.ts`：schema 中正式標記四種類型語意；model 解析段加入 tier routing
- `specs/architecture.md`：新增 Subagent Taxonomy 章節
- 可配置 tier 表（`~/.config/opencode/config.json` 的 `subagent.modelTiers`）

## Origin

拆分自 `/plans/subagent-evolution/`（Phase 3 + Phase 5）。
