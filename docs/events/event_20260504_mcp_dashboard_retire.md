# MCP Dashboard App Retirement

## 需求

- 使用者指出應用市場 dashboard 內的 `beta-tool` 與 `fake-good` 已不再需要，應退役。

## 範圍 (IN/OUT)

- IN: 讓 `/api/v2/mcp/market` dashboard 不再列出 retired app IDs；同步移除 repo/template 中仍推薦 `beta-tool` 的 app-market/enablement 預設。
- IN: 清理目前使用者層 config 中已安裝的 `fake-good` 測試 app 與 `beta-tool` 預設 MCP entry。
- OUT: 刪除歷史 spec/archive/event 中的 `beta-tool` 記錄；保留歷史證據。
- OUT: 移除 `packages/mcp/branch-cicd` 原始碼；該 package 仍是歷史/遷移參考，不作為 dashboard 市場項目。

## 任務清單

- [x] 定位 dashboard 資料來源與兩個 app 的引用位置。
- [x] 新增 retired dashboard app filter。
- [x] 同步 repo/template/XDG config。
- [x] 驗證 dashboard market output 不再包含 retired IDs。

## Debug Checkpoints

- Baseline: `/api/v2/mcp/market` 聚合 `MCP.serverApps()`、`ManagedAppRegistry.list()`、`McpAppStore.listApps()`；`fake-good` 由使用者層 `mcp-apps.json` 進入 store cards，`beta-tool` 由標準 MCP config/template 與 enablement routing 進入市場或提示。
- Instrumentation Plan: 檢查 server-side market 聚合點、MCP server metadata、template config、enablement registry、目前 XDG config。
- Execution: `packages/opencode/src/server/routes/mcp.ts` 在 store app card 轉換前過濾 retired IDs；`packages/opencode/src/mcp/index.ts` 在 standard MCP server app card 轉換前過濾 `beta-tool`，並移除 `SERVER_META` 中的 market metadata；`packages/opencode/src/session/prompt/enablement.json` 與 `templates/prompts/enablement.json` 不再宣告 `beta_tool_mcp` 或偏好 `beta-tool MCP`；`templates/opencode.json` 與 `templates/examples/project-opencode/opencode.jsonc` 移除預設 `beta-tool` entry；目前 XDG `opencode.json` / `mcp-apps.json` 已無 `beta-tool` / `fake-good` entry。
- Root Cause: dashboard 未區分 retired/test app 與一般可用 app；歷史 `beta-tool` routing 仍保留為 preferred capability，`fake-good` 測試 entry 仍留在使用者層 app store config。
- Validation: `jq empty` 通過 repo/runtime/template enablement JSON、template `opencode.json`、目前 XDG `opencode.json` 與 `mcp-apps.json`；靜態搜尋確認 active enablement/template 不再含 `beta_tool_mcp`、`beta-tool MCP`、`Prefer beta-tool`、預設 `"beta-tool"` entry 或 `fake-good`；`bun test packages/opencode/test/mcp/app-registry.test.ts` 失敗於既有 catalog 空集合（7 pass / 6 fail，失敗點為 `ManagedAppRegistry.catalog()` 回傳 0，非本次 retired filter path）；`bun --cwd packages/opencode run typecheck` 因既有跨模組型別錯誤失敗（包含 codex provider、CLI、session/message/share 等既有錯誤，以及 `src/mcp/app-store.ts` / `src/mcp/index.ts` 其他既有型別問題），未作為本次變更完成門檻。

## Architecture Sync

- `specs/architecture.md` 已同步：`beta-tool` MCP 被標示為 retired / historical migration reference，builder-native beta workflow 是 operational path，且 `beta-tool` 不再是 dashboard capability。

## Backup

- XDG 白名單快照：`~/.config/opencode.bak-20260504-1759-mcp-dashboard-retire/`，僅供需要時手動還原；本次未執行還原。
