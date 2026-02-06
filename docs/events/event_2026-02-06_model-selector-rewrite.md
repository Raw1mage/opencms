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
3. [ ] 調查 `model-selector` skill 的實作代碼。
4. [ ] 擬定重構方案（移出內文、優化觸發邏輯）。
5. [ ] 等待使用者確認後執行。

**待解問題**

- 需要確認 `model-selector` skill 目前是純文字指引還是具備腳本邏輯。
