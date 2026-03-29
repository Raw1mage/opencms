# Proposal

## Why

- Markdown files currently open in file tabs as raw code-style text, which blocks the intended webapp reading experience for docs, plans, and diagram-heavy files.
- Assistant responses already contain markdown-like structure and file references, but the current user experience breaks because path references are not clickable in the chat surface.
- The webapp already has a working file tab and file viewer model, so failing to connect chat output to that surface wastes existing product capability.
- Rich markdown and diagram rendering are reasonable product expectations for a webapp-based control plane, but the rollout should start with the smallest high-value interaction slice.

## Original Requirement Wording (Baseline)

- "載入planner skill，在/plans規劃一份實作計畫文件"

## Requirement Revision History

- 2026-03-29: Scope shifted from codex prompt inventory discussion into a product plan for chat rich-content rendering after the user clarified the real goal is interactive markdown/file-link rendering in the webapp.
- 2026-03-29: MVP priority was narrowed to file-reference navigation wired into the existing file tab before broader markdown, Mermaid, and SVG expansion.
- 2026-03-29: The user clarified that markdown file viewing with SVG and Mermaid support is a current top priority and requested a dual-track plan where markdown file viewing and chat file-link navigation advance in parallel.
- 2026-03-29: The user selected `Preview / Source` for markdown file tabs, `.svg` reference support without inline raw SVG, `Path` plus optional `:line` for chat links, and broader Mermaid variant coverage rather than fenced-block-only support.

## Effective Requirement Description

1. Produce a `/plans` implementation package for upgrading both markdown file viewing and assistant chat output in the webapp.
2. Use the existing file tab/file viewer infrastructure instead of inventing a parallel navigation surface.
3. Render `.md` files inside file tabs as markdown rather than generic code-only text.
4. Provide a `Preview / Source` toggle for `.md` files.
5. Support SVG-oriented markdown viewing through safe `.svg` references rather than inline raw SVG.
6. Support Mermaid rendering beyond a single fenced-block variant, with safe fallback.
7. In parallel, make chat file references clickable and line-aware for `absolute path`, `repo-relative path`, and optional `:line`.

## Scope

### IN

- Markdown file-tab rendering strategy.
- `Preview / Source` interaction model for `.md` files.
- Chat output file-reference parsing and interaction design.
- Existing file tab reuse and line-selection handoff.
- Markdown renderer extension strategy.
- Mermaid and SVG rendering strategy within a safe, sanitized boundary.
- Validation, rollout order, and architectural constraints.

### OUT

- Replacing the whole editor/file system UX.
- Building a generic arbitrary-HTML embed platform.
- Supporting inline raw SVG markup in the first release.
- Solving every possible artifact type in the first release.

## Non-Goals

- Do not redesign the entire session page layout.
- Do not make chat messages the authority for file state.
- Do not make markdown files render through unrestricted raw HTML injection.
- Do not bypass existing file context, tab persistence, or view-state stores.

## Constraints

- Must reuse the existing webapp file opening, tab management, and line-selection model.
- Must preserve safe rendering boundaries; no unsanitized HTML/SVG injection.
- Must keep current markdown/code/diff rendering intact while extending capabilities.
- Must remain compatible with the current Solid.js frontend layering and context ownership described in `specs/architecture.md`.

## What Changes

- Markdown files in file tabs gain a rendered reading mode instead of always falling back to code-style display.
- Markdown file tabs gain a `Preview / Source` toggle.
- Assistant message rendering gains a file-reference linking layer that opens existing file tabs and selects referenced lines.
- The markdown rendering surface is refactored to accept richer component overrides without discarding current markdown support.
- Mermaid variants and chat-safe SVG affordances are introduced as later-phase enhancements.

## Capabilities

### New Capabilities

- Rendered markdown file view: open `.md` files in a reading-oriented view inside existing file tabs.
- `Preview / Source` toggle for markdown files.
- Clickable file references in assistant output: open files directly from chat.
- Line-targeted chat navigation: jump from `path:line` references into selected lines in the file viewer.
- Markdown component extensibility: controlled renderer surface for future rich embeds.
- Mermaid diagram rendering in file tabs and chat for supported variants.

### Modified Capabilities

- File tab behavior: markdown files no longer need to be treated only as generic code text.
- Assistant message text rendering: upgraded from passive markdown display to interactive markdown/navigation surface.
- SVG handling: existing file-tab SVG viewer becomes part of the chat-to-file and markdown-file workflow rather than an isolated file-only feature.

## Impact

- Affects session message rendering, file context integration, and shared rich-content provider wiring.
- Adds parser and UI tests in the webapp frontend.
- May require minor shared UI markdown component extensions if the current provider cannot expose custom interactive nodes.
- Improves operator workflow by reducing copy-paste of file paths from assistant replies and by making markdown artifacts readable directly inside file tabs.
