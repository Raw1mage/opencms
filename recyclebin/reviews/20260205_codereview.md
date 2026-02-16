# OpenCode 深度代碼健檢報告 (2026-02-05)

## 1. 核心風險分析與優化對策

### [High] 記憶體溢出風險 (OOM) - `src/tool/grep.ts`
- **問題描述**：原先使用一次性讀取 `ripgrep` 輸出的方式（`Response.text()`），在搜尋大型專案或匹配項過多時會導致記憶體耗盡。
- **風險評估**：嚴重。可能導致 CLI 工具在背景執行任務時無預警崩潰。
- **優化方案**：
    - 改用 `ReadableStream` 流式處理輸出。
    - 設置 `MATCH_LIMIT = 100` 硬上限。
    - 達到上限後主動調用 `proc.kill()` 中止背景進程。
- **狀態**：✅ 已修復。

### [Medium] 架構維護負債 - `src/agent/agent.ts`
- **問題描述**：`Agent.state` 初始化函數過於臃腫（150+ 行），混合了預設權限、內建角色與用戶配置邏輯。
- **風險評估**：中。難以撰寫單元測試，且增加權限邏輯出錯的機率。
- **優化方案**：
    - 提取 `getDefaultPermissions()` 處理系統預設權限。
    - 提取 `getNativeAgents()` 定義內建角色。
    - 簡化 `state` 為高層次初始化流水線。
- **狀態**：✅ 已完成重構。

### [Medium] 非同步競態風險 - `src/cli/cmd/tui/context/sdk.tsx`
- **問題描述**：事件批處理邏輯中的 `timer` 管理不夠精確，且 `last` 更新時間點可能導致 Race Condition。
- **風險評估**：中。在高頻事件（如大量 Bash 輸出）時，可能導致 UI 更新延遲或狀態不一致。
- **優化方案**：
    - 修正 `flush` 內部的 `timer` 清理機制。
    - 引入動態延遲計算 `Math.max(0, 16 - elapsed)`。
    - 確保 `batch` 更新的原子性。
- **狀態**：✅ 已優化。

## 2. 代碼品質觀察
- **優點**：
    - 廣泛使用 Zod 進行型別驗證，邊界條件定義清晰。
    - 採用 Monorepo 架構，套件依賴管理（Catalog）有序。
- **建議**：
    - 建議針對 `src/permission/next` 增加獨立的單元測試。
    - TUI 的渲染 FPS 目前固定在 60，未來可考慮根據負載動態調整以節省 CPU。

---
*審查者：Antigravity (gemini-3-flash)*
