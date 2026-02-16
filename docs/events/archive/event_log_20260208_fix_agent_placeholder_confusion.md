# Event: Fix Main Agent Placeholder Confusion

Date: 2026-02-08
Status: Done
Topic: Output Filtering & Model Instructions

## 1. 需求分析 (Requirement Analysis)

- **症狀**: Main Agent 在執行 `grep` 搜尋日誌時，回傳了 "Click to expand" 預留位置字串，而非實際日誌內容。
- **影響**: 導致 Subagent (Build agent) 拿到錯誤的證據，無法進行正確的邏輯判斷。
- **目標**: 解決模型對 UI 顯示文字與原始數據的混淆問題，確保模型能正確處理完整工具輸出。

## 2. 根本原因分析 (RCA)

1.  **日誌污染 (Log Pollution)**: Agent 在搜尋日誌檔案時，讀取到了日誌中記錄的舊版 TUI 界面文字 `"Click to expand"`。
2.  **指令過度干預**: 在 `src/session/prompt/gemini.txt` 中加入的「Output Control」指令過於激進，要求模型主動摘要與精簡輸出。
3.  **模型誤判**: 模型在「精簡指令」與「讀取到界面預留文字」的共同作用下，產生幻覺，誤以為 `"Click to expand"` 是系統允許的標準數據摘要格式，因此直接回傳該字串。

## 3. 關鍵決策與發現 (Key Decisions & Findings)

- **移除激進指令**: 決定從系統提示詞中移除「資訊架構控制 (Information Architecture Control)」章節。實驗證明，直接指示 LLM 隱藏中間數據會干擾其對數據完整性的認知。
- **界面文字去語義化**: 將所有 UI 層級的預留位置（如 `(click to expand)`）統一改為 `...`。這能減少模型將 UI 文字誤認為數據摘要格式的機會。
- **數據與顯示分離**: 再次確認過濾邏輯僅存在於渲染層 (`limited()` memo)，不應介入 `ToolPart` 的持久化存取。

## 4. 執行結果 (Execution Result)

- [x] 更新 `/home/pkcs12/opencode/src/session/prompt/gemini.txt`：移除 Output Control 指令。
- [x] 更新 `/home/pkcs12/opencode/src/cli/cmd/tui/component/prompt/index.tsx`：將殘留的 `(click to expand)` 改為 `...`。
- [x] 驗證單元測試：確保 `test/cli/output-filtering.test.ts` 依然通過。

## 5. 遺留問題 (Pending Issues)

- 目前模型傾向於摘要長輸出是基於 `AGENTS.md` 的核心憲法，這部分應保留，但需觀察模型是否會因過於簡潔而遺漏關鍵除錯資訊。
