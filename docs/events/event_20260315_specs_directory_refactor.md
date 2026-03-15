# Event: specs directory refactor

## 需求

- 使用者明確要求移除 `/specs/changes/` 這層噪音。
- planner/spec artifacts 應直接落在 `/specs/<date>_<plan-title>/`。

## 範圍

### IN
- 調整 planner path generation
- 遷移現有 `specs/changes/*` artifacts 到 canonical path
- 更新 repo 內對舊 `specs/changes/` 的引用
- 補齊 event / architecture / validation 記錄

### OUT
- 改寫 planner artifact 內容本身（除非路徑引用需要）
- 與 `/specs/` 結構無關的功能修改

## 任務清單

- [x] 掃描 `specs/changes/` 引用與目前 path 生成實作
- [x] 設計 canonical path 遷移方式
- [x] 實作遷移與引用修正
- [x] 執行 targeted validation
- [x] 同步 event 與 architecture 文件

## Debug Checkpoints

### Baseline
- 目前 repo 仍存在 `specs/changes/` 結構，與使用者要求衝突。

### Instrumentation Plan
- 搜尋所有 `specs/changes/` 引用
- 讀 planner path generation 與 handoff artifact
- 遷移後再做 targeted grep / tests 驗證

### Execution
- 已將 `specs/changes/*` 七個 artifact roots 上移到 `specs/*`。
- 中途曾過度收斂成全 repo 單一 plan；之後依使用者補充修正為正確模型：
  - repo 可有多個 plans
  - 但同一 workstream 的後續想法 / bug / slice 必須擴充回原 plan
  - 不可每段對話都開新的 sibling plan
  - 新 plan 只能由使用者主動提出，或由 AI 提議且經使用者明確同意後才可建立
- 最終收斂結果為兩個穩定 workstream roots：
  - `specs/20260315_openspec-like-planner/`
  - `specs/20260313_autorunner-spec-execution-runner/`
- 兩者目前都視為**已完成的歷史 plans**，不是持續執行中的活躍 backlog。
- 其剩餘價值主要是：
  - 回灌 `docs/ARCHITECTURE.md`
  - 未來重構時再喚醒重用
  - 作為完工復盤時的需求基線與實作對照來源
- template-only 殘留 roots 已移除。
- 已修正 repo 內大多數指向舊 `specs/changes/` 或錯誤 workstream root 的實際引用。

### Root Cause
- 先前只更新了 planner layout 規則與部分 runtime/docs，但沒有把既有 artifact roots 與歷史引用真正遷移乾淨。
- 此外，使用者原意是「同一 workstream 不要無限發散新 plan」，而不是「整個 repo 只能有單一 plan」；若未明說，模型容易把多個鄰近 slice 誤收成錯誤結構。
- 因此 repo 內同時存在：
  - `changes/` 噪音層
  - timestamp/random-slug roots
  - 同 workstream 的 plan fragmentation
  三種結構漂移。

### Validation
- `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/mission-consumption.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/index.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/tasks-checklist.test.ts"` ✅
- `bun run typecheck` (cwd=`packages/opencode`) ✅
- Final `/specs/` layout now contains exactly two canonical workstream roots ✅
- `grep specs/changes/` now only returns:
  - planner regression assertion that old path must not reappear
  - historical external `opencode-runner` event paths (not part of this repo migration)
- `specs/changes/` directory removed ✅
- 已補入新規則：需求原話保留、需求修訂歷程追蹤、完工後以 todo + 實作結果生成 validation checklist 作為復盤基礎 ✅
- Architecture Sync: Verified (No additional ARCHITECTURE.md changes needed)
