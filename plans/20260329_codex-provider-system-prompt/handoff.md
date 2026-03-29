# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first.
- Build agent must read proposal.md, spec.md, design.md, and tasks.md before coding.
- Materialize tasks.md into runtime todos before coding.
- Preserve planner task naming in user-visible progress and runtime todos.
- Treat `1. Markdown File Viewer MVP` and `2. Chat File-Reference Navigation MVP` as parallel top-level tracks; neither should expand into a broad renderer rewrite before its MVP behavior is proven.

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State

- The plan is based on confirmed existing infrastructure: `MessageContent` already renders via `Markdown`, the session surface already uses `MarkedProvider`, file tabs already exist, file context already stores selected lines, and the file viewer already has an SVG-specific path.
- `file-tabs.tsx` still sends generic loaded text content through `renderCode(...)`, so markdown file viewing does not yet have a dedicated renderer path.
- No code has been changed yet.
- The plan root name reflects the session title rather than the refined feature name; treat the artifact contents as authoritative.

## Stop Gates In Force

- Stop if shared markdown primitives do not expose a clean extension point for custom file-reference rendering.
- Stop if file opening and selected-line updates cannot be triggered through current app contexts without inventing a second authority surface.
- Stop if Mermaid/SVG requires unsanitized DOM injection.
- Return to planning if execution discovers a repo-wide shared UI contract change larger than these phases assume.

## Build Entry Recommendation

- Start with `1.2` and `1.3` to prove markdown file rendering can reuse the existing rich-content stack, while separately scoping `2.1` and `2.2` for conservative file-reference parsing.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in tasks.md
