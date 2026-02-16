# 架構：Dialog 主會話 + Sub-session 分工

## 概覽

主會話（main session）由 dialog agent 處理對話、規劃與任務分派；
具體執行由多個 sub-session 承擔，並依任務性質挑選最合適的模型與角色。

## 組件

| 組件           | 職責                       | 依賴                  |
| -------------- | -------------------------- | --------------------- |
| Dialog Agent   | 對話、規劃、任務分類與分派 | SessionPrompt, Agent  |
| Sub-session    | 執行任務、產出結果         | TaskTool, Agent       |
| Model Selector | 依任務特性選模型池         | Favorites, rotation3d |
| Rotation3D     | 可用模型向量選擇           | account/rotation3d    |

## 資料流

1. User → Main session (dialog agent)
2. Dialog agent 分類任務 → 產生 SubtaskPart
3. Task pipeline 依 SubtaskPart 建立 sub-session
4. Sub-session 使用工具/再分派 → 回傳結果
5. Main session 整合結果 → 回覆使用者

## 介面

- 輸入：使用者訊息、上下文
- 輸出：主會話回覆 + 多個 sub-session 結果

## 錯誤處理

- Sub-session 失敗：回報錯誤資訊，主會話決定重試或降級。
- Model 不可用：rotation3d 依候選池自動切換。

## 安全性考量

- 主會話僅分派；工具權限仍由 Permission 規則控管。
- Sub-session 可再分派，但受同一權限系統限制。
