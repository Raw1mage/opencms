# Claude Session List

## Requirement

Provide an operator-facing Claude session list so users can monitor Claude-side session progress from OpenCode without manually browsing XDG storage paths.

## Scope In

- Discover the authoritative Claude/OpenCode session metadata source under XDG storage.
- Define a read-only listing API or existing API extension for Claude-related sessions.
- Define a UI surface that shows session identity, status/progress, last activity, and a drill-down path to the existing session detail stream.
- Preserve the existing XDG storage contract and DB-backed session API boundary.
- Revision 2026-05-05: add takeover-scale compaction and anchor support for large Claude Code native transcripts so imported sessions open with compact, LLM-usable context rather than raw transcript volume.

## Scope Out

- Mutating Claude sessions from the list view.
- Reading session files directly from the frontend.
- Adding fallback discovery from legacy project-local `.claude` folders.
- Daemon or gateway restart.
- Creating a second compaction persistence store outside the message stream.
- AI summarization during transcript discovery/listing; compaction may run only during explicit import/sync or later normal session compaction.

## Constraints

- Fail fast if the source of truth is unavailable; do not silently fall back to legacy folders.
- Reuse `Session.listGlobal`, existing session routes, and system-manager session APIs where possible.
- Do not expose secrets or raw provider credentials.
- Keep the feature read-only for MVP.
- Preserve the existing compaction single source of truth: anchors are assistant messages with `summary: true`; `MessageV2.filterCompacted` and `Memory.read` must keep working without a parallel Claude-specific anchor store.

## Revision 2026-05-05 — Takeover Compaction Anchor

Large Claude Code transcripts can contain enough user/assistant text and bounded tool evidence to overwhelm a takeover session's LLM context. The takeover adapter must therefore create or refresh a traceable anchor during import/delta sync when transcript volume crosses a threshold.

The anchor must:

- live in the normal OpenCode message stream as an assistant summary message;
- summarize the imported source line range, current task state, decisions, touched files/tools evidence, and next-action hints;
- preserve raw imported messages for UI/audit visibility while letting `filterCompacted` hide pre-anchor raw transcript from the next LLM call;
- be idempotent across delta syncs: no duplicate anchors for unchanged imported line ranges;
- never invent fallback transcript roots or hidden storage files.

## Open Questions

- Whether the UI should be a dedicated page, an Admin Panel tab, or part of the existing task/session monitor.
- Whether the filter should mean provider family `claude-cli`, legacy provider `anthropic`, or both with explicit labels.
