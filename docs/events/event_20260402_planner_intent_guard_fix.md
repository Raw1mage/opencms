# Event: Planner intent guard fix for plan_exit blockage

## 需求

- 使用者已明確要求 `plan_exit`，但實際執行被 `planner_intent_mismatch` 阻擋。
- 需要修復 planner intent guard，確保規劃流程可由 planning 正常退出。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/tool-invoker.ts`
- planner 相關測試：
  - `/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts`
  - `/home/pkcs12/projects/opencode/packages/opencode/test/session/dialog-trigger.test.ts`

### OUT

- 不涉及本次 checkpoint/replay 主題功能實作
- 不做 commit/push

## Root Cause

- `tool-invoker` 的 planner intent guard 使用過度嚴格的雙向互斥檢查。
- 在 `committedPlannerIntent=plan_enter` 狀態下，`plan_exit` 被誤判為 opposite-direction 而拒絕。
- 導致使用者已在 planning 流程中仍無法正常退出規劃。

## Changes

- 調整 `assertPlannerIntentConsistency(...)` 的判定方向為**單向保護**：
  - 只在 `committedPlannerIntent === "plan_exit"` 且工具為 `plan_enter` 時阻擋。
- 移除原本會阻擋 `plan_enter -> plan_exit` 的錯誤互斥路徑。

## Validation

- `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts"` ✅ (37 pass / 0 fail)
- `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/session/dialog-trigger.test.ts"` ✅ (9 pass / 0 fail)

## Impact

- 使用者在 planning mode 可正常觸發 `plan_exit`。
- 仍保留既有安全約束：若已承諾 `plan_exit` 方向，禁止反向 `plan_enter`。

## Architecture Sync

- Verified (No doc changes)
- 依據：本次僅修正 planner tool invocation guard 邏輯，未變更 repo 長期模組邊界/資料流架構。

## Remaining

- 請重試 `plan_exit` 以確認流程恢復。
