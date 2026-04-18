# Tasks

## 1. Contract 定案（draft SKILL.md + state schema）

- [ ] 1.1 Draft `SKILL.md` for plan-builder：含七大狀態段、七種 mode 段、state × artifact 矩陣、mode × 轉換矩陣、migration 段、與 planner 差異表
- [ ] 1.2 Draft `schemas/state.schema.json`：定義 state enum、history entry 格式、profile optional array、JSON Schema draft-07 相容
- [ ] 1.3 校對兩份 draft 互相一致：state 名稱、欄位用詞、範例 state.json 可通過 schema 驗證
- [ ] 1.4 取得使用者 review approval（**stop gate**）

## 2. Core scripts 實作

- [ ] 2.1 Implement `scripts/lib/state-inference.ts`：輸入 legacy path，依推斷規則表回傳 state 或拋 `StateInferenceError`
- [ ] 2.2 Implement `scripts/lib/ensure-new-format.ts`：idempotent wrapper，偵測 legacy + 呼叫 state-inference + 執行 git mv + 寫 `.state.json` + log
- [ ] 2.3 Rewrite `scripts/plan-init.ts`：只產 proposal.md + `.state.json`（state=proposed），保留舊 plans/{slug}/ 入口相容但印 deprecation 建議使用 specs/
- [ ] 2.4 Rewrite `scripts/plan-validate.ts`：讀 `.state.json.state`，依 state × artifact 矩陣動態決定驗證範圍
- [ ] 2.5 Implement `scripts/plan-state.ts`：讀印狀態 + 若舊格式先觸發 migration
- [ ] 2.6 Implement `scripts/plan-promote.ts`：驗 artifact 要求 → 合法則寫 history + 更新 state；非法則報錯
- [ ] 2.7 Implement `scripts/plan-archive.ts`：state → archived；`--move-to-archive-folder` 選項搬到 `specs/archive/{slug}-YYYY-MM-DD/`
- [ ] 2.8 Implement `scripts/plan-migrate.ts`：手動觸發 migration（與 ensureNewFormat 共用 lib）
- [ ] 2.9 Implement `scripts/plan-gaps.ts`：掃 spec 是否有缺 schema、缺 test-vectors、缺 errors 等 code-independence 漏洞，輸出建議 JSON

## 3. Artifact 模板建立

- [ ] 3.1 Create template `templates/data-schema.json`：JSON Schema 骨架 + 最少欄位要求
- [ ] 3.2 Create template `templates/test-vectors.json`：陣列格式、每筆含 `input` / `expected` / `description` 欄位
- [ ] 3.3 Create template `templates/errors.md`：required headings（Error Catalogue、Error Code Format、Recovery Strategies）
- [ ] 3.4 Create template `templates/observability.md`：required headings（Events、Metrics、Logs、Alerts）
- [ ] 3.5 Create template `templates/invariants.md`：required headings（Invariants、Rationale、Enforcement Points）
- [ ] 3.6 Create template `templates/threat-model.md`（SSDLC profile）：STRIDE × C4 component 結構
- [ ] 3.7 Create template `templates/data-classification.md`（SSDLC profile）：PII 流向 × Sequence message 結構
- [ ] 3.8 Create template `templates/compliance-map.md`（SSDLC profile）：Requirement ↔ control 雙向表
- [ ] 3.9 Update `plan-init.ts`：依 `.state.json.state` 與 `.state.json.profile` 觸發對應模板生成（promote 到 designed 時補 design/spec/idef0/...，啟用 ssdlc profile 時補三類安全 artifact）

## 4. Skill 部署 + 舊 skill deprecation

- [ ] 4.1 部署 `plan-builder` skill 到使用者核准位置（`~/.claude/skills/plan-builder/` 預設）
- [ ] 4.2 `/plan-builder` slash command 載入驗證
- [ ] 4.3 舊 `planner` SKILL.md 頂端加 deprecation banner + 指向 `/plan-builder`
- [ ] 4.4 `/planner` 仍可觸發（不禁用），載入時顯示過渡提示

