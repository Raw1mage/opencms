# Event: Beta continuation trigger-ref flush execution closeout

## 需求

- 完成 `beta/continuation-trigger-ref-flush` 實作切片收尾，補齊文件化驗證與 architecture sync 記錄。
- 對齊 plan contract：
  - A-trigger-only flush decision
  - replay `checkpointPrefix + rawTailSteps`
  - invalidation full-state snapshot logging + redaction

## 範圍

### IN

- `/home/pkcs12/projects/opencode-worktrees/beta-continuation-trigger-ref-flush/packages/opencode/src/session/message-v2.ts`
- `/home/pkcs12/projects/opencode-worktrees/beta-continuation-trigger-ref-flush/packages/opencode/test/session/message-v2.test.ts`
- `/home/pkcs12/projects/opencode-worktrees/beta-continuation-trigger-ref-flush/packages/opencode/src/session/compaction.test.ts`
- `/home/pkcs12/projects/opencode/plans/20260402_plans/tasks.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260403_beta_continuation_trigger_ref_flush_execution.md`

### OUT

- 不做 commit / push
- 不新增 fallback 機制
- 不修改非本 slice 必要模組

## 任務清單（對應 tasks.md）

- [x] beta1：A-trigger decision 落地與 replay metadata flush gate 對齊
- [x] beta2：identity-aware remote continuity flush 行為確認
- [x] beta3：checkpoint+tail replay 契約驗證
- [x] beta4：invalidation full-state snapshot + redaction logging 落地
- [x] beta5：單元測試矩陣執行與通過
- [x] beta6：event/docs/architecture sync closeout

## Key Decisions

1. Flush 決策以 `evaluateContinuationReset()` 的 A-trigger 命中結果為唯一來源，不維持 B 條件分支。
2. Remote flush 只清理 provider remote refs / sticky continuity metadata，不破壞本地 checkpoint/tail semantic assets。
3. Invalidation logging 採既有 runtime logger，輸出 structured snapshot，並以 redaction 規則避免敏感資訊外洩。

## 實作摘要

- `message-v2.ts`
  - 新增 continuation reset decision 型別與 `evaluateContinuationReset()`。
  - 對 assistant replay 路徑套用 identity-aware metadata flush。
  - 新增 `buildInvalidationDebugSnapshot()` 與敏感字串遮罩邏輯（authorization/api_key/token/secret/cookie）。
  - 在 metadata 保留/清理路徑加入 checkpoint evidence（preserved/flushed）。

- `message-v2.test.ts`
  - 補齊 account-aware metadata gate 測試。
  - 補齊「flush 只清 remote refs、不清 semantic content」測試。
  - 補齊 invalidation snapshot 欄位完整性與 redaction 測試。

- `compaction.test.ts`
  - 補齊 `checkpoint + raw tail` replay 組裝行為測試。

## Validation

- 測試（beta worktree）
  - `message-v2.test.ts`: 31 pass / 0 fail
  - `compaction.test.ts`: 7 pass / 0 fail

- Policy 對齊
  - A-trigger-only: ✅
  - checkpoint+tail replay: ✅
  - full-state + redaction logging: ✅

- Architecture Sync
  - Verified (No doc changes)
  - 依據：本次為 `session/message-v2` 與對應測試面的行為收斂，未新增模組邊界、未改變跨模組資料流或狀態機 ownership。

## Remaining

- 若使用者要求後續 finalize/fetch-back 流程，再進入 beta workflow 下一階段操作。
