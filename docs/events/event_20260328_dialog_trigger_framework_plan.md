# Event: Dialog Trigger Framework Planning

**Date**: 2026-03-28
**Plan**: `/home/pkcs12/projects/opencode/plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/`

## Requirement

本次任務是把目前對話中逐步形成的 `dialog_trigger_framework` 概念正式收斂為 planner artifacts，並把 `plan_enter` 會亂命名 active plan root 的問題一起納入第一批 build slices。

## Scope

### IN

- 建立 `dialog_trigger_framework` 的正式規劃包
- 把現有 tool surface / planner/runtime evidence 收斂成 architecture-aware plan
- 將 `plan_enter` naming drift 納入同一份 plan
- 產出 IDEF0 / GRAFCET / C4 / Sequence 最小可行圖式

### OUT

- 本 event 不宣告 framework implementation 已完成
- 本 event 不宣告 `plan_enter` naming fix 已實作
- 本 event 不引入 hot reload 或 background AI trigger governor

## Baseline

- 系統目前已經有 per-round tool resolve/inject 鏈，但沒有一個顯式命名的 `dialog_trigger_framework`
- `resolve-tools.ts`、`prompt.ts`、`prompt-runtime.ts`、`processor.ts`、`mcp/index.ts` 已形成可重用基座
- `plan_enter` 仍可能建立與任務主題脫節的 active root 名稱，導致 planner artifact surface 混亂
- 本次 `plan_enter` 又進到錯誤 slug 的模板 root，證實 naming contract 需要正式修正

## Key Decisions

- DD: 直接沿用目前錯誤 slug 的 active plan root，將其改寫成 `dialog_trigger_framework` 的 authoritative plan surface
- DD: `dialog_trigger_framework` 第一版採 rule-first / deterministic detectors
- DD: 第一版 tool/capability 變動採 dirty-flag + next-round rebuild，不做 in-flight hot reload
- DD: 第一版 must-have trigger 只收 `plan_enter`、`replan`、`approval`
- DD: 第一版 detector 寫法採集中式 registry/policy surface，而不是繼續分散式補丁
- DD: `plan_enter` 命名修正先只做 slug derivation，不在第一版同時處理 reuse/rename flow

## Execution

### 1. Evidence consolidation

- 讀取 `specs/architecture.md` 與既有 remote-terminal event，確認 planner/runtime/beta workflow 目前真相
- 讀取 active plan 模板檔，確認目前 root 幾乎都是 placeholder
- 讀取 `plan.ts`、`resolve-tools.ts`、`prompt.ts`、`prompt-runtime.ts`、`processor.ts`、`mcp/index.ts`，確認 next-round rebuild 架構基礎已存在

### 2. Plan rewrite

- 將 active `/plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/` 改寫為 `dialog_trigger_framework` 正式規劃包
- 補齊 `implementation-spec.md`、`proposal.md`、`spec.md`、`design.md`、`tasks.md`、`handoff.md`
- 補齊 `idef0.json`、`grafcet.json`、`c4.json`、`sequence.json`

### 3. Decision convergence

- 根據使用者選擇，把 v1 scope 收斂為：
  - naming fix = slug derivation only
  - must-have triggers = `plan_enter/replan/approval`
  - detector style = centralized registry
  - `plan_exit` 前需補 event + architecture sync

## Validation

- active plan package 已無模板 placeholder
- six-doc artifact 與 four-diagram artifact 已對齊 `dialog_trigger_framework`
- plan 已明確排除 background AI governor 與 in-flight hot reload
- plan 已明確把 `plan_enter` naming fix 寫成第一批 build slice

## Build Slice Progress

### Slice 4.2 — replan threshold / approval boundary integration

- 已在 beta worktree `feature/dialog-trigger-plan-build` 內完成最小 slice：
  - `replan` 必須同時滿足 active execution context、合法 workflow state、replan wording、material direction-change wording
  - `approval` 仍只在 `approval_needed` stop state 生效
  - `dialog-trigger.ts` 補回 `DialogTriggerPolicy` 與 `resolveDialogTriggerPolicy(...)` export，恢復 `prompt.ts` 的政策依賴面

