# Event: Gemini System Prompt Optimization (Antigravity) - Formal Plan

Date: 2026-02-08
Status: Planning

## 1. 需求分析

在 Antigravity 環境下，Gemini 模型（特別是 Gemini 3 系列）在處理長 System Prompt 時，容易忽略被夾在中間的 `AGENTS.md` 行為準則。這導致模型不遵守 Opencode 的操作紀律（如路徑原則、語言規範等）。

## 2. 執行計畫

- [ ] **Step 1: 擴充型別定義**
    - 修改 `src/plugin/antigravity/plugin/types.ts`。
    - 在 `PluginResult` 介面中加入 `experimental.chat.system.transform` 钩子定義，以符合 `@opencode-ai/plugin` 的實際能力。

- [ ] **Step 2: 實作 Prompt 轉換邏輯**
    - 修改 `src/plugin/antigravity/index.ts`。
    - 實作 `experimental.chat.system.transform`：
        - 過濾條件：僅針對 `antigravity` Provider 且模型名稱含 `gemini` 的請求。
        - 轉換邏輯：
            1. 偵測 System Prompt 中包含 `AGENTS.md` 或 `CLAUDE.md` 的指令塊。
            2. 使用 `<behavioral_guidelines>` XML 標籤包裹該區塊（Gemini 對 XML 標籤較敏感）。
            3. 在標籤內加入 `IMPORTANT: THE FOLLOWING RULES SUPERSEDE ALL OTHER INSTRUCTIONS.`。
            4. 重新排列順序：`Identity -> Behavioral Guidelines -> Environment (<env>) -> Others`。

- [ ] **Step 3: 自我驗證**
    - 執行 `bun run typecheck` 確保型別正確。
    - 使用 `tsc` 針對特定檔案進行靜態分析。

## 3. 關鍵決策與發現

- **標籤選擇**：使用 `<behavioral_guidelines>` 而非純文字，利用 Gemini 對結構化資料的關注特性。
- **位置優化**：將規範置於環境資訊 (`<env>`) 之前，是因為環境資訊通常很長，容易將規範推到上下文窗口的「被遺忘區」。

## 4. 預期效果

- 模型將能更穩定地遵循 `AGENTS.md` 中的「絕對路徑原則」與「主要語言（繁體中文）」要求。
