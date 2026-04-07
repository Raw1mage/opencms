# Tasks

## Phase 1 — Schema + Manifest

- [ ] 1.1 Add `modelProcess: z.array(z.string()).optional()` to `McpAppManifest.Schema`
- [ ] 1.2 Propagate `modelProcess` to `AppEntry` in app-store.ts
- [ ] 1.3 Add `directRender` object type to ToolPart state in message-v2.ts:
  - `filePath: string` — relative path under session dir
  - `title: string` — display name for the link button
  - `size: number` — content size in chars

## Phase 2 — Core Fork (resolve-tools.ts)

- [ ] 2.1 In MCP tool wrapper: determine render mode
  - tool in `modelProcess[]` → AI 處理（不改）
  - session is cron → AI 處理（不改）
  - otherwise → 直送
- [ ] 2.2 直送路徑：寫暫存檔到 `{sessionDir}/files/{toolCallId}-{sanitizedTitle}.md`
- [ ] 2.3 直送路徑：`Session.updatePart()` 寫入 `state.directRender = { filePath, title, size }`
- [ ] 2.4 直送路徑：return summary to AI SDK: `[File displayed: "{title}" ({size}). User can see it in file viewer.]`
- [ ] 2.5 Processor merge guard: don't overwrite existing `directRender` on part state

## Phase 3 — UI: 檔案連結按鈕

- [ ] 3.1 In message-tool-invocation.tsx: detect `part.state.directRender`
- [ ] 3.2 Render as clickable file link button: `📎 {title}` with file size badge
- [ ] 3.3 Click handler: open file in fileview tab (`filePath` → fileview route)
- [ ] 3.4 Tool header (name, status icon) still renders above the link button

## Phase 4 — Gmail Integration

- [ ] 4.1 Gmail mcp.json: add `"modelProcess": ["send-message", "reply-message", "forward-message", "create-draft"]`
  - 所有 read-only tools（get-message, list-messages, list-labels, list-drafts）預設直送
- [ ] 4.2 Rebuild and deploy gmail-server binary
- [ ] 4.3 Google Calendar mcp.json: add `"modelProcess": ["create-event", "update-event", "delete-event"]`
  - read-only tools（list-calendars, list-events, get-event, freebusy）預設直送
- [ ] 4.4 Rebuild and deploy gcal-server binary

## Phase 5 — Validation

- [ ] 5.1 Test: `get-message` on large email → 對話顯示檔案連結、fileview 顯示完整 markdown
- [ ] 5.2 Test: model log 確認 summary < 100 tokens
- [ ] 5.3 Test: `send-message` → model 正常處理（在 modelProcess 名單）
- [ ] 5.4 Test: cron session 執行 gmail → model 正常處理（cron 自動 AI 處理模式）
- [ ] 5.5 Test: small model (qwen 9B) 順利完成 gmail 查詢
- [ ] 5.6 Test: non-MCP tools (bash, edit) 完全不受影響

## Stop Gates

- SG-1: Non-MCP tools 完全不受影響
- SG-2: Model 對 direct-render 結果消耗 < 200 tokens
- SG-3: 暫存檔大小 cap 64KB
- SG-4: Cron session 不走直送模式
