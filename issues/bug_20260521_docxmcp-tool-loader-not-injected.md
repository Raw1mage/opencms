# RCA: docxmcp tools/list 名稱與 opencode tool_loader 名稱空間不一致

## Summary

`docxmcp` MCP server 已啟動、`/healthz` 正常，且直接呼叫 MCP `tools/list` 可看到 47 個工具（包含 `docxmcp_odt_extract_all` / `docxmcp_odt_assemble`）。RCA 顯示這不是 MCP tool 未注入，而是名稱空間判讀錯誤：opencode 原本把 MCP app client `mcpapp-docxmcp` 與 server tool name 再組成 model-visible tool id，例如 `mcpapp-docxmcp_docxmcp_odt_extract_all`。使用者決策：收斂成 `docxmcp_*` canonical id。

## Environment

- Repo: `/home/pkcs12/projects/docxmcp`
- Date: 2026-05-21
- MCP app registry: `docxmcp` enabled（system app，path `/home/pkcs12/projects/docxmcp`）
- Runtime: Docker Compose service `docxmcp-${USER}` + UDS socket `/run/user/$(id -u)/opencode/sockets/docxmcp/docxmcp.sock`
- Related commits:
  - `6ea4e96 feat(odt): add document decomposition and assembly`
  - `442e9a2 docs: sync doc workflow package convention`

## Impact

- Agents calling `tool_loader({tools:["docxmcp_odt_extract_all", ...]})` saw a false negative because opencode exposed a redundant app namespace on top of already app-prefixed server tool names.
- The actual session tool pool contained docxmcp tools under overly long `mcpapp-docxmcp_docxmcp_*` ids.
- The canonical runtime fix is to expose app-prefixed server tools directly as `docxmcp_*`.

## Reproduction

1. Ensure `docxmcp` MCP app is enabled:

   ```text
   Installed MCP Apps:
   📦 docxmcp (docxmcp) — enabled [system] /home/pkcs12/projects/docxmcp
   ```

2. Start `docxmcp` service and confirm health:

   ```bash
   mkdir -p "/run/user/$(id -u)/opencode/sockets/docxmcp"
   chmod 700 "/run/user/$(id -u)/opencode/sockets/docxmcp"
   docker compose -p "docxmcp-${USER}" up -d
   curl --unix-socket "/run/user/$(id -u)/opencode/sockets/docxmcp/docxmcp.sock" http://docxmcp.local/healthz
   ```

   Observed health response:

   ```json
   {"ok":true,"tokens":{"active_tokens":0,"storage_bytes":0,"ttl_seconds":3600,"size_cap_bytes":1073741824}}
   ```

3. Refresh current session capability layer:

   ```text
   refresh_capability_layer → status: refreshed
   ```

4. Try loading raw MCP tool names:

   ```text
   tool_loader({"tools":["docxmcp_stage_dir","docxmcp_odt_extract_all","docxmcp_odt_assemble"]})
   ```

   Observed error:

   ```text
   ERROR — tools not found: docxmcp_stage_dir, docxmcp_odt_extract_all, docxmcp_odt_assemble.
   These tools do not exist in the current tool pool.
   ```

5. Before the fix, loading opencode model-visible namespaced tool ids succeeded:

   ```text
   tool_loader({"tools":["mcpapp-docxmcp_docxmcp_stage_dir","mcpapp-docxmcp_docxmcp_odt_extract_all","mcpapp-docxmcp_docxmcp_odt_assemble"]})
   ```

   Observed success:

   ```text
   Loaded tools: mcpapp-docxmcp_docxmcp_stage_dir, mcpapp-docxmcp_docxmcp_odt_extract_all, mcpapp-docxmcp_docxmcp_odt_assemble.
   They are available on your next action.
   ```

6. Direct MCP `tools/list` succeeds with a valid session ID and returns 47 raw server tool names:

   ```text
   47
   docxmcp_xlsx_extract_all
   docxmcp_odt_extract_all
   docxmcp_odt_assemble
   docxmcp_stage_dir
   ```

