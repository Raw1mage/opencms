# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first.
- Build agent must read proposal.md, spec.md, design.md, and tasks.md before coding.
- Materialize tasks.md into runtime todos before coding.
- Preserve planner task naming in user-visible progress and runtime todos.
- The original MVP tracks are now implemented; further work should focus only on the remaining follow-up gaps unless the user reopens scope.

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State

- Markdown file viewing in file tabs is implemented with `Preview / Source`.
- Chat file-reference navigation is implemented for absolute paths, repo-relative paths, and optional `:line`.
- Shared rich markdown rendering is implemented across chat and markdown file preview.
- Mermaid true render first-pass is implemented in the shared rich markdown surface with explicit fallback behavior.
- SVG handling remains intentionally conservative: `.svg` reference-safe path only.
- A post-launch UX bug was fixed so opening a file from the file list now activates the newly opened file tab immediately.
- The remaining work is limited to Mermaid coverage/UI verification, broader SVG support, and richer chat file-link formats.

## Stop Gates In Force

- Stop if broader SVG support would require inline raw SVG execution or unsanitized DOM injection.
- Stop if richer file-link formats create ambiguous parsing that cannot be kept conservative.
- Stop if Mermaid coverage expansion requires a renderer contract change outside the current shared markdown surface.

## Build Entry Recommendation

- If continuing implementation, start with `7.1 Expand Mermaid syntax coverage and UI/component-level validation`, because it is the largest remaining functionality/quality gap.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
