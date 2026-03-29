# Implementation Spec

## Goal

- Upgrade file and chat rich-content rendering so markdown files are readable in file tabs, chat file references open the correct file view, Mermaid diagrams render in the shared markdown surface, and remaining follow-up work is clearly scoped.

## Scope

### IN

- Render markdown files inside the existing file view tab with markdown-aware presentation instead of plain code-only display.
- Provide a `Preview / Source` toggle for `.md` files so rendered markdown and raw source remain accessible.
- Support embedded SVG references and Mermaid content in markdown file viewing.
- Wire assistant message file references to the existing webapp file tab system.
- Support line-aware navigation from chat output into the existing file viewer.
- Keep file list opening behavior aligned with user expectation by activating the newly opened file tab immediately.
- Define follow-up scope for Mermaid coverage/UI verification, broader SVG support, and richer file-link formats.

### OUT

- Replacing the existing file tab implementation.
- Rewriting the markdown renderer from scratch.
- Introducing arbitrary raw HTML rendering in chat messages or markdown files.
- Supporting inline raw SVG markup in markdown in the current shipped implementation.
- Broadening file-link parsing beyond conservative unambiguous formats without additional review.

## Assumptions

- The existing webapp file tab and file context remain the authority for file opening, selection, and line-focus state.
- Assistant text content continues to enter the UI through `MessageContent` and the shared rich markdown surface rather than a bespoke renderer.
- SVG behavior in markdown files remains limited to `.svg` references or image-style embeds rather than inline raw SVG fragments.
- Current Mermaid render is acceptable as a first-pass implementation, but additional syntax coverage and UI-level validation are still needed.
- Chat file-link parsing remains limited to absolute paths, repo-relative paths, and optional `:line` suffixes until the follow-up format work is scheduled.

## Stop Gates

- Stop if broader SVG support would require unsanitized raw SVG/HTML injection.
- Stop if richer file-link formats create parsing ambiguity that breaks conservative linking behavior.
- Stop if Mermaid coverage expansion requires a larger shared UI renderer contract change than the current plan assumes.
- Stop and re-plan if follow-up work crosses into a broader artifact/embed platform instead of incremental renderer improvements.

## Critical Files

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/components/message-content.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/file-tabs.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/markdown-file-viewer.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/message-file-links.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/rich-markdown-surface.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
- `/home/pkcs12/projects/opencode/packages/app/package.json`

## Structured Execution Phases

- Phase 1: Ship the markdown file viewer, chat file links, shared rich markdown surface, and first-pass Mermaid render.
- Phase 2: Fix post-launch UX issues in file opening/focus behavior.
- Phase 3: Follow up with Mermaid syntax coverage and UI/component-level verification.
- Phase 4: Review whether SVG support should expand beyond `.svg` references and whether richer file-link formats should be added.

## Validation

- Focused tests pass for file-link parsing and markdown file-viewer helpers.
- `packages/app` package-level typecheck runs clean on the implemented branch.
- Mermaid first-pass validation covers helper extraction and package-level type safety, but still needs UI/component-level render verification.
- File-open UX must ensure that opening a new file from the file list activates the new file tab immediately.

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md, spec.md, design.md, tasks.md, and handoff.md before coding.
- The original core MVP is now implemented; remaining work should stay confined to the explicit follow-up gaps unless the user expands scope again.
