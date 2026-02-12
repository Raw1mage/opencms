---
name: model-selector
description: 根據任務類型分析並建議最適合的模型選擇策略。
---

# 模型選擇指引

## Provider 資源特性

### 1. Antigravity

- **模型分組**：這個provider下面包含多個模型，目前分為兩個主要系列
  - **主系列**：Gemini系列
  - **副系列**：Claude系列
- **額度**：
  - **主系列**：5 小時 reset，無限再生
  - **副系列**：有週用量限制，可用量極小
- **優勢**：推理能力強
- **適用**：系統預設主對話
- **注意**：優先使用Gemini系列模型。針對需要大量思考的任務，可以考慮使用Claude系列模型，但要注意用量限制。Claude系列模型容易忘記system prompt的內容，需要經常提醒它重新加載AGENTS.md。

### 2. Gemini-cli

- **額度**：120 req/min, 1500 req/day
- **適用**：每一個要求丟一個中大型任務包
- **注意**：稀缺資源，描述完整讓它一次跑久

### 3. OpenAI

- **額度**：task-based 計算，5hr & 週限制
- **優勢**：品質高
- **適用**：程式主力
- **注意**：稀缺資源，計費複雜

### 4. Google-API

- **額度**：Gemini 3 Flash / 2.5 Flash / 2.5 Flash lite 各 20 次/日
- **適用**：額外補充戰力，每一個要求丟一個中大型任務包
- **注意**：沒事不要跟它說話，會浪費次數

### 5. GMICloud

- **額度**：$0.5/M tokens (in), $2.18/M tokens (out)，現現 $25
- **模型**：Deepseek R1
- **適用**：小型 subagent、tool call 試玩
- **注意**：短期試用額度

### 6. Claude-cli

- **額度**：有 5 小時用量限制，以及每週用量限制。計算公式不明。
- **模型**：Haiku 4.5, Opus 4.6, Sonnet 4.5 等。實際可用清單請執行 `/models` 查看。
- **適用**：超級強大的程式代碼救火隊。
- **注意**：珍貴的付費資源，除非使用者要求，沒事不要主動輪用。

---

## 任務類型分類

### 程式編碼 (Coding)

**特徵**：撰寫、除錯、重構、實作功能

**建議**：OpenAI（品質高）、Antigravity（額度寬鬆）

### 文件撰寫 (Writing)

**特徵**：文章、文件、翻譯、使用者介面文字

**建議**：Antigravity（額度寬鬆）

### 分析推理 (Analysis)

**特徵**：資料分析、程式碼審查、架構分析、問題解決

**建議**：Antigravity（推理能力）、OpenAI（深度分析）

### 規劃設計 (Planning)

**特徵**：系統設計、複雜規劃、多步驟推理

**建議**：OpenAI（品質高）、Gemini-cli（一次完整任務）

### 批量任務 (Batch)

**特徵**：每一個要求丟一個中大型任務包、需長時間執行

**建議**：Gemini-cli、Google-API

### 輕量任務 (Lightweight)

**特徵**：小型 subagent、tool call、簡單查詢

**建議**：Antigravity、Claude-cli

---

## 系統機制

- **rotation3d**：動態多帳號多模型切換系統。
  - **自動模式**：系統根據負載與額度自動分配。
  - **LLM 控制模式**：Agent 可根據任務複雜度，透過 `Task` 工具的 `subagent_type` 或直接執行指令干預切換。
- **用量監控**：Antigravity、OpenAI 已實作。

---

## LLM 主動換模指引 (LLM-Driven Switching)

當你發現當前模型表現不佳（如：邏輯死循環、無法理解複雜 Context、頻繁出錯）時，**你必須**考慮切換模型。

### 1. 指令控制 (Direct Command)

在 `EXECUTION` 階段，你可以直接在 Bash 中執行以下指令：

- `/models list`：查看當前可用模型與 Provider 狀態。
- `/models set <provider>:<model>`：強制切換當前 Session 的模型。
- `/admin`：進入管理介面調整全域權重。

### 2. 任務分發控制 (Task Dispatch)

在呼叫 `Task()` 工具時，透過設定 `subagent_type` 觸發 `rotation3d` 的特定路由：

- 若需高精準度：指定 `subagent_type: "coding"` (通常路由至 OpenAI/Claude)。
- 若需處理海量資料：指定 `subagent_type: "batch"` (路由至 Gemini-cli)。
- 若需快速驗證：指定 `subagent_type: "lightweight"` (路由至 Flash 系模型)。

### 3. 換模決策時機

- **升級 (Upscale)**：當 Antigravity (Gemini) 無法解決複雜邏輯時，主動切換至 OpenAI 或 Claude-cli。
- **降級 (Downscale)**：當執行簡單檔案操作或查詢時，應主動切換回 Antigravity 以節省高價值額度。
- **逃生 (Escape)**：遇到 Provider 故障或持續 Rate Limit 時，立即切換至備用 Provider。

---

## 建議輸出格式

```
[模型建議]
任務類型：<類型>
建議 Provider：<provider>
操作方式：使用 /admin 或/models 切換模型
```
