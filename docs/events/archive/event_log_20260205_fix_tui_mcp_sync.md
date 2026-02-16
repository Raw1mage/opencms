#### 功能：修復 TUI Sidebar MCP 狀態同步問題

**需求**

- 確保當後端 MCP server 狀態改變（連線/斷線/錯誤）時，前端 TUI sidebar 能即時更新。
- 解決 `sync.tsx` 缺少 MCP 事件監聽的問題。

**範圍**

- IN：
  - 修改 `src/cli/cmd/tui/context/sync.tsx`。
  - 加入 MCP 相關事件監聽邏輯。
- OUT：
  - 不修改後端事件發送邏輯（假設後端已有發送）。

**方法**

1.  **確認事件名稱**：透過 grep 確認後端發送的 MCP 狀態變更事件名稱。
2.  **實作監聽器**：在 `sync.tsx` 中加入對應的 `case`，收到事件後觸發 `sdk.client.mcp.status()` 更新 store。

**任務**

1. [ ] 確認 MCP 狀態變更事件名稱
2. [ ] 更新 `src/cli/cmd/tui/context/sync.tsx` 加入監聽邏輯
3. [ ] 驗證 TUI 是否能反應 MCP 狀態變化

**待解問題**

- 無。
