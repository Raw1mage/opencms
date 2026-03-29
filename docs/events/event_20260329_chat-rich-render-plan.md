# Event Log

## Requirement

- Plan a `/plans` implementation package for improving chat output rendering in the webapp.
- Reuse the existing file view/file tab surface so assistant file references can open files directly from chat.
- Stage the work: file reference navigation first, markdown/render expansion second, Mermaid/SVG support later.

## Requirement Update

- The user clarified that markdown file viewing inside file tabs is a current top priority, especially for `.md` documents with SVG and Mermaid-oriented content.
- The user selected a dual-track plan: markdown file viewing and chat file-link navigation should both be planned rather than forcing a single-track MVP ordering.

## Scope

### IN

- Planner artifacts for file-reference navigation, markdown renderer extension, and diagram rendering rollout.
- Evidence-based mapping of existing message rendering, file context, file tabs, and SVG viewer surfaces.

### OUT

- Immediate code implementation.
- Repo-wide renderer rewrite.

## Task List

- Read planner skeleton and architecture evidence.
- Confirm current chat rendering and file-tab ownership surfaces.
- Write implementation-spec, proposal, spec, design, tasks, and handoff artifacts.
- Replace placeholder diagram artifacts with feature-specific IDEF0/GRAFCET/C4/Sequence outputs.

## Conversation Summary

- The user clarified that markdown hyperlinks are desirable, but the real product goal is to make them actually render and interact correctly in the webapp.
- The user pointed out that the product already has a file view tab and suggested connecting assistant output to that surface before adding broader rendering support.
- Further inspection showed that chat messages already use `Markdown`, while file tabs still render markdown files through generic code output.
- Planning was therefore revised into a dual-track model: markdown file viewing and chat file-link navigation are parallel tracks, with shared renderer work and Mermaid/SVG following as controlled expansions.

## Debug Checkpoints

### Baseline

- Assistant replies already contain markdown-like structure and file references.
- Current user experience does not let those file references act as navigable UI elements.
- Existing webapp already provides file tabs and an SVG-aware file viewer.
- Markdown files in file tabs do not yet receive markdown-aware rendering.

### Instrumentation Plan

- Read session message renderer files to identify the current assistant text rendering seam.
- Read file context and file tab files to confirm file-open and selected-line authority surfaces.
- Read the rich-content provider to determine whether markdown extension should happen inside existing provider boundaries.

### Execution

- Confirmed `packages/app/src/pages/session/components/message-content.tsx` renders assistant text via `Markdown`.
- Confirmed `packages/app/src/pages/session/session-rich-content-provider.tsx` already wraps session UI with `MarkedProvider`, `DiffComponentProvider`, and `CodeComponentProvider`.
- Confirmed `packages/app/src/context/file.tsx` owns path normalization, loading, and selected-line state.
- Confirmed `packages/app/src/pages/session/file-tabs.tsx` already consumes selected lines and includes dedicated SVG preview behavior.
- Confirmed `packages/app/src/pages/session/file-tabs.tsx` still routes generic loaded text, including markdown files, through `renderCode(...)` rather than a markdown-aware viewer branch.

### Root Cause

- The missing capability is not the absence of a file viewer; it is the lack of binding between assistant message rendering and the existing file-navigation authority.
- Rich markdown support is partially present already, but it is asymmetrical: chat has a markdown renderer while markdown files in file tabs still lack one.
- Interactive component mapping for file references and diagrams is not yet wired into a shared renderer surface that both chat and file tabs can use.

### Validation

- Planner artifacts were rewritten to align with the confirmed frontend evidence.
- Diagram artifacts were updated from placeholders to feature-specific planning models.
- `specs/architecture.md` was read and remains the current structural authority; no architecture state update was required during planning.

## Decisions

- Treat markdown file viewing and chat file-link navigation as dual-track top-level workstreams.
- Preserve the current markdown path and extend it rather than replacing it.
- Add a markdown-aware branch to file tabs instead of leaving `.md` files on the generic code path.
- Treat Mermaid and SVG as controlled extensions after markdown file viewing and chat-link MVPs are stable.
- Keep SVG rich behavior authoritative in the existing file viewer, not directly in raw chat DOM.

## Verification

- Read `/home/pkcs12/projects/opencode/packages/app/src/pages/session/components/message-content.tsx`
- Read `/home/pkcs12/projects/opencode/packages/app/src/pages/session/session-rich-content-provider.tsx`
- Read `/home/pkcs12/projects/opencode/packages/app/src/context/file.tsx`
- Read `/home/pkcs12/projects/opencode/packages/app/src/pages/session/file-tabs.tsx`
- Read `/home/pkcs12/projects/opencode/specs/architecture.md`

## Architecture Sync

- Verified no architecture.md changes are required at planning time because this task produced a plan, not a code-path or module-boundary change.
