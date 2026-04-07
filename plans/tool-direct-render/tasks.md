# Tasks

## Phase 1 — Schema + Backend Plumbing

- [ ] 1.1 Add `directRender: z.array(z.string()).optional()` to `McpAppManifest.Schema` in manifest.ts
- [ ] 1.2 Add `directRender` to `AppEntry` schema in app-store.ts, populate from manifest in `buildEntry()`
- [ ] 1.3 Extend `ToolPart` state type in message-v2.ts: add optional `fullOutput: string` field
- [ ] 1.4 In resolve-tools.ts MCP tool wrapper: after result normalization, check if tool name is in app's `directRender[]`. If yes, move output to `fullOutput` and replace `output` with summary string
- [ ] 1.5 Verify: model receives summary, part.state.fullOutput contains full text (log check)

## Phase 2 — UI Rendering

- [ ] 2.1 In message-tool-invocation.tsx: detect `part.state.fullOutput` presence
- [ ] 2.2 When fullOutput exists: render as markdown (use existing markdown renderer component)
- [ ] 2.3 Add collapsible "Show more" for outputs exceeding ~200 lines
- [ ] 2.4 Ensure tool header (title, status) still renders normally above the content

## Phase 3 — Gmail App Integration

- [ ] 3.1 Update `~/projects/mcp-apps/gmail/mcp.json`: add `"directRender": ["get-message", "list-messages"]`
- [ ] 3.2 Rebuild and deploy gmail-server binary
- [ ] 3.3 Re-register gmail in mcp-apps.json (or restart daemon to pick up manifest change)

## Phase 4 — Validation

- [ ] 4.1 Test: `get-message` on 52KB email — UI shows full markdown table, model log shows < 100 token result
- [ ] 4.2 Test: `list-messages` — each message renders directly in UI
- [ ] 4.3 Test: `send-message` (NOT in directRender) — model still processes result normally
- [ ] 4.4 Test: small model (qwen 9B) can handle direct-rendered gmail without failing
- [ ] 4.5 Test: follow-up question after direct render — model responds coherently

## Stop Gates

- SG-1: Non-directRender tools must behave identically to current behavior (zero regression)
- SG-2: Model must never receive >200 tokens for a direct-rendered tool result
- SG-3: UI must render markdown tables properly (not raw pipe characters)
