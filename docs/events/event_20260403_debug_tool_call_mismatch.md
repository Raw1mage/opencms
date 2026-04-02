# Event: Debug Tool Call Mismatch & Stream Interrupted

- **ID**: `20260403_debug_tool_call_mismatch`
- **Topic**: 處理 `./webctl.sh restart` 導致的 Session Orchestrator Tool Call ID 遺失問題。
- **Status**: 🟢 In-Progress (Trouble Shooting)

## 需求 (Requirements)
1. 恢復因重啟而中斷的 `beta6` 任務：同步 event log 並完成 Architecture Sync。
2. 診斷 `No tool call found` 錯誤原因，確認是否為正常重啟後的遺留（Stale）訊號。
3. **優化 Agent Tool-Use 策略**：針對 Gemini 3 Flash 模型在執行 shell command 時的頻繁掛死問題進行策略修正（例如強制 PAGER=cat, 非交互模式）。

## 範圍 (Scope)
- **IN**: 檢查 `debug.log` 關於 `call_id` 的記錄；優化 Agent 呼叫 `run_command` 的參數與前綴。
- **OUT**: 修改核心 Tool Call 佇列邏輯。

## 任務清單 (Task List)
- [ ] **Baseline**: 查閱 `debug.log` 確認 `call_id call_ofP84yMXMk9Hga79I7dPHo2u` 的時序。
- [ ] **Sync**: 確認 `packages/opencode/src/tool/task.ts` 是否仍符合預期。
- [ ] **Execution**: 手動補齊 `event_20260402_fix_stalled_subagent.md` 的 `beta5` 完成記錄。
- [ ] **Validation**: 完成 `Architecture Sync`。