## 5. Dog-fooding migration 驗證

- [ ] 5.1 在本 repo 對本 plan 路徑執行 `bun run plan-state.ts plans/plan-builder/`
- [ ] 5.2 驗證自動 migration：`plans/plan-builder/` 已不存在，`specs/plan-builder/` 存在且含 `.state.json`
- [ ] 5.3 驗證 `.state.json.state = "implementing"`（因 tasks.md 有已勾選項）
- [ ] 5.4 驗證 `specs/plan-builder/.archive/pre-migration-YYYYMMDD/` 快照存在
- [ ] 5.5 驗證 `git log --follow specs/plan-builder/proposal.md` 可追溯到 `plans/plan-builder/proposal.md`
- [ ] 5.6 驗證所有 migration 動作有 `[plan-builder-migrate]` log 輸出
- [ ] 5.7 手動建構異常 legacy（只有 tasks.md 無 proposal.md）測試 `StateInferenceError` 拋出正確

## 6. 文件與事件紀錄

- [ ] 6.1 Update `specs/architecture.md`：新增 plan-builder 段落描述 skill + scripts + schema 架構
- [ ] 6.2 Create `docs/events/YYYY-MM-DD-plan-builder-launch.md`：記錄架構決議、dog-fooding 結果、共存期策略
- [ ] 6.3 Promote 本 plan 到 `verified` 狀態（全 tasks 勾選 + 收集 validation evidence）
- [ ] 6.4 Promote 本 plan 到 `living` 狀態（merge 後）

## 7. 下游同步（批次，Phase 3 完成後）

- [ ] 7.1 Update `beta-workflow` skill：tasks.md 路徑 `plans/{slug}/` → `specs/{slug}/` + 每 task 勾選後 hook 呼叫 `plan-sync.ts`
- [ ] 7.2 Update `agent-workflow` skill：任何 `/plans/` 或 `planner` 字串
- [ ] 7.3 Update `miatdiagram` skill：內部路徑 constants
- [ ] 7.4 Update `code-thinker` skill：cross-reference
- [ ] 7.5 Update `templates/AGENTS.md` + `templates/prompts/SYSTEM.md`：plan mode / plans 資料夾相關段落
- [ ] 7.6 Update `templates/prompts/enablement.json`：skill 名稱與 description
- [ ] 7.7 Remove `/planner` alias（視 telemetry 決定時機，可能延至下一大版本）

## 8. Sync 與 Per-part History 基礎設施

- [ ] 8.1 Implement `scripts/plan-sync.ts`：git diff + 對比 spec artifact 欄位、輸出 `[plan-sync] WARN`、寫入 `.state.json.history`
- [ ] 8.2 Implement `scripts/lib/inline-delta.ts`：inline marker 工具（`~~strikethrough~~`、`[SUPERSEDED by X]`、`(vN, ADDED YYYY-MM-DD)` 等標記注入 helper）
- [ ] 8.3 Implement `scripts/lib/snapshot.ts`：refactor snapshot helper（git mv current artifact 到 `.history/refactor-YYYY-MM-DD/`）
- [ ] 8.4 Implement `scripts/plan-rollback-refactor.ts`：從 `.history/refactor-*/` 逆向還原 snapshot 前狀態
- [ ] 8.5 Extend `plan-promote.ts --mode refactor`：呼叫 snapshot lib 自動搬 artifact 再 reset 當前檔案到 proposed 骨架
- [ ] 8.6 Extend `plan-promote.ts --mode amend/revise/extend`：呼叫 inline-delta lib 自動注入 supersede marker
- [ ] 8.7 驗證 warn 策略：人工佈置 drift fixture，確認 `plan-sync.ts` 輸出 WARN、寫 history、但 exit code 為 0（不擋後續流程）
- [ ] 8.8 驗證 rollback：對 refactor 過的 fixture 執行 rollback，確認 artifact 還原正確且 history 記錄 rollback 事件

Note: unchecked checklist items are the runtime todo seed for build agents. Checked items remain for audit trail but are not re-materialized as new todos.
