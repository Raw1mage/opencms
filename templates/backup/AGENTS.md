# OpenCode 全域 Agent 指引 (Global Agent Instructions)

本文件定義 OpenCode Agent 的開發生命週期規範。所有 Agent 必須嚴格遵守以下流程。

---

## 第一階段：會話啟動 (Session Initialization)

### 1. 選用技能載入

工作階段啟動時，可依需求載入以下技能：

```javascript
skill({ name: "agent-workflow" }) // 啟用多重 Agent 協作編排
```

---

## 第二階段：需求分析與溝通 (Analysis & Communication)

### 1. 溝通準則

- **優先回應**：在開始任何編碼任務前，先回答使用者的問題或確認請求。
- **語言規範**：與使用者的所有溝通必須使用 **繁體中文**。
- **行動前解釋**：在進入長達 10 分鐘以上的編碼區塊前，先解釋你即將執行的動作。

### 2. 需求釐清流程 [ANALYSIS]

- **當前狀態**：明確標示為 `[ANALYSIS]`。
- **工具限制**：僅允許使用唯讀工具（`read`, `glob`, `grep`, `ls`, `cat`）。
- **釐清問題**：使用 `mcp_question` 提出多選題以精確定位需求。
- **確認理解**：向使用者總結需求，確保雙方認知一致。

---

## 第三階段：任務規劃 (Planning & Architecture)

### 1. 絕對工作流程狀態機

必須嚴格遵守狀態轉換，嚴禁跳過：

1. **[ANALYSIS]**：收集資訊，定位問題。
2. **[PLANNING]**：產出計畫檔案（`docs/events/event_*.md`）。
3. **[WAITING_APPROVAL]**：等待使用者輸入 "OK", "Proceed" 或 "開始"。
4. **[EXECUTION]**：獲得授權後，執行已確認的計畫。

### 2. 建立計畫檔案

在編寫任何程式碼前，必須建立或更新 `docs/events/event_$date.md`，內容格式如下：

```markdown
#### 功能：<名稱>

**需求**

- <釐清後的重點>
  **範圍**
- IN：<包含項目> | OUT：<排除項目>
  **方法**
- <高層次實作策略>
  **任務**

1. [ ] <任務 1>
2. [ ] <任務 2>
       **待解問題**

- <未決項目>
```

### 3. 更新 DIARY 索引

將任務摘要與 event 檔案連結記錄於 `docs/DIARY.md`。DIARY 僅作為索引，不記錄具體細節。

---

## 第四階段：執行與實作 (Execution & Implementation)

### 1. 執行守則 [EXECUTION]

- **違規防護**：呼叫 `edit`, `write`, `task` 前必須確認：
  1. 我現在處於 `[EXECUTION]` 狀態嗎？
  2. 我獲得明確授權了嗎？
- **最小改動**：遵循「先讀再改、最小改動、再讀驗證」的原則。

### 2. 工具使用規範

- **`Task` 限制**：
  - 嚴禁使用 `Task` 進行需求釐清或計畫擬定。
  - 僅適用於：重型編碼、深度檔案探索、自動化測試。
- **安全作業 SOP**：
  - **rm 流程**：列出清單 -> 確認真實路徑 -> 二次確認 -> 執行 -> 驗證。
  - **搜尋流程**：先 `glob` 縮小範圍 -> 必要時再 `grep`。

### 3. 多重 Agent 工作流

對於複雜任務，使用具備回饋迴圈的專門 Agent (Coding, Review, Testing, Docs)。

---

## 第五階段：變更紀錄與註解 (Knowledge Record)

### 1. Event 註解規範

每次修改代碼或文件，**必須**附上 `@event_<date>:<issue_name>` 註解。

- 格式：使用檔案語法的行內註解（如 `//`, `#`, `<!-- -->`）。
- 目的：將變更內容與 `docs/events/` 的紀錄串連，方便追蹤歷史。
- 若涉及多個事件，以逗點分隔：`@event_2026-02-06:auth,event_2026-02-07:xdg`。

### 2. 更新紀錄同步

實作過程中的變動應即時反映在對應的 event 檔案（CHANGELOG / DEBUGLOG）中。

---

## 第六階段：診斷與日誌 (Debugging)

### 1. 系統除錯框架

本專案使用統一的 `debugCheckpoint` 框架。

- **日誌位置**：`~/.local/share/opencode/log/debug.log` (或由 `Global.Path.log` 指定)。
- **操作指引**：遇到異常時，優先檢查此日誌以獲取執行軌跡。
