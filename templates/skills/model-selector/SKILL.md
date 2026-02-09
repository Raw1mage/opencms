---
name: model-selector
description: 根據任務類型分析並建議最適合的模型選擇策略。
---

# 模型選擇指引

## Provider 資源特性

### 1. Antigravity

- **額度**：5 小時 reset，無限再生
- **優勢**：推理能力強
- **適用**：系統預設主對話
- **注意**：容易發散跳針，需嚴謹 system prompt 控制穩定性

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
- **模型**：Haiku 3, Haiku 4.5, Opus 3, Opus 4.5, Opus 4.6, Sonnet 4, Sonnet 4.5
- **適用**：超級強大的程式代碼救火隊。
- **注意**：珍貴的付費資源，除非使用者要求，沒事不要主動輪用。

---

## 系統機制

- **rotation3d**：動態多帳號多模型切換，善用上述資源
- **用量監控**：Antigravity、OpenAI 已實作

---

## Fallback 機制

當模型遇到 rate limit 或錯誤時，依序嘗試下一個 Provider。

```
Primary → Fallback 1 → Fallback 2 → Last Resort → HALT
```

### Rate Limit 偵測

偵測以下錯誤模式並觸發 fallback：

- `429 Too Many Requests`
- `rate_limit_exceeded`
- `quota exceeded`
- `resource_exhausted`
- `capacity` errors
- Timeout > 60 seconds

### Fallback 報告格式

```
[MODEL FALLBACK]
Agent: <agent name>
Failed Provider: <provider that failed>
Error: <brief error description>
Switching to: <fallback provider>
Attempt: <n of max>
```

### Halt 協議

當所有 Provider 都用盡時：

```
[WORKFLOW HALTED]
Agent: <agent name>
Reason: All providers exhausted
Tried:
  1. <provider 1>: <error>
  2. <provider 2>: <error>
  ...

Action Required: User intervention needed
Options:
  - Wait for rate limits to reset
  - Provide alternative API keys
  - Reduce task scope and retry
```

**重要**：不可靜默繼續，必須停止並回報使用者。

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

**建議**：GMICloud（試玩）、Antigravity

---

## 建議輸出格式

```
[模型建議]
任務類型：<類型>
建議 Provider：<provider>
操作方式：使用 /admin 切換模型
```
