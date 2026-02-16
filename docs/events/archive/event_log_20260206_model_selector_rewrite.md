#### 功能：重構 Model Selector Skill 並清理 AGENTS.md

**需求**

- 重寫 `model-selector` skill，將其轉化為更獨立、基於邏輯的模組。
- 將 `AGENTS.md` 中關於模型選擇的具體內文（如推薦邏輯、模型清單等）拉出，整合進 `model-selector` skill 內部。
- 確保 Subagent 在啟動時不會受到該 skill 的非預期強制干擾。

**範圍**

- IN：`docs/events/event_2026-02-06_model-selector-rewrite.md`、`.opencode/AGENTS.md`、`model-selector` skill 相關檔案。
- OUT：暫不執行具體代碼修改，直到使用者確認。

**方法**

- 建立事件紀錄與 DIARY 索引。
- 調查 `model-selector` skill 的現有實作位置。

**任務**

1. [x] 建立事件紀錄檔案。
2. [x] 更新 `docs/DIARY.md` 索引。
3. [x] 調查 `model-selector` skill 的實作代碼。
4. [x] 擬定重構方案（移出內文、優化觸發邏輯）。
5. [x] 執行重構。

**變更紀錄**

- `~/.claude/skills/model-selector/SKILL.md`：
  - 移除硬編碼的模型列表（原本列出 gpt-5.2-codex、gemini-3-pro 等具體模型）
  - 改為基於任務類型的概念性建議框架
  - 全文改為繁體中文
  - 強調動態查詢可用模型而非靜態推薦

- `.opencode/AGENTS.md`：
  - 移除 `skill({ name: "model-selector" })` 強制載入指令
  - 改為選用技能

- `templates/AGENTS.md`：
  - 同步移除 model-selector 強制載入指令
