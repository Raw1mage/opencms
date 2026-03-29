# Proposal

## Why

- Markdown files need to be readable in file tabs instead of falling back to code-only display.
- Assistant replies need to connect directly to the existing file-view surface so file references become actionable.
- Rich markdown rendering should behave consistently across chat and file preview, including Mermaid handling and safe SVG policy.
- Post-launch file-open behavior should match user expectation: opening a new file from the file list should immediately focus that file.

## Original Requirement Wording (Baseline)

- "載入planner skill，在/plans規劃一份實作計畫文件"

## Requirement Revision History

- 2026-03-29: Scope shifted from codex prompt inventory discussion into a product plan for chat rich-content rendering after the user clarified the real goal is interactive markdown/file-link rendering in the webapp.
- 2026-03-29: The user clarified that markdown file viewing with SVG and Mermaid support is a current top priority and requested a dual-track plan where markdown file viewing and chat file-link navigation advance in parallel.
- 2026-03-29: The user selected `Preview / Source` for markdown file tabs, `.svg` reference support without inline raw SVG, `Path` plus optional `:line` for chat links, and broader Mermaid coverage than fenced-block-only support.
- 2026-03-30: Core MVP shipped, Mermaid first-pass true render was added, and a post-launch file-tab focus bug was fixed. Remaining work was reduced to Mermaid coverage/UI verification, broader SVG support, and richer file-link formats.

## Effective Requirement Description

1. Make `.md` files readable in file tabs with `Preview / Source`.
2. Keep SVG handling safe through `.svg` reference paths, not inline raw SVG.
3. Make chat file references open the correct file tab and support optional `:line` focus.
4. Share markdown rendering behavior across chat and markdown file preview.
5. Render Mermaid diagrams in the shared rich markdown surface with safe fallback.
6. Ensure file-list opens immediately focus the newly opened file tab.
7. Track remaining follow-up gaps explicitly instead of silently broadening the feature.

## Scope

### IN

- Markdown file-tab rendering
- `Preview / Source` for `.md`
- Chat file-reference navigation
- Shared rich markdown rendering
- Mermaid first-pass true render plus fallback
- Safe `.svg` reference handling
- File-open auto-focus UX correction
- Follow-up backlog for remaining renderer gaps

### OUT

- Arbitrary raw HTML embed platform
- Inline raw SVG execution
- Unlimited file-link pattern support in the current shipped scope
- Broader unrelated file-view redesign

## Non-Goals

- Do not redesign the whole session/file layout.
- Do not bypass existing file context or tab ownership.
- Do not add permissive parsing that links arbitrary colon-delimited text as files.

## Constraints

- Must reuse the existing webapp file opening, tab management, and line-selection model.
- Must preserve safe rendering boundaries; no unsanitized HTML/SVG injection.
- Must keep current markdown/code/diff rendering intact while extending capabilities.

## What Changes

- Markdown files in file tabs render as markdown with `Preview / Source`.
- Assistant file references open existing file tabs and can focus referenced lines.
- Chat and markdown file preview use the same rich markdown surface.
- Mermaid diagrams render in the shared rich markdown surface with explicit fallback.
- File-list opens now activate the newly opened file tab immediately.

## Capabilities

### New Capabilities

- Rendered markdown file view in existing file tabs
- `Preview / Source` toggle for markdown files
- Clickable file references in assistant output
- Line-targeted chat navigation
- Shared rich markdown surface for chat and markdown preview
- Mermaid first-pass render in chat and markdown file preview

### Modified Capabilities

- File tab behavior now focuses newly opened files immediately.
- SVG handling is now part of the markdown/chat rich-content workflow, but remains conservative.

## Impact

- Affects session message rendering, file tab rendering, tab activation flow, and shared renderer behavior.
- Leaves a small, explicit follow-up backlog rather than a broad unfinished rewrite.
