# 全域 Agent 指引 (Global Agent Instructions)

---

## 工作階段啟動 - 必備技能 (Session Start - Required Skills)

工作階段啟動時，請立即載入以下技能：

```javascript
skill({ name: "model-selector" }) // 針對任務最佳化模型選擇
skill({ name: "agent-workflow" }) // 多重 Agent 協作編排
```

---

## Communication Flow

- **Respond First**: Always answer the user's questions or acknowledge their request before starting any coding task.
- **Analyze & Plan**: Provide a brief analysis of the problem and your proposed plan of action.
- **Clarify & Act**: 使用多選題釐清需求。完成需求釐清與 PLANNING 後，直接更新 event 紀錄並開始實作，避免冗餘的重複確認。
- **Explain Actions**: Avoid jumping into long coding blocks (10+ minutes) without first explaining what you are about to do.
- **Language**: Use Traditional Chinese (繁體中文) for all communication with the user.

---

## 工具使用規範 (Tool Usage Guardrails) - **強制執行**

### `Task` 工具使用限制

- **NO GHOST CONVERSATIONS**: **嚴禁**使用 `Task` 工具進行需求釐清、計畫擬定或與使用者溝通。所有溝通必須在 **Main Session** 進行。
- **STOP BEFORE CODING**: 若 Main Session 中尚未有使用者確認的計畫，**禁止**呼叫 `Task` 進行 coding。
- **適用場景**：`Task` 僅可用於：
  - 繁重的實作細節 (Heavy Coding)。
  - 深度檔案探索 (Deep Exploration)。
  - 自動化測試 (Automated Testing)。

### 流程檢查點 (Process Checkpoints)

1. **Analysis**: 使用 `read`, `glob`, `grep`, `mcp_question`。**禁用 `edit`, `write`**。
2. **Planning**: 必須在 Main Session 輸出符合 `event_*.md` 格式的計畫。
3. **User Approval**: 等待使用者確認 (e.g., "OK", "Proceed")。
4. **Execution**: **解鎖 `edit`, `write` 與 `Task` (Coding) 工具**。

---

## 知識紀錄 (Knowledge Record)

- 主要知識記錄索引為 `docs/DIARY.md`。
- 具體開發紀錄（PLANNING / DEBUGLOG / CHANGELOG）儲存於 `docs/events/event_$date.md`。
- DIARY 僅作為事件索引，記錄日期、任務摘要及指向對應 event 檔案的連結。
- 不再生成獨立的 `PLANNING.md` 或 `ARCHITECTURE.md` 檔案。
- 所有紀錄依日期排序，並以繁體中文撰寫。

---

## 需求釐清 (Requirements Clarification) - **強制執行**

收到開發請求時，在編寫程式碼前，**務必**先進行釐清：

### 步驟 1：提出釐清問題

使用 `mcp_question` 工具提出多選題。

### 步驟 2：確認理解並行動 (Clarify & Act)

向使用者總結需求。**完成需求釐清後，直接更新開發紀錄並開始實作，不再冗餘地詢問「是否開始規劃」。**

---

## 規劃與架構 (Planning & Architecture) - **強制執行**

在編寫 **任何** 程式碼之前，請先記錄計畫：

### 步驟 1：建立或更新 docs/events/event\_$date.md

每個具體開發任務（Mission/Task）應記錄於專案根目錄下的事件檔案中：

```markdown
#### 功能：<名稱>

**需求**

- <釐清後的條列重點>

**範圍**

- IN：<包含項目>
- OUT：<排除項目>

**方法**

- <高層次策略>

**任務**

1. [ ] <任務 1>
2. [ ] <任務 2>

**待解問題**

- <任何未解決項目>
```

### 步驟 2：更新 docs/DIARY.md 索引

`docs/DIARY.md` 僅作為事件索引，記錄日期、任務摘要及指向對應 event 檔案的連結。

### 步驟 3：驗證與實作

- 確保流程合乎邏輯且無死角。
- 實作過程中發生的變動，請更新對應的 event 檔案（CHANGELOG/DEBUGLOG）。
- 需求釐清後直接實作，不需再詢問「是否開始規劃」。

---

## 系統除錯與日誌 (Debugging)

本專案實作了統一的 `debugCheckpoint` 框架，用於集中收集系統運作問題。

- **日誌位置**：`<repo>/logs/debug.log`
- **機制說明**：系統關鍵組件（如 `rotation3d`）會透過 `debugCheckpoint` 寫入結構化日誌。
- **Agent 指引**：遇到問題（如 fallback 異常、邏輯錯誤）時，請優先檢查此日誌檔以獲取執行軌跡。

---

## 多重 Agent 工作流 (Multi-Agent Workflow)

對於任何非瑣碎任務，請使用具備回饋迴圈的專門 Agent。模型後備鏈與計費最佳化邏輯請參閱內部手冊。

---

## 安全作業 SOP（必遵循）

### rm 安全流程

1. 列出目標清單 -> 2. 確認真實路徑 -> 3. 二次確認 -> 4. 執行刪除 -> 5. 驗證結果。

### 檔案尋址 / 搜尋流程

1. 先縮小範圍 (glob) -> 2. 避免盲搜 -> 3. 必要時再 grep -> 4. 修改前先回報路徑。

### patch / 修改流程

1. 先讀再改 -> 2. 最小改動 -> 3. 再讀驗證 -> 4. 寫入確認。
