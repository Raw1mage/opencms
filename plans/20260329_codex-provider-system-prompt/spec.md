# Spec

## Purpose

- Define the user-visible behavior for markdown-aware file-tab rendering and interactive assistant chat rendering that reuse the existing file tab system and safely extend markdown rendering.

## Requirements

### Requirement: Markdown File Viewing

The system SHALL render markdown files inside the existing file tab surface with markdown-aware presentation.

#### Scenario: Open markdown file in file tab

- **GIVEN** the user opens a `.md` file from the workspace
- **WHEN** the file tab loads the file content
- **THEN** the file tab renders the file as markdown content instead of generic code-only output

#### Scenario: Render markdown-embedded Mermaid content

- **GIVEN** a markdown file contains a supported Mermaid fenced block
- **WHEN** the markdown file viewer parses the content
- **THEN** the file tab renders the Mermaid block through a controlled diagram component or falls back to safe code presentation if validation fails

#### Scenario: Render markdown-embedded SVG references

- **GIVEN** a markdown file references an SVG artifact or contains SVG-oriented content that the viewer supports
- **WHEN** the markdown file viewer renders the document
- **THEN** the user can view the SVG through a safe preview path that reuses existing SVG viewer capability where appropriate

### Requirement: File Reference Navigation

The system SHALL detect file references inside assistant text output and render them as interactive chat elements that open the existing file viewer.

#### Scenario: Open absolute file path from assistant reply

- **GIVEN** an assistant text part contains an absolute path inside the active workspace
- **WHEN** the user clicks that rendered file reference in chat
- **THEN** the webapp opens the existing file tab for that path and loads its content through the current file context

#### Scenario: Jump to referenced line from assistant reply

- **GIVEN** an assistant text part contains a file reference with a line suffix such as `path/to/file.ts:138`
- **WHEN** the user clicks that rendered reference
- **THEN** the webapp opens the file in the existing file tab system and updates selected-line state so the referenced line is focused in the viewer

### Requirement: Markdown Compatibility Preservation

The system SHALL preserve current markdown rendering behavior while adding interactive file-reference handling.

#### Scenario: Preserve existing markdown output

- **GIVEN** an assistant message contains headings, lists, code fences, or inline code that are already rendered today
- **WHEN** the rich-content enhancement ships
- **THEN** those markdown elements continue rendering correctly without requiring users to change prompt style

### Requirement: Controlled Diagram Rendering

The system SHALL add diagram rendering only through controlled, sanitized markdown component pathways.

#### Scenario: Render Mermaid fenced block

- **GIVEN** an assistant message contains a fenced code block marked as Mermaid
- **WHEN** the renderer recognizes a supported Mermaid block
- **THEN** the webapp renders the diagram through a safe Mermaid component instead of injecting raw HTML

#### Scenario: Unsupported or invalid diagram block

- **GIVEN** an assistant message contains invalid Mermaid content or an unsupported diagram payload
- **WHEN** rendering fails validation
- **THEN** the webapp falls back to safe textual/code presentation instead of breaking the message surface

### Requirement: Chat-Safe SVG Handling

The system SHALL reuse existing SVG viewer capabilities rather than embedding arbitrary raw SVG into chat messages.

#### Scenario: Assistant references generated SVG artifact

- **GIVEN** an assistant message references an SVG file artifact in the workspace
- **WHEN** the user opens that reference from chat
- **THEN** the existing file tab SVG viewer handles preview, zoom, and source inspection

## Acceptance Checks

- Markdown files open in a rendered markdown presentation inside file tabs.
- Assistant file references are clickable and open the existing file tab surface.
- `path:line` references update selected-line state in the current file context.
- Current markdown output remains visually and functionally intact.
- Mermaid rendering is limited to controlled supported markdown nodes with safe fallback.
- SVG chat flows route through the existing file-tab viewer rather than direct raw DOM injection.
