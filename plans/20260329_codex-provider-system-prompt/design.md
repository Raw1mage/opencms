# Design

## Context

- The current session UI already renders assistant text parts through `packages/app/src/pages/session/components/message-content.tsx`, which passes text into the shared `Markdown` component.
- Rich markdown infrastructure already exists through `packages/app/src/pages/session/session-rich-content-provider.tsx`, which wraps the session surface in `MarkedProvider`, `DiffComponentProvider`, and `CodeComponentProvider`.
- File loading, normalization, and selected-line state already exist in `packages/app/src/context/file.tsx`.
- File tab rendering and SVG-specific preview behavior already exist in `packages/app/src/pages/session/file-tabs.tsx`.
- Markdown files currently appear to fall through the generic `renderCode(contents(), ...)` branch in `file-tabs.tsx`, so the file tab has no markdown-aware render path yet.

## Goals / Non-Goals

**Goals:**

- Upgrade markdown file viewing in-place inside the existing file tab surface.
- Reuse existing file tab/file context infrastructure for chat navigation.
- Advance markdown file viewing and chat navigation as parallel top-level tracks with small slices.
- Extend the renderer in a way that makes Mermaid/SVG integration incremental rather than a second rewrite.

**Non-Goals:**

- Do not make chat rendering responsible for file-state ownership.
- Do not introduce unrestricted HTML rendering in assistant messages.
- Do not rebuild the file viewer when the required open/select primitives already exist.

## Decisions

- Decision 1: Markdown file tabs will gain a markdown-aware branch instead of always falling through to `renderCode(...)`.
- Decision 2: File-reference clicks will dispatch into existing file context and tab APIs, preserving current tab persistence and selected-line authority.
- Decision 3: Rich markdown expansion will be component-driven, using the existing session rich-content provider as the extension boundary and preferably sharing that stack with markdown file tabs.
- Decision 4: Mermaid support will be introduced via fenced-block recognition and safe component rendering, not raw HTML insertion.
- Decision 5: SVG support in markdown/chat will be preview-first and reuse the existing file-tab SVG viewer where possible.

## Data / State / Control Flow

- Assistant text parts are emitted into `MessageContent`, which currently forwards plain text markdown to the shared `Markdown` component.
- File tabs currently branch by content type and default plain text content to `renderCode(contents(), ...)`; markdown file viewing needs a new markdown-aware branch before that fallback.
- File path interaction should parse chat text into renderable tokens or markdown node overrides, then call file open/select actions owned by file/layout context.
- The file context normalizes paths, loads file content, and stores selected lines; the file tab surface reads the selected-line state and reflects it in the viewer.
- Mermaid/SVG rendering should stay downstream of markdown parsing and upstream of the visual component layer, so invalid diagrams can safely fall back to text/code rendering.

## Risks / Trade-offs

- Dual-track complexity -> Running markdown file viewing and chat linking in parallel increases surface area, so tasks must stay slice-based and validation-heavy.
- Renderer hook risk -> If `Markdown` or `MarkedProvider` cannot expose custom renderers cleanly, the implementation may need a shared UI extension before app-level integration can land.
- Path parsing ambiguity -> Repo-relative paths, absolute paths, and ordinary colon-delimited text can collide; parser behavior must be conservative and test-backed.
- State coupling risk -> Directly mutating tab/view state from message components could create hidden coupling; integration should route through existing context methods.
- SVG scope creep -> Chat-inline SVG preview is attractive, but reusing the file-tab SVG viewer keeps security and UI complexity bounded.
- Mermaid security/runtime risk -> Diagram rendering libraries can become a sanitizer bypass if treated as trusted HTML; the renderer must stay fenced and fallback-safe.

## Critical Files

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/components/message-content.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/session-rich-content-provider.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/file.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/file-tabs.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/platform.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/components/session-turn.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
