# Event: Checkpoint+Tail replay policy sync (plan-only)

## 需求

- 使用者要求先完善 plan，不進入 build。
- 明確補充 checkpoint 語義：checkpoint 僅替代被壓縮前綴，未壓縮 steps 必須維持原始 replay tail。
- 修正 policy：採 A-trigger-only flush，移除 B 保留條件段落。
- 新增需求：`text part msg_* not found` 發生當下需記錄完整 state snapshot 供後續追蹤。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/plans/20260402_plans/spec.md`
- `/home/pkcs12/projects/opencode/plans/20260402_plans/design.md`
- `/home/pkcs12/projects/opencode/plans/20260402_plans/tasks.md`

### OUT

- 不修改任何 runtime / provider / session 程式碼
- 不執行 build/test

## 任務清單

- [x] 將 spec 改為 A-trigger-only flush policy（刪除 B 保留條件）
- [x] 將 design 對齊 checkpoint+tail replay 組裝規則
- [x] 將 tasks 對齊 unit-test-first 測試矩陣
- [x] 將 debug log full-state snapshot 契約寫入 spec/design/tasks
- [x] 建立事件紀錄，保留本次決策脈絡

## 對話重點摘要

- 使用者強調「go」代表繼續完善 plan，不代表立即 build。
- 使用者確認 B 大項多餘：有 A trigger 命中就 flush 即可。
- 使用者新增核心規則：
  - 例：總 steps 1..16，checkpoint 壓縮 1..10
  - replay 必須是 `checkpoint(1..10) + raw(11..16)`
- 使用者要求：當 `text part msg_* not found` 發生時，debug log 必須能保留錯誤當下 state，供後續追蹤。

## Key Decisions

1. Flush 決策唯一來源：`any(A1..A5)`。
2. 不再維護獨立的「保留條件(B)」章節，避免雙軌規則衝突。
3. Flush scope 僅限 provider remote refs / sticky continuity；不丟 checkpoint/tail semantic assets。
4. Replay 組裝固定為 `checkpointPrefix + rawTailSteps`。
5. Invalidation failure（含 `text part msg_* not found`）必須輸出 structured full-state snapshot。
6. 本次輸出位置採現有 runtime logger；不新增 event channel。

## Validation

- Plan docs updated only:
  - `spec.md` ✅
  - `design.md` ✅
  - `tasks.md` ✅
- Build/Test: Not executed (by request)
- Architecture Sync: Verified (No doc changes)
  - 依據：本次為 plans 與 event 文件規格同步，未改 repo 長期架構邊界或資料流實作。

## Remaining

- 待使用者明確允許後，才進入 implementation slices（runtime 代碼與單元測試）。
