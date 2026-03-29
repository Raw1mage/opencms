# Implementation Spec

## Goal

- Add a production-ready rich-content enhancement plan that upgrades both markdown file viewing in file tabs and assistant chat file-reference navigation, while enabling SVG and Mermaid rendering through safe staged rollout.

## Scope

### IN

- Render markdown files inside the existing file view tab with markdown-aware presentation instead of plain code-only display.
- Provide a `Preview / Source` toggle for `.md` files so rendered markdown and raw source remain accessible.
- Support embedded SVG references and Mermaid content in markdown file viewing.
- Wire assistant message file references to the existing webapp file tab system.
- Support line-aware navigation from chat output into the existing file viewer.
- Preserve the current `Markdown`-based message rendering path while adding component hooks for richer interactive content.
- Plan a phased rollout for Mermaid and chat-embedded SVG handling on top of the existing renderer and SVG viewer capabilities.
- Define validation coverage for parser behavior, renderer behavior, and file-navigation integration.

### OUT

- Replacing the existing file tab implementation.
- Rewriting the markdown renderer from scratch.
- Introducing arbitrary raw HTML rendering in chat messages or markdown files.
- Supporting inline raw SVG markup in markdown for the first delivery.
- Changing non-web surfaces unless required to keep shared rendering contracts coherent.

## Assumptions

- The existing webapp file tab and file context remain the authority for file opening, selection, and line-focus state.
- Assistant text content will continue to enter the UI through `MessageContent` and `Markdown` rather than a separate bespoke message renderer.
- Markdown file viewing can reuse part of the same markdown/rich-content stack already used by session messages instead of inventing a separate renderer.
- SVG behavior in markdown files will be limited to `.svg` references or image-style embeds rather than inline raw SVG fragments.
- Chat file-link parsing in the first delivery is limited to absolute paths, repo-relative paths, and optional `:line` suffixes.

## Stop Gates

- Stop if current `Markdown` / `MarkedProvider` integration cannot expose custom rendering hooks without replacing shared UI primitives.
- Stop if markdown file rendering in file tabs cannot reuse the existing rich-content stack without a larger shared UI contract rewrite.
- Stop if Mermaid support across multiple markdown variants requires a library or parser contract broader than the planned slice assumes.
- Stop if file-tab opening and line selection are not callable from the session message surface without unsafe cross-context state mutation.
- Stop if Mermaid or SVG rendering would require unsanitized HTML injection.
- Stop and re-plan if shared UI package ownership (`@opencode-ai/ui`) forces a repo-wide renderer contract change larger than this phased slice assumes.

## Critical Files

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/components/message-content.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/components/session-turn.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/session-rich-content-provider.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/file-tabs.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/file.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/layout.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/platform.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/use-session-commands.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/session-prompt-helpers.ts`

## Structured Execution Phases

- Phase 1: Add markdown-aware file-tab rendering for `.md` content, including a `Preview / Source` toggle and a defined behavior for `.svg` references and Mermaid content.
- Phase 2: Add file-reference detection and click-through bindings from assistant chat output into the existing file-tab and selected-line infrastructure.
- Phase 3: Refactor the rich-content surface so file tabs and chat can share controlled markdown component mapping without regressing current behavior.
- Phase 4: Add Mermaid rendering support for multiple markdown variants and chat-safe SVG handling on top of the shared renderer, reusing the existing SVG viewer where possible and enforcing sanitization boundaries.
- Phase 5: Validate interaction, rendering, and regression behavior; sync event and architecture documentation as needed.

## Validation

- Add UI coverage confirming markdown files open in a rendered markdown view rather than raw code-only presentation.
- Add UI coverage for `Preview / Source` toggle behavior on `.md` files.
- Validate markdown file rendering for headings, lists, code fences, links, and embedded diagrams.
- Validate `.svg` references inside markdown through a safe preview path rather than inline raw SVG injection.
- Add parser-level tests for absolute path, repo-relative path, and `path:line` detection.
- Add UI tests covering click-to-open-tab and jump-to-line behavior from assistant messages.
- Verify that existing markdown text, code blocks, and diff/code rendering continue to work unchanged.
- Validate Mermaid rendering against supported markdown variants, with explicit non-render fallback for unsupported or invalid diagrams.
- Validate SVG handling by reusing existing SVG file-tab viewer behavior rather than injecting raw SVG directly into the chat DOM.

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md, spec.md, design.md, tasks.md, and handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must treat markdown file viewing and chat file-link navigation as parallel top-level tracks, but still land them in small dependency-safe slices.
