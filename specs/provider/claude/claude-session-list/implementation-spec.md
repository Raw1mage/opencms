# Implementation Spec: Claude Session List

## Goal

Add a read-only Claude session list for monitoring active and recent Claude-related sessions.

Revision 2026-05-04: extend the project-scoped Claude sidebar tab from monitoring existing OpenCode-format Claude sessions to deterministic takeover import of Claude Code native transcripts. Clicking a Claude-native row must import or delta-sync the transcript into an OpenCode session before navigating.

Revision 2026-05-05: add takeover compaction/anchor support so large imported Claude Code transcripts enter OpenCode with a compact LLM-visible context while preserving raw transcript messages for UI and audit.

## MVP Behavior

1. Backend exposes or reuses a session listing endpoint that returns session metadata from the authoritative session store.
2. The list supports filtering to Claude-related sessions using explicit provider/account/session metadata.
3. Frontend renders a monitoring list with: session id, title/summary, provider/model/account label when available, status, last activity, and a link to session detail.
4. Empty, loading, and error states are explicit.

## Data Source Rule

The session list must read through the daemon API/session storage abstraction. It must not scan `~/.local/share/opencode/storage/session` from frontend code or use `.claude` as a fallback source.

## Discovery Result

- Existing backend list route: `GET /api/v2/session` in `packages/opencode/src/server/routes/session.ts` already returns `Session.Info[]` via `Session.listGlobal(...)` and supports `directory`, `roots`, `start`, `search`, and `limit`.
- Existing session metadata shape: `Session.Info` in `packages/opencode/src/session/index.ts` includes `execution.providerId`, `execution.modelID`, `execution.accountId`, `workflow.state`, `workflow.stopReason`, `stats`, `time.updated`, `parentID`, `title`, and project metadata from `listGlobal`.
- Existing storage boundary: `Session.listGlobal` reads through `Storage.list(["session"])` / `Storage.read<Info>` and enriches project metadata; API routing may delegate to the per-user daemon through `UserDaemonManager.callSessionList`.
- Superseded frontend candidate surface: Admin Panel / `DialogSettings` was removed after user clarified the desired placement.
- Current frontend surface: `packages/app/src/pages/layout/sidebar-workspace.tsx` hosts project-scoped `OpenCode` / `Claude` tabs. The Claude tab is scoped by `directory`.
- Claude native transcript discovery: no project-local `.claude` / `.anthropic` sample exists in this repo and no common user-level Claude directory was present in the current test environment. The import implementation must therefore support the Claude Code native convention explicitly, fail fast when the transcript root/session file is absent, and avoid guessing alternate fallback roots.
- OpenCode write path for imported takeover sessions: use `Session.createNext(...)` plus `Session.updateMessage(...)` / `Session.updatePart(...)`. Do not write directly into `StorageRouter`, SQLite, or legacy message directories; those storage backends remain an internal routing detail.

## Claude Classification Rule

For MVP, classify a session as Claude-related only when its stored execution identity explicitly matches one of:

- `execution.providerId === "claude-cli"`
- `execution.providerId === "anthropic"`
- `execution.modelID` starts with `claude-` or contains `/claude-`

Each matched row should expose the matched reason as display/debug metadata. If `execution` is absent, the row is not included by the Claude filter; no title/search or `.claude` fallback is used.

## API Contract Candidate

Prefer extending `GET /api/v2/session` with an optional query parameter such as `providerFamily=claude`. The response can remain `Session.Info[]` for SDK compatibility in MVP, with the Admin Panel tab deriving display rows from existing fields. A richer `SessionMonitorRow` shape can be added later only if the UI needs computed progress fields unavailable from `Session.Info`.

## UI Placement

- Add/keep the `Claude` tab in the project/workspace sidebar session list next to `OpenCode`.
- The Claude tab lists project-scoped Claude sessions and, for Claude Code native rows, clicking performs deterministic import/delta sync before navigation.
- After import/sync, navigate to the mapped OpenCode route `/<base64(directory)>/session/<sessionID>`.
- Empty, loading, error, refresh, importing, and unsupported-transcript states must be explicit.

