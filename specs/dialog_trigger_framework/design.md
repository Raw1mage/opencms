# Design

## Context

現有 runtime 已經具備幾個重要事實：

- tool surface 實際上是 **per-round resolve / inject**，不是 in-flight hot swap
- planner mode / build handoff / approval / beta gating 已有零散規則，但缺少統一命名框架
- `plan_enter` naming drift 暴露的是 planner artifact naming contract 不夠明確，而不只是 UI 命名小問題

因此 `dialog_trigger_framework` 的作用不是重建整個 runtime，而是把這些既有 truth surfaces 提升為可維護的 policy layer。

## Merged Design Decisions

### DD-1: Rule-first detector, not background AI governor

第一版 framework 採 rule-first、deterministic detector。

理由：
- 更符合 fail-fast / no silent fallback
- 比背景 LLM governor 容易驗證與除錯
- 與目前 runtime 的 round-boundary decision 模型更一致

### DD-2: Detector / Policy / Action 三層分離

- **Detector**：辨識候選 trigger（例如 `plan_enter`、`replan`、`approval`）
- **Policy**：根據 workflow state / mission state / wait state 決定是否允許、延後、阻擋
- **Action**：真正路由到 planner/workflow tool 或 session transition

這個三層邊界是為了避免判斷規則散落在 `prompt.ts`、`plan.ts`、`resolve-tools.ts` 等多點，造成 drift。

### DD-3: Dirty flag + next-round rebuild is the formal v1 capability contract

framework 不假裝系統支援 in-flight hot reload。對於工具面/能力面改變：
- 標記 dirty
- 在下一輪 resolution/rebuild 時重算

這是基於現有 runtime truth 的明確建模，而不是能力降級說詞。

### DD-4: Replan stays narrow in v1

`replan` 不是任何「改想法了」都算。

v1 需要至少：
- active execution context
- material direction change

這個限制是為了避免把一般對話、進度追問、模糊補充都誤判成 planning interrupt。

### DD-5: Approval is centralized detection/routing first

approval 在 v1 的責任是：
- 集中化 detection/routing
- 與既有 wait-state / stop-state contract 對齊

但不過度宣稱已經完成更深的 runtime orchestration state machine。

### DD-6: plan_enter naming repair is part of framework integrity

`plan_enter` active-root 亂命名代表：
- planner root derivation 與任務主題脫節
- dated `/plans/` package 失去可追溯性
- 後續 docs / execution / handoff 全部會跟著混亂

所以它被定義為 framework 的第一個實作切片，而不是低優先 cosmetic issue。

## Runtime Integration Surfaces

主要整合邊界：
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/resolve-tools.ts`
- `packages/opencode/src/session/prompt-runtime.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/mcp/index.ts`

framework 應在 **round boundary** 發揮作用，而不是侵入 tool execution substrate 本身。

## Architecture Boundary

### What this framework owns
- trigger vocabulary
- detector/policy/action contract
- dirty-surface rebuild semantics
- planner-trigger and approval-routing boundaries

### What this framework does not own (v1)
- background semantic governance
- full in-flight tool/menu mutation protocol
- total rewrite of processor/runtime flow
- every future trigger family (tool menu、docs sync、beta workflow) 的完整最終形態

## Promotion Meaning

原始 dated plan 已完成 planning-package 任務；升格到 `specs/dialog_trigger_framework/` 後：
- 這裡是正式語意參考根目錄
- 原 plan 只是 historical execution package
- 後續若真的 build `plan_enter` naming fix 或 trigger registry，應引用此 root 作為正式依據
