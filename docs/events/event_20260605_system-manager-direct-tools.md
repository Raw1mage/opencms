# 2026-06-05 — system-manager direct tools

## 需求

- 依使用者要求檢視新 plan，實作 system-manager tool 直接呼叫，去除 MCP 依賴路徑。

## 範圍

### IN

- 盤點目前 `packages/mcp/system-manager` 與內建 tool expose 邊界。
- 將 system-manager 相關工具移到 daemon 內可直接呼叫的內建 tool surface。
- 同步 enablement / 架構文件與驗證紀錄。

### OUT

- 不重啟 daemon / gateway；需要生效時僅能走授權的 restart_self 路徑。
- 不新增 silent fallback；直呼失敗需 fail fast 並保留錯誤證據。

## 任務清單

- [x] 讀取架構與新 plan。
- [x] 建立 XDG 白名單備份。
- [x] 實作 system-manager 直呼工具。
- [x] 更新文件與任務狀態。
- [x] 執行針對性驗證。

## Debug Checkpoints

- CP-1 Architecture baseline: `specs/architecture.md` 已讀，現況記載 system-manager 仍位於 MCP 工具面。
- CP-2 Plan discovery: `/plans` 未找到 active package；`/specs` 以 system-manager/direct/MCP 關鍵字未命中新 direct-tools plan，改依使用者口頭需求執行最小切面。
- CP-3 Direct import smoke: `bun -e 'const m = await import("./packages/opencode/src/tool/system-manager.ts"); console.log(m.SystemManagerTools.length)'` 回傳 `29`，確認 daemon 直呼 bridge 可匯入且未啟動 stdio MCP server。
- CP-4 Registry smoke: `bun -e 'const { ToolRegistry } = await import("./packages/opencode/src/tool/registry.ts"); ...'` 回傳 `29` 與 `true`，確認 `system-manager_*` direct tools 已進 registry。
- CP-5 Schema preservation: `ToolRegistry.getParameters("system-manager_switch_session")` 對 `{}` 回傳 parse fail、對 `{sessionID:"ses_x"}` parse pass；`system-manager_switch_theme` 對合法 enum pass、非法 theme fail。

## Key Decisions

- `packages/mcp/system-manager/src/index.ts` 保留 legacy MCP entrypoint，但匯出 `listSystemManagerTools` / `callSystemManagerTool` 作為 direct built-in tool 的單一 handler，避免複製工具邏輯。
- `packages/opencode/src/tool/system-manager.ts` 以相同 `system-manager_*` tool id 註冊 direct bridge；`resolve-tools.ts` 若同名 legacy MCP tool 仍存在，保留 direct 版本。
- Direct bridge 將 system-manager MCP `inputSchema` 轉成最小 Zod schema，保留 required fields、string enum、number/integer min/max、boolean、array/object 型別，避免 direct tool 退化成任意 passthrough。
- 不新增 fallback；direct handler 沿用既有錯誤回傳與 daemon API fail-fast 行為。

## Verification

- XDG Backup: `/home/pkcs12/.config/opencode.bak-20260605-1913-system-manager-direct-tools/`。
- Direct handler smoke: `bun -e 'const m = await import("./packages/mcp/system-manager/src/index.ts"); const listed = await m.listSystemManagerTools(); ...'` 回傳 `29` / `true`。
- Direct resolve smoke: `bun -e 'const { ToolRegistry } = await import("./packages/opencode/src/tool/registry.ts"); const tools = await ToolRegistry.tools(...); ...'` 回傳 `29` / `true`。
- Schema smoke: direct tool Zod schema required/enum validation passed。
- Diff hygiene: `git diff --check` passed。
- Typecheck: `bun node_modules/typescript/bin/tsc -p packages/opencode/tsconfig.json --noEmit` 仍被既有錯誤阻擋：`freerun/runtime/engine.ts`、`session/llm.ts`，未顯示本次 system-manager direct tool 新增錯誤。
- Architecture Sync: Updated `specs/architecture.md` Tool Surface Runtime，記錄 `system-manager_*` direct built-in tool family、legacy MCP compatibility、session API boundary。
