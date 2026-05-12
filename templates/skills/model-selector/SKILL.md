---
name: model-selector
description: 根據任務類型、當前系統負載與 API 配額，動態路由任務至最佳模型。支援流量整形與故障轉移。
---

# 模型選擇與負載均衡指引 (Load Balancing Edition)

本指引旨在解決單一 Provider 的 Rate Limit 問題，透過分散流量來最大化系統吞吐量。

## Provider 資源池 (Resource Pool)

我們將模型依據「智力/成本/速度」分為三層 (Tier)，並實施跨 Provider 的調度。

### Tier 1: 戰略核心 (High Intellect / High Cost)

_適用於：架構設計、複雜除錯、Refactoring Plan、根因分析_

1.  **OpenAI (GPT-4o)**: 邏輯最強，但 Rate Limit 最嚴格。**保留給關鍵路徑**。
2.  **Claude-cli (Opus/Sonnet)**: 程式碼能力極強，適合大型重構。**稀缺資源**。
3.  **Antigravity (Gemini-Pro)**: 預設主腦，推理能力強，額度相對寬鬆。

### Tier 2: 戰術執行 (Standard / Medium Cost)

_適用於：單元測試撰寫、單一函式實作、文件補全_

1.  **OpenAI (GPT-4o-mini)**: 速度快，適合高頻呼叫。
2.  **Antigravity (Claude-Sonnet 3.5)**: 透過 Antigravity 封裝的 Claude，共用額度池。
3.  **Gemini-cli (Pro)**: 適合批次處理大型 Context。

### Tier 3: 快速支援 (Fast / Low Cost)

_適用於：翻譯、格式化、簡單腳本、Log 分析_

1.  **Google-API (Flash)**: 極快，免費額度有限，適合一次性大量 Token 輸入。
2.  **GMICloud (Deepseek)**: 低價選項，適合非關鍵任務。

---

## 流量路由策略 (Traffic Routing Strategy)

為了避免觸發 429 錯誤，Orchestrator 必須遵循以下路由原則：

### 1. 分散原則 (Distribution Principle)

**不要把所有雞蛋放在同一個籃子裡。**

- 如果主 Agent 正在使用 **Antigravity (Gemini)** 進行思考：
  - Subagent A (Coding) 應優先指派給 **OpenAI**。
  - Subagent B (Docs) 應優先指派給 **Claude** 或 **Google-API**。
- **目標**：同時利用三個不同 Provider 的 Rate Limit 額度池。

### 2. 任務類型路由表

| 任務類型 (Task Type)          | 建議 Subagent Type | 優先 Provider 序列 (Primary -> Failover)        |
| :---------------------------- | :----------------- | :---------------------------------------------- |
| **複雜編碼 (Complex Coding)** | \`coding\`         | OpenAI (GPT-4) -> Claude-cli -> Antigravity     |
| **日常維護 (Routine Maint)**  | \`coding-light\`   | OpenAI (4o-mini) -> Gemini-cli -> Google-API    |
| **大量分析 (Batch Analysis)** | \`batch\`          | Gemini-cli -> Antigravity -> OpenAI             |
| **文件撰寫 (Docs)**           | \`docs\`           | Antigravity -> Claude-cli -> OpenAI             |
| **快速查詢 (Quick Info)**     | \`lightweight\`    | Google-API (Flash) -> GMICloud -> OpenAI (mini) |

### 3. 換模決策與故障轉移 (Failover)

當收到 `429 Too Many Requests` 或回應過慢時：

1.  **立即切換 (Circuit Break)**: 標記當前 Provider 為「冷卻中 (Cooldown)」。
2.  **異質備援與輪替優先級 (Heterogeneous Failover & Rotation Priority)**:
    - 當主控或當前 Provider 失效/觸發 Rate Limit 時，應依序嘗試以下序列：
      1. **github-copilot** (最優先，具備多樣化高階模型)
      2. **gemini-cli** (穩定且 Context 長度大)
      3. **gmicloud** (低延遲備選)
      4. **openai** (關鍵路徑保留)
      5. **claude-cli** (最後防線)
    - _原則_：優先耗用訂閱制或寬鬆配額的資源，將受限資源 (如 OpenAI) 留給高難度任務。
    - _注意_：避免在同一個 Provider 的不同模型間切換 (通常共用 Quota)。
3.  **操作指令**:
    - 使用 \`system-manager_switch_model\` 進行手動切換。
    - 在 \`Task\` 工具中明確指定 \`model\` 參數來繞過預設路由。

---

## Provider 配額與限制參考 (Quota & Limits)

以下為 `gemini-cli` 與 `google-api` 在 Free Tier 下的最新觀測限制（2026-02-15 更新）：

| 模型 (Model)              | RPM (每分鐘) | TPM (每分鐘 Token) | RPD (每日請求) |
| :------------------------ | :----------- | :----------------- | :------------- |
| **Gemini 3 Pro**          | 25           | 1M                 | 250            |
| **Gemini 2.5 Flash Lite** | 4K           | 4M                 | Unlimited      |
| **Gemini 3 Flash**        | 1K           | 1M                 | 10K            |
| **Gemini 2.5 Pro**        | 150          | 2M                 | 1K             |
| **Gemini 2.5 Flash**      | 1K           | 1M                 | 10K            |

**注意**：當觸發 RPM 限制時，系統會自動切換至同 Tier 的其他備選模型或帳號。

---

## 建議輸出格式

在分析階段 (Analysis) 結束後，請輸出路由計畫：

```text
[資源調度計畫]
- 任務複雜度: High
- 預估 Token: ~4k
- 策略: 分散負載
  - 主控: Antigravity (Gemini)
  - Subagent (Coding): 指派給 OpenAI (GPT-4o) 以分散 Antigravity 負載
  - Subagent (Docs): 指派給 Google-API (Flash) 節省高階額度
```
