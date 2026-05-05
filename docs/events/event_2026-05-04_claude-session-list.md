# Event: Claude Session List

## Requirement

User wants a Claude session list to monitor the development/progress of Claude-side sessions from OpenCode.

## Scope

### In

- Plan a read-only operator-facing Claude session list.
- Reuse authoritative XDG/daemon session storage boundaries.
- Avoid direct frontend filesystem scans and legacy `.claude` fallback.
- Revision 2026-05-04: add deterministic Claude Code native transcript import/delta sync so project-sidebar Claude rows can be opened as OpenCode takeover sessions.

### Out

- Session mutation controls.
- Daemon/gateway restart.
- Legacy project-local `.claude` discovery fallback.
- AI-generated summarization of Claude transcript content.
- Full Claude runtime replay or full tool-result preservation.

## Task List

- `plans/20260504_claude_session_list/tasks.md` 1.1-5.6.

## Key Decisions

- MVP should be read-only and API-backed.
- Classification must be explicit; no silent fallback to legacy Claude folders.
- Preferred MVP API shape: extend `GET /api/v2/session` with an explicit Claude/provider-family filter while preserving `Session.Info[]` response compatibility.
- Superseded UI decision: the earlier Admin Panel / settings dialog tab was removed after the user clarified the desired placement.
- Current UI decision: each project/workspace sidebar session list has an OpenCode / Claude tab switch; Claude tab is scoped by `directory` so each project only sees its own Claude sessions.
- Implemented filter contract: `providerFamily=claude` includes only sessions with explicit `execution.providerId` of `claude-cli` or `anthropic`, or `execution.modelID` starting with `claude-` / containing `/claude-`.
- Handoff semantics: Claude rows reuse the normal sidebar `SessionItem` link to `/<base64(directory)>/session/<id>`, so selecting one opens it through the OpenCode session route for takeover instead of introducing a separate viewer.
- Revised handoff semantics: Claude native rows must first run deterministic import/delta sync, then navigate to the mapped OpenCode session. The normalizer preserves user/assistant text order, converts tool noise into bounded evidence, and fails fast on unsupported block types.
- Storage authority for imported sessions: use `Session.createNext`, `Session.updateMessage`, and `Session.updatePart`; do not write directly to SQLite, legacy message directories, or `StorageRouter` from the import layer.
- New-content indicator: Claude native rows expose `currentLineCount`, `importedLineCount`, and deterministic `hasNewContent`; the sidebar shows a small green dot only when the transcript has lines beyond the last successful import.
- UI refinement: Claude native rows do not expose an `Import` / `Sync` action label. Selecting the session row itself runs the deterministic import/delta sync and opens the mapped OpenCode session; a spinner is shown only while that row is opening.
- Blank-open fix: imported Claude transcript text must render as normal conversation content, not runtime-only synthetic text.
- Cross-session contamination fix: session-scoped live events must never be broadcast to every workspace store when the SSE directory key cannot be matched exactly.
- Takeover compaction revision: large Claude native transcripts need import-time anchor support so takeover opens with a compact LLM-visible context while raw messages remain visible for UI/audit.

## Debug Checkpoints