## Claude Native Takeover Contract

- Source root: support Claude Code native project transcripts under the explicit Claude Code project transcript convention (`~/.claude/projects/<project-key>/*.jsonl`) or an explicitly configured/import-provided transcript path. No silent fallback to repo-local `.claude`, `.anthropic`, or first-found files.
- Normalization: deterministic only. Preserve user text and assistant text blocks in order; convert tool-use/result noise into bounded evidence text. Do not call an AI summarizer.
- Unsupported blocks: fail fast with an explicit unsupported block type/path; do not silently drop unknown semantic content.
- Idempotency: persist source metadata on the imported OpenCode session/messages so repeated clicks can append only new transcript lines or return the existing mapped session when no delta exists.
- Storage authority: use OpenCode session APIs (`Session.createNext`, `Session.updateMessage`, `Session.updatePart`) so Bus events and storage router invariants remain intact.

## Claude Takeover Compaction / Anchor Contract

### Existing Evidence

- The compaction SSOT is the message stream. Anchors are assistant messages with `summary: true`.
- `MessageV2.filterCompacted(MessageV2.stream(sessionID))` truncates LLM-visible history at the latest anchor.
- `Memory.read(sessionID)` derives memory by reading the latest anchor and post-anchor finished turns; it does not read a sidecar compaction file.
- `SessionCompaction.run(...)` writes anchors through `compactWithSharedContext(...)`, but it is driven by runloop observed conditions and active model context. Claude import currently writes ordinary messages/parts only.
- Claude import metadata currently tracks source transcript line count and mapped OpenCode session ID, but not the source line range represented by the latest anchor.

### Required Behavior

1. Import/delta sync may create a takeover anchor when raw imported transcript volume crosses a configurable threshold or when the imported line range advances beyond the last takeover anchor.
2. The takeover anchor must be an ordinary assistant summary message, not a sidecar file and not a separate storage namespace.
3. The anchor text must include:
   - source provider/session/path and imported line range;
   - current user intent/task state inferred deterministically from imported text;
   - decisions and open issues if visible in transcript text;
   - bounded tool evidence summary;
   - next-action handoff hints for OpenCode takeover.
4. Raw imported user/assistant messages remain in the session for UI/audit visibility; only LLM-visible history is shortened by the latest anchor.
5. Repeated import with no new lines must not create duplicate anchors.
6. Delta import with new lines must either append raw messages only (below threshold) or append raw messages plus a new superseding anchor (above threshold / line-range advanced).

### Implementation Slices

1. Add deterministic `ClaudeImportAnchor` helpers inside `packages/opencode/src/session/claude-import.ts` or a focused sibling module.
2. Extend source metadata with latest takeover anchor line range / anchor message ID.
3. Add an import-time anchor writer using `Session.updateMessage` / `Session.updatePart` with `summary: true` and `mode: "compaction"` or an explicit takeover mode compatible with existing filters.
4. Add focused tests that verify `MessageV2.filterCompacted` returns the takeover anchor plus post-anchor delta, and that unchanged re-imports are idempotent.

### Validation Plan Addendum

- Focused server tests in `packages/opencode/test/server/session-list.test.ts` for large transcript anchor creation, idempotent no-op reimport, and delta anchor refresh.
- Direct `MessageV2.filterCompacted` assertion on the imported session to prove raw pre-anchor transcript is hidden from LLM-visible context.
- `packages/app` typecheck only if UI fields are added; backend-only slice should not require UI changes.

## Validation Plan

- Unit-test provider/session filter classification if a new classifier is added.
- API route test for list shape and Claude filter behavior if a route changes.
- Frontend typecheck/build for UI changes.
- Manual verification against existing XDG-backed sessions.

## XDG Backup

Pre-plan whitelist backup created at `~/.config/opencode.bak-20260504-1008-claude-session-list/`.

Revision 2026-05-05 whitelist backup created at `~/.config/opencode.bak-20260505-claude-takeover-anchor/`.
