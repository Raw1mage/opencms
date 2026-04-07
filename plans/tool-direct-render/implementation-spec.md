# Implementation Spec

## Goal

Allow MCP tool outputs to render directly in the UI, bypassing model token consumption, for tools declared as `directRender` in their app manifest.

## Scope

### IN

- `directRender` flag in mcp.json manifest schema
- Output splitting in resolve-tools.ts (fullOutput for UI, summary for model)
- ToolPart state extension with `fullOutput` field
- UI markdown rendering for direct-render tool results
- Gmail app integration (get-message, list-messages)

### OUT

- Rich HTML rendering (iframe, webview)
- Attachment rendering (PDF, images, Excel)
- Interactive tool outputs (editing, filtering, sorting)
- Changes to the MCP protocol itself
- Non-MCP tools (bash, edit, etc. — they already have specialized UI)

## Assumptions

- The existing markdown renderer in the app UI can handle tables and basic formatting
- MCP tool results are always text-based (no binary content in direct-render tools)
- The AI SDK's tool result mechanism allows modifying the output string before it reaches the model

## Stop Gates

- SG-1: Any regression in non-directRender tool behavior → stop and investigate
- SG-2: Model receiving >200 tokens for a direct-rendered result → summary generation is broken
- SG-3: fullOutput exceeding 64KB without truncation → cap enforcement failed

## Critical Files

- `packages/opencode/src/mcp/manifest.ts` — schema extension
- `packages/opencode/src/mcp/app-store.ts` — propagate to AppEntry
- `packages/opencode/src/session/resolve-tools.ts` — interception point (lines 221-303)
- `packages/opencode/src/session/message-v2.ts` — ToolPart state extension
- `packages/app/src/pages/session/components/message-tool-invocation.tsx` — UI rendering
- `~/projects/mcp-apps/gmail/mcp.json` — add directRender declaration

## Structured Execution Phases

- Phase 1: Backend plumbing — schema flag, state extension, output splitting in resolve-tools.ts
- Phase 2: UI rendering — markdown display for fullOutput, collapsible for large content
- Phase 3: Gmail integration — update mcp.json, rebuild, deploy, test
- Phase 4: Validation — token check, regression check, small model test

## Validation

- `get-message` on large email: UI shows formatted content, model log shows summary < 100 tokens
- `send-message` (not directRender): model still receives full output (regression check)
- Small model (qwen 9B): can handle gmail get-message without truncation or failure
- `bun test` passes (no type errors from schema changes)

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
