# SOP: Handling Large Tool Outputs (Grep/Bash Redirection)

Date: 2026-02-08
Status: Active
Context: High-volume data output (grep, rg, logs) in Opencode CLI/TUI.

## 1. 核心機制 (Core Mechanism)

為了平衡 **「對話清潔度 (UI Hygiene)」** 與 **「數據完整性 (Data Integrity)」**，Opencode 採用了數據重定向機制：

1.  **自動檢測**: 當 `grep` 或 `bash` 工具產生的輸出超過門檻（如 1000 字元或 50 行）時，系統會自動截斷。
2.  **檔案重定向**: 完整內容會寫入到 Session 專屬的暫存目錄：
    `~/.local/share/opencode/tool-output/{sessionID}/tool_{uniqueID}`
3.  **極簡提示**: 工具會回傳一段包含檔案路徑的提示文字給 Agent 與 UI。

## 2. Agent 作業規範 (Agent Protocol)

當 Agent 執行搜尋工具並看到以下提示時：
`Full output saved to: /home/pkcs12/.local/share/opencode/tool-output/...`

### 禁止行為

- **禁止**：僅根據摘要內容宣稱「沒有找到結果」。
- **禁止**：要求用戶手動讀取該路徑。
- **禁止**：回傳 UI 預留字串（如 `Click to expand` 或 `...`）作為數據內容。

### 標準程序

1.  **解析路徑**: 從工具輸出中提取完整的 `outputPath`。
2.  **分段讀取**: 使用 `read` 工具，並搭配 `offset` 與 `limit` 參數讀取該檔案。
3.  **精確處理**: 根據讀取到的全文進行邏輯判斷。

## 3. 生命週期與資安 (Security & Lifecycle)

- **Session 綁定**: 暫存檔隨 Session 創建而產生，隨 Session 刪除而銷毀。
- **自動清理**: 超過 24 小時的殘留檔案將由系統後台每小時自動清理。
- **路徑唯一性**: 採用 `Identifier.ascending` 生成唯一序號，防止並行衝突與資安掃描。

## 4. 疑難排解 (Troubleshooting)

- **看不到路徑提示**: 如果提示被隱藏（顯示為 `...`），請檢查 TUI 的 `output-filter.ts` 邏輯，確保已加入路徑提示的 bypass。
- **讀取失敗**: 確認該檔案是否已被 Compaction 或 Cleanup 任務移除。
