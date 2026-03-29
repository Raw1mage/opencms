# Design

## Context

- The session UI renders assistant text parts through `packages/app/src/pages/session/components/message-content.tsx`.
- Shared rich markdown rendering now exists as a real implementation surface used by both chat content and markdown file preview.
- File tab rendering in `packages/app/src/pages/session/file-tabs.tsx` now has a markdown-aware branch instead of always falling through to `renderCode(...)`.
- File opening and active-tab control pass through `packages/app/src/pages/session.tsx`, which now must guarantee that newly opened file tabs become active immediately.

## Goals / Non-Goals

**Goals:**

- Keep markdown file viewing, file-link navigation, and rich markdown rendering behavior aligned.
- Preserve safe rendering boundaries while supporting Mermaid render and `.svg` reference-safe workflows.
- Keep follow-up scope explicit rather than silently expanding beyond the shipped MVP.

**Non-Goals:**

- Do not introduce unrestricted HTML or inline raw SVG execution.
- Do not replace the existing file viewer/tab system.
- Do not make chat parsing permissive enough to create frequent false-positive file links.

## Decisions

- Decision 1: Markdown file tabs render through a preview-oriented markdown surface with `Preview / Source` rather than a code-only fallback.
- Decision 2: Chat file references use conservative parsing and dispatch through existing file context/tab APIs.
- Decision 3: Rich markdown rendering is centralized so chat and markdown file preview share fallback and rendering policy.
- Decision 4: Mermaid first-pass render is implemented in the shared rich markdown surface using a strict security configuration plus explicit fallback.
- Decision 5: File-list opens must set the newly opened file tab active immediately; appending without focus is considered incorrect UX.
- Decision 6: Broader SVG support and richer file-link formats remain explicit follow-up work, not silent scope creep.

## Data / State / Control Flow

- Assistant markdown flows through `MessageContent` into the shared rich markdown surface.
- Markdown file preview flows through `file-tabs.tsx` into the same shared rich markdown surface.
- File-link clicks and file-list opens both rely on the existing file/tab authority path; tab creation must be paired with active-tab selection so visible state follows the latest user action.
- Mermaid render happens downstream of markdown preprocessing and falls back explicitly when rendering fails.

## Risks / Trade-offs

- Mermaid coverage risk -> Current real render may not yet cover all syntax variants or edge cases; further UI-level verification is needed.
- SVG scope creep -> Moving beyond `.svg` reference-safe behavior could broaden security and rendering complexity quickly.
- File-link ambiguity risk -> Richer formats like `#L123` or `line:column` increase parsing complexity and false-positive risk.
- Shared surface coupling -> Centralizing chat and file-tab rendering is good for consistency, but regressions in the shared surface affect both experiences simultaneously.

## Critical Files

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/components/message-content.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/file-tabs.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/markdown-file-viewer.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/message-file-links.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/rich-markdown-surface.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
