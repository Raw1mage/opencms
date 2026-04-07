# Proposal: Tool Output Direct Render

## Problem

Currently all MCP tool outputs go through the model for processing before being shown to the user. For read-only tools like `get-message`, `list-messages`, `list-events`, this wastes tokens and adds latency — the user just wants to see the data, not an AI summary of it.

Example: reading a 52KB email with a stock ranking table → model consumes the entire output as context tokens → model may truncate, summarize, or fail to respond (especially small models).

## Goal

Allow certain tool outputs to be rendered **directly in the UI** without model post-processing. The model still decides which tool to call, but the result is presented as-is to the user.

## Scope

- Define a mechanism for tools to declare "direct render" capability
- Session layer bypass: tool output → UI, skipping model consumption
- UI rendering: markdown/table/text display of tool output
- Model still sees a short summary (e.g. "Email displayed to user") instead of the full output

## Out of Scope

- Rich HTML rendering in UI (not an iframe/webview)
- Attachment handling (PDF, images, Excel)
- Tool output editing/interaction

## Success Criteria

- `get-message` output displayed directly in UI as formatted text/table
- Model token consumption reduced by >90% for read-only tool calls
- No regression for tools that require model processing (e.g. `send-message` still needs model to confirm)

## Prior Art

- Claude Code's `Read` tool: output displayed directly, model gets a summary
- ChatGPT's code interpreter: output shown in collapsible block
- Cursor's terminal output: streamed directly to UI
