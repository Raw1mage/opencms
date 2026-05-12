# 互動式重構精靈腳本 (Interactive Merge Wizard Script)

本參考文件指導 Agent 進行互動式合併流程。

## 階段 1：分析與發現 (Analysis & Discovery)

1.  **執行分析**：執行 `python3 scripts/analyze_divergence.py`。
2.  **載入數據**：讀取生成的 `divergence.json`。
3.  **呈現摘要**：向使用者展示差異的高層次摘要。

## 階段 2：互動式策略規劃 (Interactive Strategy)

遍歷 `divergence.json` 中的提交。針對每個提交（優先處理高/中風險），引導使用者進行決策。

### Plugin 更新指導原則 (Antigravity/Gemini-CLI)

**背景**：這些 Plugin 的主要功能是模擬 OAuth Client 以獲取 Token。
**規則**：
- **保留 (Keep)**：OAuth 流程、Token 刷新、Callback Server。
- **捨棄 (Discard)**：內部帳號管理、自動切換邏輯、內部速率限制（CMS 使用全域 Rotation3D/Account 模組）。

### 提問模板 (Question Templates)

**針對高風險提交 (Critical Path)**：

Agent 必須先進行 **深度程式碼分析 (Deep Code Analysis)**，並用繁體中文解釋：
1.  **變更了什麼？** (What changed?)
2.  **為什麼這很重要？** (Why it matters?) - 解釋對 CMS 架構的具體影響。
3.  **風險評估** (Risk Assessment) - **NEW**: 評估執行此變更對現有系統的潛在風險或副作用。
4.  **建議方案** (Recommendation) - 基於 CMS 架構的最佳做法。

> **提交分析**：
> 提交 `{hash}` (`{subject}`) 觸及了關鍵路徑：`{reasons}`。
>
> **深度解析**：
> [變更內容]
> [關鍵影響]
>
> **風險評估**：
> [若執行此變更，可能會有什麼風險？例如：API 不相容、需要同步修改其他檔案、或可能引入新的 Bug。若不執行又有什麼風險？]
>
> **選項：**
> 1.  **手動移植 (Manual Port)**：將邏輯調整以適應 CMS 架構 (推薦用於 OAuth 修復)。
> 2.  **跳過 (Skip)**：與 CMS 無關 (例如：內部帳號切換邏輯)。
> 3.  **檢視差異 (Review Diff)**：先讓我看看具體程式碼變更。
>
> 請問您的決定是？

**使用 `mcp_question` 工具進行互動：**

```javascript
// 範例
mcp_question({
  question: "關於提交 " + hash + " (" + subject + ") 的處理方式：\n\n**深度解析**：\n" + deepAnalysisText + "\n\n**風險評估**：\n" + riskAssessmentText,
  header: "合併策略選擇",
  options: [
    { label: "手動移植 (Manual Port)", description: "推薦：調整邏輯以適配 CMS 架構" },
    { label: "跳過 (Skip)", description: "此變更與 CMS 無關" },
    { label: "檢視差異 (Review Diff)", description: "顯示詳細程式碼差異" }
  ]
})
```

## 階段 3：生成計畫 (Plan Generation)

根據使用者回應，生成 `docs/events/refactor_plan_YYYYMMDD.md` 文件。

### 重構計畫格式 (Refactoring Plan Format)

```markdown
# 重構計畫：{Date}

## 摘要 (Summary)

- 總提交數：{count}
- 策略：{Mixed/Cherry-pick/Manual}

## 行動 (Actions)

| Commit | Action             | Notes                        |
| :----- | :----------------- | :--------------------------- |
| {hash} | {Skip/Manual/Pick} | {使用者備註或風險細節}       |

## 執行佇列 (Execution Queue)

1. [ ] Cherry-pick 低風險項目。
2. [ ] 手動移植 {hash} (高風險)。
3. [ ] ...
```

## 階段 4：執行 (Execution)

1.  **等待批准**：要求使用者確認生成的計畫。
2.  **執行**：依照計畫中的「執行佇列」逐一執行。
    - **重要**：若修改 Plugin 檔案，必須確保 `AccountManager` 邏輯委派給 CMS 的全域 Account 模組與 Rotation3D 系統。