- Baseline: existing session storage is XDG-backed; architecture notes mention DB-backed session/dialog tools via daemon session API.
- Instrumentation plan: inspect session list route, session storage router, provider/model metadata fields, and sidebar session list surfaces before implementation.
- Execution: inspected `packages/opencode/src/server/routes/session.ts`, `packages/opencode/src/session/index.ts`, `packages/app/src/pages/layout/sidebar-workspace.tsx`, `packages/app/src/pages/layout/sidebar-items.tsx`, `packages/app/src/components/dialog-settings.tsx`, and `packages/app/src/context/global-sync/session-load.ts`.
- Evidence: `Session.Info` already stores `execution.providerId`, `execution.modelID`, `execution.accountId`, `workflow`, `stats`, and timestamps; `Session.listGlobal` reads through `Storage` and enriches project metadata; `/api/v2/session` already delegates to per-user daemon when configured.
- Root cause/opportunity: no new storage source is needed; the missing feature is a filtered monitoring projection over the existing authoritative session list.
- Implementation: extended `Session.listGlobal` and `GET /api/v2/session` query validation with `providerFamily=claude`, forwarded the query through per-user daemon routing, and added a project-scoped Claude tab to the sidebar workspace session list. The Claude tab calls `/api/v2/session?directory=<project>&roots=true&providerFamily=claude&limit=100` and reuses normal session navigation for takeover.
- Revision baseline: current MVP only opens OpenCode-format Claude execution sessions; it does not convert Claude Code native transcript context.
- Revision instrumentation plan: inspect Claude transcript storage candidates, existing OpenCode message schemas, `Session.createNext`, `Session.updateMessage`, `Session.updatePart`, and sidebar click routing before adding import behavior.
- Revision evidence: no project-local `.claude` / `.anthropic` transcript files and no common user-level Claude transcript root were present in this environment; Claude Code reference docs indicate transcript history is JSONL-backed and project-scoped. OpenCode session writes should go through the public session APIs so Bus and storage-router invariants stay intact.
- Revision root cause/opportunity: takeover requires a new deterministic adapter boundary, not a change to `providerFamily=claude` filtering. The adapter must treat missing transcript roots and unknown blocks as explicit errors rather than fallback scanning.
- Revision implementation: added `packages/opencode/src/session/claude-import.ts` as the deterministic adapter, `GET /session/import/claude` for native transcript rows, and `POST /session/import/claude` for idempotent import/delta sync. The project sidebar Claude tab now reads native rows and imports/syncs before navigating to the resulting OpenCode session.
- New-content indicator implementation: `ClaudeImport.listNative` compares current transcript JSONL line count with persisted import metadata; `packages/app/src/pages/layout/sidebar-workspace.tsx` renders a small green dot for `hasNewContent` rows.
- UI refinement implementation: renamed the frontend handler to `openClaudeSession`, removed the right-side `Import` / `Sync` / `Importing` text from Claude native rows, and kept the row click as the sole open action.
- Blank-open root cause: `ClaudeImport.importTranscript` wrote every imported transcript text part with `synthetic: true`. The session page filters user messages whose only text part is synthetic, and `message-part` renders only non-synthetic text parts. The import therefore succeeded in storage but opened as a blank conversation.
- Blank-open implementation: removed `synthetic: true` from Claude imported text parts while keeping source metadata (`sourceProvider`, `sourceSessionID`, `sourceLine`, `excludeFromModel: false`) so transcript content is visible and still traceable.
- Cross-session contamination baseline: after a Claude row import/open, the user observed unrelated drawmiat debug discussion in the Claude discussion session and another session showing this session's live thinking/status. The relevant boundary is frontend live event routing, not transcript normalization.
- Cross-session root cause: `packages/app/src/context/global-sync.tsx` delivered SSE events to an exact directory child store when possible, but fell back to broadcasting unmatched directory events to every child store. For `message.updated`, `message.part.updated`, `session.status`, `session.active-child.updated`, and related session-scoped events, that fallback can inject one session's live messages/status into unrelated workspace stores.
- Cross-session implementation: added session-scoped event detection in `global-sync.tsx`; unmatched directory events are still broadcast only for non-session-scoped workspace/system events, while session-scoped events are dropped and recovered by normal hydration instead of contaminating other sessions.
- Takeover compaction baseline: existing OpenCode compaction uses the message stream as SSOT. Anchors are assistant messages with `summary: true` and a `compaction` marker part; `MessageV2.filterCompacted` truncates at the latest compaction part; `Memory.read` derives the rolled-up memory from the latest summary anchor and post-anchor turns. Claude import previously wrote ordinary user/assistant messages and metadata only, so large transcripts remained raw LLM-visible history until normal runloop compaction happened.
- Takeover compaction implementation: Phase 6 adds deterministic import-time takeover anchors in `packages/opencode/src/session/claude-import.ts`. Large imports write a normal assistant summary message plus `compaction` marker part, store source line-range metadata for idempotency, and avoid `SessionCompaction.run` so no synthetic continue message is injected during import.

## Verification

