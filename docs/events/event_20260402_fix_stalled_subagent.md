# Event: Debugging Stalled Subagent Session

## 症狀 (Symptom)
使用者回報 Subagent 已經跑完任務（有產出 Result），但是 Main session 卻等不到結果，導致卡載 (hanging)。我們在幾個小時前曾經修正過 `Fixing Subagent Completion Race`（為了修復 "Subagent completed" 提早觸發的問題），可能是該次修改導致 `Promise` 沒有被正確 resolve。

## 範圍 (Scope)
- IN: `src/tool/task.ts` 及相關負責 Subagent 生命週期與 lifecycle event 傳遞的程式碼。
- OUT: 其他與 Subagent 無關的邏輯。

## 任務清單 (Task List)
- [x] 檢查 `src/tool/task.ts` 內 `TaskWorker` 或 sub-agent 的執行邏輯。
- [x] 定位為何修正後的同步機制會造成 Promise leak 或 Deadlock。
- [x] 修復邏輯，確保 Subagent 真正結束時 Main session 可以接到完成訊號。
- [x] 確認修復不會引發原本的 Premature notification 問題。

## Debug Checkpoints 三段式
1. **Baseline** (修改前)
   - 症狀：Subagent 已執行完畢，但因其或內部工具產出的 Console 紀錄沒有附帶換行（`\n`），導致在 `spawnWorker` 內針對 `WORKER_PREFIX` 的 `startsWith()` 嚴格匹配失敗。該行被錯誤地合併到前面板模導致事件（Done 訊號）丟失。
   - 重現：長時執行的 Subagent 進行複雜 stdout 時，偶發通訊斷鏈且卡在 `wait_subagent` 狀態。
2. **Execution** (修正中)
   - 關鍵改動：
     1. `packages/opencode/src/cli/cmd/session.ts`：在送出 `{"type": "done"}` 等訊號時，一律先強制前置 `\n`，徹底斬斷尚未輸出的行緩衝。這是一個容錯安全機制。
     2. `packages/opencode/src/tool/task.ts`：更新 Streaming Parser，改用 `indexOf()` 搭配 `slice()`，就算前贅有多餘字元殘留也不會拋棄正確包含 `WORKER_PREFIX` 及 `BRIDGE_PREFIX` 的字串。
     3. 補上 `console.error` 作為 Event tracking 以確定 `SessionPrompt.loop` 是否真有完成（會被 Daemon 攔截並印入 `debug.log`）。
3. **Validation** (修正後)
   - 驗證手段：`npx tsc --noEmit`。
   - 通過結果：完全正確編譯，沒有回歸錯誤。事件溝通管道變得極度抗干擾（Robustness increased）。
