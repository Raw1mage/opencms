# Proposal

## Why

- 目前系統雖然已經有 planner、tool surface resolve、MCP dirty rebuild、approval stop-state 等局部能力，但缺少一個可命名、可驗證的 `dialog_trigger_framework` 來統一描述：什麼訊號會觸發 `plan_enter`、什麼情況算 `replan`、何時該進 approval gate、何時只需標記 surface dirty 並於下一輪重建。
- `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/` 已完成這個 framework 的 planning package，且使用者已明確要求把它升格為 `/specs/` 正式參考包。
- 升格後可把 planner trigger / runtime gate / next-round rebuild 的知識從 dated execution package 抽離，讓後續相關工作（planner slug fix、tool-menu policy、builder/beta workflow routing）有穩定的 semantic reference root。

## Effective Requirement Description

1. 將 `dialog_trigger_framework` 視為 planner/runtime 之間的正式橋接層：以 deterministic detector + policy + action 合約處理 plan/replan/approval 等 trigger。
2. 第一版只承諾 rule-first、next-round rebuild、集中式 registry/policy surface；不承諾背景 AI governor、in-flight hot reload、完整自然語意分類。
3. `plan_enter` active plan root 命名修正是此 framework 的第一個明確 implementation slice；v1 僅限 slug derivation / topic alignment。
4. 本 package 作為 formalized spec，保存 framework intent、scope boundary、runtime integration seams 與 handoff 規則。

## Scope

### IN
- `dialog_trigger_framework` v1 的目標、術語、trigger taxonomy、分層決策
- `plan_enter` naming repair 與 planner artifact naming contract 的關聯
- per-round tool resolve / dirty rebuild / round-boundary trigger decision 的 runtime truth
- 後續 build slices 的正式 handoff 邊界

### OUT
- 完整產品化 interaction polish
- 背景 AI classifier / semantic governor
- 全面重寫 session runtime / processor substrate
- remote-terminal 本體實作

## What Changes

- 將 `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/` 升格為 `specs/dialog_trigger_framework/`
- 建立 proposal/spec/design/handoff 的 semantic root，供後續 planner/runtime 相關工作引用
- 保留原 plan 作為 historical execution package，是否刪除由後續明確指示決定

## Impact

- `specs/architecture.md` 中關於 dialog trigger / planner lifecycle 的敘述將有正式 companion spec root 可回指
- 後續若修 `plan_enter` slug derivation、補 trigger registry、整合 approval routing，可直接以此 root 為 formal reference
- 降低 dated plan 名稱與主題不一致造成的理解成本
