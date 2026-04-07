# MCP Subsystem

OpenCode 的 MCP (Model Context Protocol) 管理層與工具整合子系統。

## 架構概覽

### MCP Management Layer (`mcp-separation/`)
兩層式 MCP 應用管理：全域 manifest (`mcp-apps.json`) + per-project 設定覆蓋。

- **McpAppManifest** — 應用描述 schema（transport, auth, tools, settings）
- **McpAppStore** — 生命週期管理（register, enable, disable, spawn, probe）
- **App Market UI** — 安裝/設定/OAuth 連接介面
- **Lazy Tool Loading** — `tool_loader` catalog + `experimental_repairToolCall` on-demand activation
- **Enablement Registry** — `enablement.json` 作為 routing single source of truth

### Tool Direct Render (`tool-direct-render/`)
MCP tool output 直接顯示在 fileview，繞過 model context 消耗。

- **Pipeline**: AI → MCP tool (save file) → `open_fileview` tool → fileview tab
- **Scope**: read-only tools 預設 direct render；write tools (`modelProcess[]`) 經 AI 處理
- **Frontend**: ToolRegistry renderer + auto-open effect + HTML iframe sandbox
- **Download**: Portal-based dropdown menu（Open File / Download / New Tab）

## 關鍵檔案

| 檔案 | 用途 |
|------|------|
| `packages/opencode/src/mcp/` | MCP runtime (store, spawn, probe) |
| `packages/opencode/src/session/prompt/enablement.json` | 能力總表 + routing |
| `packages/opencode/src/session/resolve-tools.ts` | Lazy tool loading + tool_loader |
| `packages/opencode/src/session/llm.ts` | Enablement snapshot injection |
| `packages/mcp/system-manager/src/index.ts` | open_fileview tool |
| `packages/ui/src/components/message-part.tsx` | Tool renderer + auto-open effect |
| `packages/app/src/pages/session/file-tabs.tsx` | HTML iframe renderer |
| `packages/app/src/pages/session/session-side-panel.tsx` | Download menu |

## 待辦

- [ ] Direct render 標準化為通用 tool 協議
- [ ] tool_loader catalog 加入 open_fileview 說明
- [ ] Fileview 支援 absolute path（移除 `.opencode/mcp-output/` workaround）