## RCA

- `MCP.tools()` builds opencode-visible tool ids as `sanitizedClientName + "_" + sanitizedToolName` in `packages/opencode/src/mcp/index.ts`.
- For MCP apps, `connectMcpApps()` connects enabled app `docxmcp` under client key `mcpapp-docxmcp`.
- Therefore raw server tool `docxmcp_odt_extract_all` becomes `mcpapp-docxmcp_docxmcp_odt_extract_all` in the session tool pool.
- `tool_loader` validates requested names against `UnlockedTools.getAvailable(sessionID)`, which stores opencode-visible ids from `resolveTools()`, not raw MCP `tools/list` names.
- Fix direction: if `clientName` is `mcpapp-<appId>` and `toolName` already starts with `<appId>_`, expose `toolName` as the canonical id. Tools without the app prefix remain namespaced to avoid collisions.

## Expected Behavior

- `tool_loader` should accept `docxmcp_*` as the canonical opencode-visible ids when the MCP app already prefixes its own tools with `docxmcp_`.
- Non-prefixed app tools should remain namespaced with `mcpapp-<appId>_` to avoid collisions.

## Actual Behavior

- MCP server advertises tools correctly.
- App registry reports `docxmcp` enabled.
- Before the fix, `tool_loader` cannot find raw `docxmcp_*` names because the current session tool pool uses `mcpapp-docxmcp_docxmcp_*` namespaced ids.

## Evidence

- `system-manager_list_mcp_apps` showed `docxmcp` enabled.
- `/healthz` returned `ok=true`.
- `initialize` on `/mcp/` returned `serverInfo.name=docxmcp`, `version=0.6.0`, and tool capability.
- `tools/list` with `Mcp-Session-Id` returned 47 tools and included ODT tools.
- Exact MCP tool names include `docxmcp_xlsx_extract_all`, `docxmcp_odt_extract_all`, `docxmcp_odt_assemble`, and `docxmcp_stage_dir`; non-prefixed names such as `odt_extract_all` / `stage_dir` also fail in `tool_loader`.
- `tool_loader` succeeded for `mcpapp-docxmcp_docxmcp_stage_dir`, `mcpapp-docxmcp_docxmcp_odt_extract_all`, and `mcpapp-docxmcp_docxmcp_odt_assemble` before the canonical naming fix.

## Corrective Actions

1. Add a canonical tool id helper in `packages/opencode/src/mcp/index.ts`.
2. For `mcpapp-<appId>` clients whose tools already start with `<appId>_`, expose the raw app-prefixed server tool name directly.
3. Keep namespacing for non-prefixed app tools and non-app MCP servers.

## Acceptance Criteria

- `tool_loader({"tools":["docxmcp_stage_dir"]})` succeeds when `docxmcp` server is enabled and healthy.
- `tool_loader({"tools":["docxmcp_odt_extract_all","docxmcp_odt_assemble"]})` succeeds after the ODT commit is deployed.
- `MCP.toolID("mcpapp-docxmcp", "docxmcp_odt_extract_all")` returns `docxmcp_odt_extract_all`.
- Failure mode distinguishes between:
  - MCP app disabled
  - MCP server unreachable
  - MCP `tools/list` missing the tool
  - session tool-pool not refreshed
- A regression test or smoke check covers enabled MCP app → current session tool catalog injection.

## Next-Session Checklist

- [x] Inspect the tool-loader catalog source and how it imports MCP app tools.
- [x] Compare `system-manager_list_mcp_apps` enabled state with session capability/tool pool contents.
- [x] Verify whether the observed failure is a refresh issue or a name mapping issue.
- [x] Add targeted tests for MCP app duplicate-prefix canonicalization.
- [ ] Verify the new canonical ids through runtime after restart/rebind.

## Workaround

- Until the fixed runtime is deployed, use the pre-fix long ids such as `mcpapp-docxmcp_docxmcp_odt_extract_all`; after deployment, use canonical `docxmcp_odt_extract_all`.
