# Spec

## Purpose

Allow MCP tool outputs to be displayed directly in the UI without model post-processing, reducing token waste and latency for read-only data retrieval tools.

## Requirements

### Requirement: Direct Render Flag

The system SHALL support a `directRender` flag on MCP tool definitions that controls whether tool output bypasses model context.

#### Scenario: Tool declares directRender

- **GIVEN** an MCP app's `mcp.json` declares `"directRender": ["get-message", "list-messages"]`
- **WHEN** the tool is registered at runtime
- **THEN** the tool's internal metadata includes `directRender: true`

#### Scenario: Tool without directRender

- **GIVEN** an MCP tool has no directRender flag
- **WHEN** the tool executes and returns output
- **THEN** the full output is sent to the model as before (no behavior change)

### Requirement: Model Context Bypass

The system SHALL replace full tool output with a compact summary in model context when `directRender` is true.

#### Scenario: Direct render tool completes

- **GIVEN** `mcpapp-gmail_get-message` has `directRender: true`
- **WHEN** the tool returns 52KB of formatted email content
- **THEN** the UI receives the full 52KB output for display
- **AND** the model receives only a summary: `"[Direct render: displayed to user — 52076 chars, 440 table rows]"`
- **AND** model token consumption for this result is < 100 tokens

#### Scenario: Model can still reference direct-rendered output

- **GIVEN** the model received a summary for a direct-rendered tool result
- **WHEN** the user asks a follow-up question about the content
- **THEN** the model explains it cannot see the full content and suggests the user reference what's displayed

### Requirement: UI Rendering

The system SHALL render direct-render tool output as formatted markdown in the chat UI.

#### Scenario: Markdown table output

- **GIVEN** a direct-render tool returns output containing markdown tables
- **WHEN** the UI renders the tool result
- **THEN** the table is displayed with proper formatting (columns aligned, headers distinct)

#### Scenario: Large output with truncation

- **GIVEN** a direct-render tool returns output exceeding the display limit
- **WHEN** the UI renders the tool result
- **THEN** the output is shown with a "Show more" expansion control

## Acceptance Checks

- Gmail `get-message` with 52KB HTML email: model consumes < 100 tokens for the result, UI shows full formatted content
- Gmail `list-messages` with 10 results: each message preview renders directly, model sees only summary
- Tools without `directRender` flag behave exactly as before (regression check)
- Follow-up questions after direct-render work normally (model can still reason)
