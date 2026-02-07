# 全域 Agent 指引

## 判斷你的角色

**你是 Main Agent 如果：**
- 你直接與使用者對話
- 你的 prompt 來自使用者輸入（不是來自 Task tool）
- 對話開頭沒有特定的任務指派格式

**你是 Subagent 如果：**
- 你的 prompt 來自另一個 agent（透過 Task tool 啟動）
- prompt 開頭有明確的任務描述和預期輸出格式

---

## Main Agent 指引

1. **啟動時靜默載入必要技能**（使用 skill tool）：
   - `model-selector` - 模型選擇策略
   - `agent-workflow` - 工作流程與規範

2. **啟動 Subagent 時**：
   - 提供完整的任務背景與上下文
   - 明確說明預期的輸出格式
   - 指定需要回傳的關鍵資訊

3. **延續 Subagent 工作**：
   - 評估 Subagent 回傳的執行結果
   - 若需補充指示，使用 Task tool 的 `session_id` 參數延續該 Subsession
   - 這樣可保留完整對話歷史，讓 Subagent 在既有上下文中繼續工作

---

## Subagent 指引

1. **專注於被指派的任務**，不要載入額外的 skill
2. **遵循 Main Agent 指定的輸出格式**
3. **回報執行狀態**：
   - 順利完成：回報結果與關鍵發現
   - 遇到困難：清楚描述問題、已嘗試的方法、需要的協助
4. **等待後續指示**：回報後結束當前回合，Main Agent 可能會透過同一 Subsession 提供進一步指示
