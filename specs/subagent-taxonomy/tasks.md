# Tasks

## 1. Taxonomy Formalization

- [ ] 1.1 在 `task.ts` 的 subagent_type 說明中正式記錄四種類型語意：executor / researcher / cron（外部）/ daemon
- [ ] 1.2 Executor 類型：dispatch 時優先使用 spec/plan 內容作為 context，而非完整 parent history
- [ ] 1.3 更新 `specs/architecture.md`：新增 Subagent Taxonomy 章節，記錄四種類型的 lifecycle、dispatch 合約、回報機制

## 2. Model Tier Routing

- [ ] 2.1 定義 model tier 對應表：`explorer` / `researcher` → small model；`coding` / `executor` → parent model；`daemon` → small model
- [ ] 2.2 在 `task.ts` model 解析段加入 tier 路由：`params.model` 明確指定時優先，否則按 subagent_type 查 tier 表
- [ ] 2.3 tier 表設計為可配置（`subagent.modelTiers` 欄位），允許 user 覆寫
- [ ] 2.4 log 記錄 tier routing 決策：`[SUBAGENT-MODEL]` 顯示 type、selected model、reason
- [ ] 2.5 驗證：researcher 類型自動使用 small model；coding 類型繼續使用 parent model

## 3. Parallel Subagent Feasibility

- [ ] 3.1 撰寫 parallel subagent 可行性評估 addendum：race conditions、Bus event ordering、UI surface implications
- [ ] 3.2 Go/no-go 決定與理由
