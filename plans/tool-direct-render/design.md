# Design: Tool Output Direct Render

## Context

All MCP tool outputs currently flow through the model for post-processing before the user sees meaningful results. For data-retrieval tools (read email, list events, query databases), this wastes tokens and often causes small models to truncate or fail entirely. The user just wants to see the data.

The current data flow:

```
Tool executes → result → Session.updatePart() → Bus → UI (shows output)
                   ↓
            AI SDK converts to ToolResultBlockParam → model consumes full output
```

Both paths already exist. The UI already receives and displays tool output. The problem is that the model ALSO receives the full output, consuming tokens unnecessarily.

## Goals / Non-Goals

**Goals:**

- Reduce model token consumption for read-only tool results by >90%
- Display tool output directly in UI without waiting for model processing
- Maintain backward compatibility for tools that need model reasoning on output

**Non-Goals:**

- Rich HTML rendering (iframe, webview) — plain text and markdown tables are sufficient
- Interactive tool outputs (editing, filtering)
- Changing the MCP protocol itself — this is an opencode-layer feature

## Decisions

| DD | Decision | Rationale |
|----|----------|-----------|
| DD-1 | Flag lives in `mcp.json` as `directRender: string[]` (list of tool names) | App developer knows which tools are read-only. Per-tool granularity — same app may have both read-only and mutating tools |
| DD-2 | Interception point: `resolve-tools.ts` MCP tool wrapper | This is where MCP results are normalized before being returned to the AI SDK. We replace the output text here, keeping the full output in the part metadata |
| DD-3 | Full output stored in `ToolPart.state.fullOutput`, summary in `state.output` | UI reads `fullOutput` for display; model sees `output` (the summary). No changes needed to Bus or event reducer |
| DD-4 | Summary format: `[Displayed to user: {chars} chars, {lines} lines]` | Short, informative, tells the model the data was shown. Model can decide to ask the user about it |
| DD-5 | UI component: extend existing `MessageToolInvocation` with markdown renderer for direct-render parts | No new component — just a conditional branch in the existing tool result display |

## Data / State / Control Flow

```
MCP tool executes → CallToolResult
    ↓
resolve-tools.ts normalizes result
    ↓
Check: is this tool in manifest.directRender[]?
    ├─ NO → normal flow (output = full text, fullOutput = undefined)
    └─ YES → split:
         output = "[Displayed to user: 52076 chars, 440 lines]"  ← model sees this
         fullOutput = full text                                    ← UI reads this
    ↓
ToolInvoker returns result
    ↓
Session.updatePart({ state: { output, fullOutput, metadata } })
    ↓
Bus.publish(PartUpdated) → UI event reducer → SolidJS store
    ↓
MessageToolInvocation:
  if (part.state.fullOutput) → render markdown(fullOutput)
  else → render output as before
```

## Risks / Trade-offs

- **Risk**: Model cannot answer follow-up questions about direct-rendered content
  - **Mitigation**: Summary tells model "displayed to user". Model can say "I can see it was displayed — what specifically would you like to know?" User can copy-paste relevant portions
- **Risk**: Some tools return output that needs model interpretation (e.g. error messages mixed with data)
  - **Mitigation**: `directRender` is opt-in per tool name. Only add tools that are purely read-only data display
- **Risk**: Very large `fullOutput` in part storage could bloat session state
  - **Mitigation**: Cap `fullOutput` at 64KB. Beyond that, truncate with expansion marker

## Critical Files

- `packages/opencode/src/mcp/manifest.ts` — add `directRender` to schema
- `packages/opencode/src/mcp/app-store.ts` — propagate `directRender` to AppEntry
- `packages/opencode/src/session/resolve-tools.ts` — interception point for output splitting
- `packages/opencode/src/session/message-v2.ts` — extend ToolPart state with `fullOutput`
- `packages/app/src/pages/session/components/message-tool-invocation.tsx` — render fullOutput as markdown
