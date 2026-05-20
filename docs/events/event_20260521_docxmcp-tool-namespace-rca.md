# Event: docxmcp tool namespace RCA

## 需求

- 查明 `docxmcp` MCP server 已回報 47 tools，但 `tool_loader` 載入 `docxmcp_*` 失敗的 RCA。
- 使用者不接受冗長 `mcpapp-docxmcp_docxmcp_*` namespace，要求收斂成 `docxmcp_*`。

## 範圍(IN/OUT)

- IN: `packages/opencode/src/mcp/index.ts` MCP tool id canonicalization。
- IN: `packages/opencode/src/mcp/tool-id.test.ts` 命名規則測試。
- IN: `issues/bug_20260521_docxmcp-tool-loader-not-injected.md` RCA 更新。
- OUT: 不改 docxmcp server-side tool name；不新增 collision-prone global alias fallback。

## RCA

- `connectMcpApps()` 將 docxmcp app 連線為 `mcpapp-docxmcp`。
- 既有 `MCP.tools()` 直接組合 `sanitizedClientName + "_" + sanitizedToolName`。
- docxmcp server tool 本身已使用 `docxmcp_*` 前綴，導致 opencode-visible id 變成 `mcpapp-docxmcp_docxmcp_*`。

## 決策

- 若 client 為 `mcpapp-<appId>` 且 server tool 已以 `<appId>_` 開頭，直接暴露 server tool id，例如 `docxmcp_odt_extract_all`。
- 若 app tool 沒有 appId 前綴，仍保留 `mcpapp-<appId>_<tool>` namespace 以避免跨 app collision。

## 驗證

- `bun test packages/opencode/src/mcp/tool-id.test.ts` → 4 pass。
- Architecture Sync: Verified (No doc changes). 依據：變更限於 MCP tool id normalization，未新增模組邊界、資料流或狀態機。

## Remaining

- 需要部署/重啟 runtime 後再用 `tool_loader({"tools":["docxmcp_odt_extract_all"]})` 做 live 驗證。