### Beta Environment Note

- 初次在 beta worktree 跑 focused tests 時，因缺少 `node_modules/zod` 無法啟動測試。
- 已採最小可逆修復：在 beta worktree 建立 `node_modules -> main worktree/node_modules` symlink，讓 focused tests 可執行。
- 此修復屬環境層 workaround，不是 repo 內長期機制；但已證明目前 dialog slice 的程式邏輯可以在 beta surface 被驗證。

### Focused Validation

- 通過：`bun test "/home/pkcs12/projects/.beta-worktrees/opencode/feature/dialog-trigger-plan-build/packages/opencode/test/session/dialog-trigger.test.ts"`
- 通過：`bun test "/home/pkcs12/projects/.beta-worktrees/opencode/feature/dialog-trigger-plan-build/packages/opencode/test/session/planner-reactivation.test.ts" --test-name-pattern "replan|approval|auto-route|build-mode switch"`
- 新增驗證點：
  - 只有 replan wording、沒有方向變更時，不應觸發 `replan`
  - approval-like wording 在非 `approval_needed` state 下，不應觸發 `approval`

### Slice 4.3 — centralized trigger detection/policy integration

- 已在同一個 beta worktree 內完成 3.2/4.3 的最小收斂：
  - `prompt.ts` 透過 `resolveDialogTriggerPolicy(...)` 消費中央 policy surface
  - 中央 policy 對 `replan` 沿用既有 decision
  - build-mode wording 仍保持 conservative，不自動啟動 `plan_exit` handoff
- 這代表第一版 centralized policy integration 已接上 prompt/runtime 邊界，但尚未擴張到更積極的 handoff orchestration。

### Additional Focused Validation

- 通過：`bun test "/home/pkcs12/projects/.beta-worktrees/opencode/feature/dialog-trigger-plan-build/packages/opencode/test/session/dialog-trigger.test.ts"`
- 通過：`bun test "/home/pkcs12/projects/.beta-worktrees/opencode/feature/dialog-trigger-plan-build/packages/opencode/test/session/planner-reactivation.test.ts" --test-name-pattern "replan|approval|auto-route|build-mode switch"`
- 新增驗證點：
  - `resolveDialogTriggerPolicy(...)` 對 `replan` 沿用既有 decision
  - build-mode wording 仍保持 conservative policy，不自動 handoff

## Scope Correction

- 後續對話一度把 beta workflow build-entry contract 混入這份 `dialog_trigger_framework` plan。
- 這是錯位：beta workflow 屬 `plan.ts` / planner contract 本身要處理的事；`dialog_trigger_framework` 只是 planner 可能管理的其中一個項目。
- 因此 active `/plans/...` 已修回正確邊界：本 plan 只保留 `dialog_trigger_framework` 自身的 trigger taxonomy、replan、approval、routing 與 planner naming slice；不再把 beta workflow 當本 plan 的主題。

## Architecture Sync

Architecture Sync: Updated

Basis:

- 本次補上了 runtime 真相的抽象命名：現有系統是 per-round tool resolve/inject，加上 MCP dirty-cache invalidation；`dialog_trigger_framework` 第一版只是在這個基礎上加上集中 trigger registry/policy 與 planner naming fix，而不是另造 hot reload runtime。
- `plan_exit` 的 beta workflow 現在需被理解為 build-enter hard contract，而不是可有可無的 metadata：程式會以 beta admission quiz 驗證 AI 是否知道正確的 beta repo / branch / worktree；若回答不符 authority，build entry 以 `product_decision_needed` 失敗。
- 目前 dialog plan 的 build 已正式透過 beta workflow 進行；beta worktree 測試需要依賴環境與 main worktree 對齊，否則 focused test 會先失敗於缺依賴，而不是邏輯錯誤。

## Completion Status

- 本 plan 的第一版目標已完成：
  - active plan package 已重寫為 `dialog_trigger_framework` planning surface
  - `plan_enter` slug derivation slice 已落地並驗證
  - `replan` threshold / `approval` boundary 已落地並驗證
  - centralized trigger detection/policy integration 已落地並驗證
  - beta workflow 已作為實際 build surface 使用
