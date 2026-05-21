# Bug Report: 動態 MCP tool 載入後無法直接取得可呼叫 schema

Status: Closed

## Summary

在文件處理 session 中，使用者要求載入並使用 `docxmcp` MCP tools 來拆解 `.docx/.pdf` 官方文件。`tool_loader` 回報工具已載入，例如 `docxmcp_extract_all`、`docxmcp_pdf_extract_all`、`docxmcp_extract_text` 等，但後續對話介面沒有展開這些動態工具的可呼叫 function schema，導致 Main Agent 無法像一般工具一樣直接發出 MCP tool call，只能退回使用 CLI/backend script 的繞路方式。

## Impact

- 使用者明確要求「善用 docxmcp」時，Agent 會看到工具名稱已載入，卻沒有實際可呼叫入口。
- Agent 容易誤判為工具可用，接著產生 no-op / placeholder 嘗試，降低信任度。
- MCP app 的 capability discovery 與 invocation 之間出現落差：`tool_loader` 顯示成功，但實際執行面不可用或不可見。
- 對文件工作流影響明顯，因為 `doc-workflow` 需要穩定使用 docxmcp 產出 `body.md`、`outline.md`、`blocks/`、`manifest.json` 等 `.src/` 元件。

## Environment

- Repo: `/home/pkcs12/projects/opencode`
- Session cwd: `/home/pkcs12/projects/documents`
- MCP app/tool family: `docxmcp`
- Triggering task: 拆解國發會標案官方文件，將公告文件補成 `<stem>.src/` 文件元件包。

## Reproduction Steps

1. 在 session 中要求載入 docxmcp 相關 tools。
2. 呼叫 `tool_loader` 載入：
   - `docxmcp_extract_all`
   - `docxmcp_pdf_extract_all`
   - `docxmcp_extract_text`
   - `docxmcp_extract_outline`
   - `docxmcp_extract_chapter`
   - `docxmcp_rebuild_docx`
   - `docxmcp_docx_to_images`
3. `tool_loader` 回報成功載入工具名稱。
4. Agent 嘗試進一步使用這些工具時，工具列表沒有提供對應 callable schema / function signature。
5. Agent 無法直接發出 `docxmcp_extract_all` 或 `docxmcp_pdf_extract_all` MCP call，只能改用 bash 執行 docxmcp 後端腳本或其他替代路徑。

## Expected Behavior

- `tool_loader` 成功載入 MCP tool 後，下一輪工具面應出現可直接呼叫的 function schema。
- Agent 應能用一般 tool call 呼叫，例如：
  - `docxmcp_extract_all({ ... })`
  - `docxmcp_pdf_extract_all({ ... })`
- 若 dynamic MCP tools 因 schema 缺失、registry 錯誤或 session tool surface 限制而不可呼叫，`tool_loader` 應 fail fast，明確回報不可用原因，而不是只回報載入成功。

## Actual Behavior

- `tool_loader` 回報 docxmcp tools 已載入。
- 後續工具面沒有展開可呼叫的 dynamic MCP function schema。
- Agent 產生多次 placeholder/no-op 嘗試後，才改用 docxmcp backend script 補拆文件。

## Evidence From Session

- `tool_loader` 成功回報已載入 docxmcp tools。
- Agent 後續明確回報：「本介面雖已載入 MCP tool 名稱，但沒有展開可直接呼叫的動態 schema；所以我用同一套 docxmcp 後端腳本完成補拆。」
- 期間出現多次 no-op placeholder bash call，原因是 dynamic MCP tool 無法直接呼叫。

## Ownership Analysis

目前證據顯示這比較像 `opencode` 端問題，而不是 `docxmcp` MCP server 端問題。

- `docxmcp` 端有提供 tool schema：`/home/pkcs12/projects/docxmcp/bin/_mcp_registry.py` 中 `docxmcp_pdf_extract_all` 與 `docxmcp_extract_all` 均有 `input_schema`。
- `docxmcp_pdf_extract_all` 的 schema 包含 `source_pdf`、`mode`、`overwrite`，且 `required` 包含 `source_pdf`。
- `docxmcp_extract_all` 的 schema 包含 `doc_dir`，且 `required` 包含 `doc_dir`。
- `opencode` 端 `tool_loader` 明確回傳 `Loaded tools: ... They are available on your next action.`，但實際下一步工具面沒有展開可呼叫 schema。
- `opencode` 端 lazy tool resolution 會把非 always-present 且未 unlock 的工具移到 `lazyTools`，並依賴 session/tool surface 後續注入或 repair tool call；本案症狀落在這段 exposure/invocation chain。

因此 issue 應優先放在 `opencode`。只有在進一步證明 `opencode` 呼叫 MCP `tools/list` 時，`docxmcp` 回傳的 tool name 或 `inputSchema` 缺失/錯誤，才應改發或同步發到 `docxmcp` repo。

Relevant code references:

- `/home/pkcs12/projects/docxmcp/bin/_mcp_registry.py:418` — `docxmcp_pdf_extract_all` tool spec and `input_schema`。
- `/home/pkcs12/projects/docxmcp/bin/_mcp_registry.py:477` — `docxmcp_extract_all` tool spec and `input_schema`。
- `/home/pkcs12/projects/opencode/packages/opencode/src/tool/tool-loader.ts:152` — `tool_loader` implementation and success message。
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/resolve-tools.ts:434` — lazy tools are collected/removed from active tools。
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/resolve-tools.ts:536` — resolved result returns `tools`, `lazyTools`, and `lazyCatalogPrompt`。

## Suspected Root Cause

可能是以下其中之一：

- `tool_loader` 僅更新 capability registry / loaded tool names，沒有把 dynamic MCP tool schema 注入當前可呼叫工具面。
- MCP app manifest / registry 提供了 tool 名稱，但 schema relay 到 session driver 時遺失。
- CLI/harness 對動態載入工具的下一步工具面刷新不完整。
- `tool_loader` 成功狀態缺少「loaded but not callable」的檢查。

## Acceptance Criteria

- 載入 dynamic MCP tools 後，Agent 下一個 action 可以直接看到並呼叫對應工具 schema。
- 若 schema 無法注入，`tool_loader` 回傳錯誤或 warning，包含 tool name、MCP app、失敗原因與建議修復。
- 不應需要透過 bash placeholder 或 backend script 繞過 MCP tool invocation。
- 加一個針對 dynamic MCP tool loading 的回歸測試：載入一個 MCP app tool 後，確認 session tool surface 真的包含 callable schema。

## Workaround

目前可用 workaround 是直接用 docxmcp backend script/CLI 產出 `.src/` 內容，但這繞過 MCP tool layer，無法驗證 tool invocation path，也不符合使用者對「使用 MCP tools」的期待。

## Priority

High for MCP usability. 這會直接影響使用者對 MCP tool 是否真的可用的信任，也會讓 Agent 在需要工具時產生不必要的 fallback/no-op 行為。

## Closure

Closed 2026-05-21. The runtime now exposes canonical `docxmcp_*` tool ids and live `tool_loader({"tools":["docxmcp_extract_all","docxmcp_odt_extract_all","docxmcp_stage_dir"]})` succeeds, making the corresponding callable schemas available on the next action.
