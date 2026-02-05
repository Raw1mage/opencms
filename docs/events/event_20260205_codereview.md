#### 功能：專案深度代碼健檢 (Code Review & Optimization)

**需求**
- 對專案進行實質性的健檢分析（而非僅生成報告）。
- 識別效能瓶頸、記憶體風險與架構負債。
- 直接對發現的問題進行優化實作。

**範圍**
- IN：`src/agent` (權限與組態), `src/tool` (Grep 工具), `src/cli/cmd/tui` (非同步事件處理)。
- OUT：前端組件樣式調整。

**方法**
- 執行靜態代碼掃描與邏輯分析。
- 使用 `Stream` 與 `Batching` 技術優化資源消耗。
- 採用功能提取（Extraction）重構過於耦合的函數。

**任務**
1. [x] 執行深度代碼掃描與風險評估。
2. [x] 重構 `grep.ts` 以支持流式讀取，防止 OOM。
3. [x] 拆分 `agent.ts` 初始化邏輯，降低耦合度。
4. [x] 優化 `sdk.tsx` 事件處理機制，消除 Race Condition。
5. [x] 產出詳細健檢報告 `docs/reviews/20260205_codereview.md`。

**CHANGELOG**
- `src/tool/grep.ts`: 從 `proc.stdout.text()` 遷移至 `ReadableStream` 逐行處理，並加入匹配上限。
- `src/agent/agent.ts`: 提取私有 helper 函數處理權限與 Agent 預設值。
- `src/cli/cmd/tui/context/sdk.tsx`: 修復 `setTimeout` 邏輯，增強批處理安全性。

**待解問題**
- 無。
