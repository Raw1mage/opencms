# 2026-03-25 Subagent Stop Signal Race

## 需求

釐清為何 subagent 大多能正常回傳，但少數情況會卡在「還在等 subagent」的狀態，並修正為 fail-fast 的正確收尾流程。

## 範圍

### IN

- 調查 `TaskWorkerEvent.Done/Failed` → parent continuation → active-child cleanup → resume 的完整路徑
- 最小修正 completion / cleanup 時序
- 補齊針對性測試與驗證
- 同步 `specs/architecture.md`

### OUT

- 不重做 subagent IPC
- 不新增 fallback mechanism
- 不改變既有 task dispatch / resume 的整體架構

## 任務清單

- [x] 驗證 debug log 與 session output，確認不是完全無回傳，而是少數卡住的 race 狀況
- [x] 檢查 `task-worker-continuation.ts` 的 completion/cleanup 控制路徑
- [x] 最小修正：提早清除 active-child 狀態
- [x] 修正與補強針對性測試 fixture
- [x] 驗證測試通過
- [x] 同步架構文件

## Key Decisions

- 將問題定性為 **少數狀態下的 cleanup race**，不是整體回傳機制失效。
- `active-child` 被視為父 session 的控制平面狀態，不是獨立 process。
- completion 收到後，應先清除 active-child，再進行後續 persistence / resume，避免 parent 還掛著等待狀態。

## Issues Found

- 原流程中 active-child 清理太晚，讓 parent 短暫維持「還在等」的假象。
- failure case 的測試期望與現行 `Todo.reconcileProgress(..., taskStatus: "error")` 語意不一致。

## Verification

- `bun test packages/opencode/src/bus/subscribers/task-worker-continuation.test.ts` ✅
- success / failure 兩條測試均通過。

## Architecture Sync

- `specs/architecture.md`: 已同步，新增 active-child / bus / worker lifecycle 的 race 與收尾順序說明。