- `packages/app` typecheck: `bun run typecheck` passed (`tsgo -b`).
- Focused session list tests: `OPENCODE_SERVER_PASSWORD= bun test --timeout 15000 packages/opencode/test/server/session-list.test.ts` passed (7 tests, 24 assertions), including `directory + providerFamily=claude` project-scoped filtering and response-shape coverage.
- Revision focused tests: `OPENCODE_SERVER_PASSWORD= bun test --timeout 15000 packages/opencode/test/server/session-list.test.ts` passed (9 tests, 35 assertions), including deterministic Claude transcript import, delta sync appending only new lines, and unsupported block fail-fast.
- New-content indicator tests: `OPENCODE_SERVER_PASSWORD= bun test --timeout 15000 packages/opencode/test/server/session-list.test.ts` passed (10 tests, 42 assertions), including green-dot state transition from no new content to new content after appending transcript lines.
- Revision frontend validation: `packages/app` `bun run typecheck` passed after wiring the native Claude transcript list and import click path.
- New-content frontend validation: `packages/app` `bun run typecheck` passed after adding the `hasNewContent` indicator field and green-dot render path.
- UI refinement validation: `packages/app` `bun run typecheck` passed after removing the explicit import label; grep confirmed no Claude-row `Import` / `Sync` / `Importing` display strings remain in `sidebar-workspace.tsx`.
- Blank-open validation: `OPENCODE_SERVER_PASSWORD= bun test --timeout 15000 packages/opencode/test/server/session-list.test.ts` passed (11 tests, 54 assertions), including a regression assertion that imported Claude text parts are not synthetic. `packages/app` `bun run typecheck` passed.
- Cross-session validation: `packages/app` `bun run typecheck` passed after routing fix. `bun test src/context/global-sync/event-reducer.test.ts` still has two pre-existing lazyload expectation failures (`4KB` expected vs current live streaming `16x` OOM cap behavior); these are unrelated to the routing change and existed after reducer guards were removed.
- Post-restart validation: after the user restarted the runtime, a new session became usable again, providing live confirmation that the frontend bundle/runtime recovered with the cross-session routing/import fixes applied.
- Takeover compaction planning validation: read `packages/opencode/src/session/compaction.ts`, `memory.ts`, `prompt.ts`, `claude-import.ts`, `message-v2.ts`, `session/index.ts`, and focused Claude import tests. Subagent exploration was attempted but failed before producing evidence due provider init failure; main-session read pass supplied the planning evidence.
- Takeover compaction implementation validation: `OPENCODE_SERVER_PASSWORD= bun test --timeout 15000 packages/opencode/test/server/session-list.test.ts` passed (12 tests, 67 assertions), covering large transcript anchor creation, no-op reimport idempotency, delta anchor refresh, and `MessageV2.filterCompacted` visibility.
- Takeover compaction artifact validation: `jq empty plans/20260504_claude_session_list/phase6_takeover_anchor_idef0.json` and `jq empty plans/20260504_claude_session_list/phase6_takeover_anchor_grafcet.json` passed; XDG whitelist backup files `accounts.json` and `AGENTS.md` were present under `~/.config/opencode.bak-20260505-claude-takeover-anchor/`.
- Baseline note: running the same focused test with the ambient `OPENCODE_SERVER_PASSWORD` set failed existing auth-guard expectations because the local in-process app returned 200 instead of the guarded 401 path; rerun with the env unset isolates the existing test contract.
- `packages/opencode` typecheck: `bun run typecheck` failed on existing baseline errors outside this slice, including `src/cli/cmd/*` arity errors, `src/server/routes/session.ts` existing line 2620/2682 diagnostics, `src/session/message-v2.ts` model field diagnostics, and `src/share/share-next.ts` attachment/file-part type diagnostics.
- Architecture Sync: Updated `specs/architecture.md` Tool Surface Runtime section to record the Claude Code native takeover adapter boundary, route contract, deterministic normalization rule, write-through-session-API storage authority, and import-time message-stream anchor extension.

## Backup

- XDG whitelist backup: `~/.config/opencode.bak-20260504-1008-claude-session-list/`.
- XDG whitelist backup for takeover anchor revision: `~/.config/opencode.bak-20260505-claude-takeover-anchor/`.
