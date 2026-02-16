# Event: Implementation of Grep Output Redirection & Session-Bound Storage

Date: 2026-02-08
Status: Done
Topic: Data Integrity vs UI Hygiene

## 1. 需求分析 (Requirement Analysis)

- **核心矛盾**: `grep` 等搜尋指令產生的大量數據會污染 TUI 對話界面，但人為截斷（如 100 筆限制）又會導致 AI 無法獲得完整資訊進行分析。
- **目標**: 實現「UI 極簡化」與「數據 100% 完整」並行，同時確保產生的中間數據符合資安生命週期管理。

## 2. 根本原因分析 (RCA)

- **舊機制缺陷**: `Truncate.output` 會將過長的數據替換為一段提示字串，導致 LLM 接收到的 `output` 欄位遺失了原始數據。
- **UI 衝突**: TUI 的 `output-filter.ts` 會隱藏超過 50 行的輸出，導致 AI 有時連「截斷提示與檔案路徑」都看不到，進而產生幻覺（如腦補出 Click to expand 字樣）。

## 3. 關鍵決策與解決方案 (Key Decisions)

### 3.1 數據重定向機制

- **自動 Pipe**: 修改 `GrepTool` 與 `BashTool`。當輸出 > 1000 字元時，自動將全文寫入本地暫存檔。
- **極簡提示**: 工具回傳給 LLM 的 `output` 僅包含：匹配總數、檔案路徑、引導讀取的指令。

### 3.2 生命週期管理 (Lifecycle)

- **Session 綁定**: 暫存目錄路徑包含 `sessionID`：`~/.local/share/opencode/tool-output/{sessionID}/`。
- **聯動刪除**: 修改 `Session.remove` 邏輯，當 Session 被刪除時，同步遞迴清理對應的工具輸出目錄。
- **兜底清理**: 將全域清理門檻從 7 天縮短至 24 小時。

### 3.3 UI 與 AI 協作優化

- **UI Bypass**: 確保 `output-filter.ts` 不會隱藏包含路徑提示的輸出。
- **強制 AI 指引**: 在 `gemini.txt` 中加入規範，要求 AI 遇到重定向時必須主動調用 `read` 工具。

## 4. 變更檔案列表 (Affected Files)

- `src/tool/truncation.ts`: 提升門檻 (256KB)，實作 Session 目錄支持與清理邏輯。
- `src/tool/grep.ts`: 移除 100 筆限制，實作極簡模式回傳。
- `src/tool/bash.ts`: 針對搜尋指令實作 aggressive 截斷與重定向。
- `src/session/index.ts`: 實作 Session 刪除與檔案清理的聯動。
- `src/cli/cmd/tui/util/output-filter.ts`: 加入路徑提示的 bypass 邏輯。
- `src/session/prompt/gemini.txt`: 更新 AI 作業規範。
- `docs/events/sop_handling_large_logs.md`: 定義標準作業程序。

## 5. 驗證結果 (Verification)

- 執行 `grep "import" .` 匹配到 6000+ 筆資料。
- UI 顯示 3 行提示（含路徑）。
- AI 能正確辨識路徑並執行 `read` 獲取後續內容。
- 刪除測試 Session 後，對應目錄已自動消失。
