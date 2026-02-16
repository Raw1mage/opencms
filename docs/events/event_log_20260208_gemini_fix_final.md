# Event: Gemini Personality Cleansing & Priority Jump Implementation

Date: 2026-02-08
Status: Done

## 1. 需求分析

為了解決 Antigravity Provider 下 Gemini 模型不遵守 `AGENTS.md` 規範的問題，我們從「內容清洗」與「結構優化」兩個維度進行了修補。

### 目標：
- [x] 移除 `gemini.txt` 中誘導魯莽行動的指令。
- [x] 實作「插隊」機制，確保 `AGENTS.md` 在 Gemini 的注意力權重中佔據最高優先級。

## 2. 執行計畫

- [x] **Step 1: 清洗 Gemini 性格 (`src/session/prompt/gemini.txt`)**
- [x] **Step 2: 擴充 Antigravity 插件型別 (`src/plugin/antigravity/plugin/types.ts`)**
- [x] **Step 3: 實作插隊機制 (`src/plugin/antigravity/index.ts`)**
- [x] **Step 4: 驗證**

## 3. 關鍵決策

- **為何不直接刪除 Proactiveness？**：保留項目的主動精神，但將其約束在「授權後」的範疇內，避免衝動行事。
- **XML 標籤選擇**：使用 `<behavioral_guidelines>` 標籤並配合強制的 `SUPERSEDE` 聲明，確保在 Gemini 的推理邏輯中規範優於身分。

## 4. 預期效果

- Gemini 模型現在將表現得如同 OpenAI 模型般穩定，優先讀取並遵循行為準則，減少衝動修改代碼的行為。
