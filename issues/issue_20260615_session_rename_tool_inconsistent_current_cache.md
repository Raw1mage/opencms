# BR: session rename workflow is inconsistent across current-session resolution, list/search/get metadata, and cache invalidation

Status: OPEN — contract-consistency fixes implemented + unit tests green (not yet deployed/live-verified). Remaining: live rename→get→search soak + the cross-process cache disagreement (E6/E7). See "Implementation note — 2026-06-15 (contract consistency)".

## Intake update — 2026-06-15

User reported a fresh BR: “session name功能爛掉了”. Treat this as the same active defect family unless later evidence shows a separate UI-only regression.

Initial triage checkpoint:

- Backend manual/session auto-title writes both converge on `Session.update(...)`, which publishes `session.updated`.
- Frontend session list reducer consumes `session.updated` and reconciles by `id`.
- Known problematic surface remains the tool contract/cache consistency around `system-manager_manage_session`, `get_session`, and current-session resolution.

## Symptom

Agent tried to mark a completed session with the `[✓]` title prefix, but the workflow was error-prone and required several manual recovery steps. The user correctly observed twice that the title had not changed as intended.

Expected behavior: an agent should be able to rename the currently visible/active session exactly once, then read back the same title from the same canonical source.

Actual behavior: rename surfaced multiple inconsistent semantics:

1. The agent first looked for a direct `rename_session` tool, but the exposed API is now `system-manager_manage_session({ operation: "rename" })`.
2. `manage_session({ operation: "rename", sessionID: "current" })` reported success but renamed the wrong session: `ses_146e9ad43ffeZbCTA7MTgZP8BD`, directory `/home/pkcs12/projects/opencode`, title `[✓] PatentWorks analysis specbase refactor`.
3. The user-facing/current work context was actually related to the PatentDrafter / file-move flow, not that opencode session, so `current` was not the visible/current chat the user expected.
4. `manage_session({ operation: "list" })` did not return structured session rows to the agent; it only opened the session list UI (`Opening session list UI...`). This forced the agent to guess candidate sessions via search queries.
5. `get_session({ sessionID: "current" })` is unsupported / not useful, while `manage_session(rename)` accepts `sessionID: "current"`. The meaning of `current` is therefore inconsistent across tools.
6. After finding a likely target (`ses_136e9be8cffedgqPoaxCorhtfw`, title `利善美/04智財/有新的檔案`) and running rename to `[✓] 利善美/04智財/有新的檔案`, the tool returned success:
   - `Renamed session ses_136e9be8cffedgqPoaxCorhtfw to "[✓] 利善美/04智財/有新的檔案"`
7. Immediately after that, `get_session({ sessionID: "ses_136e9be8cffedgqPoaxCorhtfw" })` still returned the old title `利善美/04智財/有新的檔案`.
8. A `manage_session({ operation: "search", query: "[✓] 利善美" })` call did return the new title for the same session ID, meaning search index and session metadata disagreed.

## User impact

- The user asked for a simple close-out marker, but the agent had to perform multiple retries and guessed searches.
- The agent accidentally renamed an unrelated session first because `current` did not map to the session the user saw.
- The final state was not confidently verifiable because `search` showed the new title while `get_session` showed the old title.
- The interaction felt unreliable: the user had to say “沒有改成功” twice.

## Evidence from observed run

| Evidence | Observation                                                                                                                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1       | `manage_session(rename, sessionID="current", title="[✓] PatentWorks analysis specbase refactor")` returned success, but affected `ses_146e9ad43ffeZbCTA7MTgZP8BD` under `/home/pkcs12/projects/opencode`, not the session the user expected. |
| E2       | `get_session(sessionID="current")` did not provide the current active session metadata, despite `current` being accepted by rename.                                                                                                          |
| E3       | `manage_session(list, limit=20)` returned only `Opening session list UI...`, not structured rows usable by the agent.                                                                                                                        |
| E4       | Candidate session had to be found by title keyword searches such as `利善美`, `PatentWorks`, `specbase`, `rPPG`, `Excel`, `打勾`.                                                                                                            |
| E5       | `manage_session(rename, sessionID="ses_136e9be8cffedgqPoaxCorhtfw", title="[✓] 利善美/04智財/有新的檔案")` returned success.                                                                                                                 |
| E6       | Immediate `get_session(ses_136e9be8cffedgqPoaxCorhtfw)` still returned title `利善美/04智財/有新的檔案`.                                                                                                                                     |
| E7       | Immediate `manage_session(search, query="[✓] 利善美")` returned title `[✓] 利善美/04智財/有新的檔案` for the same `ses_136e9be8cffedgqPoaxCorhtfw`.                                                                                          |

## Suspected failure modes

- `current` is resolved relative to daemon/root session/workspace, not the visible session tab the user is interacting with.
- `manage_session.rename`, `manage_session.search`, and `get_session` read/write different stores or different cache layers.
- Title update invalidates the search index but not the metadata path used by `get_session`, or vice versa.
- `list` is overloaded as a UI action instead of a data-returning tool operation, leaving agents without a reliable way to locate the active session.
- Tool naming/docs drifted: there is no direct `rename_session` surface, and the discoverable replacement is less obvious.

## RCA — 2026-06-15

Root cause 1: `sessionID="current"` is not the user's visible/current chat. In `packages/mcp/system-manager/src/index.ts`, `resolveSessionIDForMetadataMutation("current")` resolves by `OPENCODE_REPO_ROOT || process.cwd()`, lists root sessions for that directory, sorts by `time.updated`, and picks the newest root. That is a directory-scoped heuristic, not a UI-selected-session or serving-session authority. It can therefore rename an unrelated latest root session in the repo.

Root cause 2: tool contract inconsistency makes the heuristic hard to detect. `manage_session(rename)` accepts `sessionID="current"`, but `get_session` passes the supplied ID directly to `/session/:id` and does not resolve `current`. `manage_session(list)` is not a data operation at all; it writes `ui_trigger = "session.list"` and returns only `Opening session list UI...`. The agent therefore lacks a canonical readback/listing path for the same meaning of “current”.

Contributing factor: `PATCH /session/:id` currently calls `Session.update(..., { touch: false })` for title changes. This means successful renames do not bump `time.updated`, while the `current` resolver depends on `time.updated` to pick the target. Even when the rename write itself succeeds, the resolver's future target selection remains stale and can keep pointing at a different recently active root.

Non-root-cause / less likely: the normal backend/frontend session metadata path is not inherently broken. Backend title writes converge on `Session.update`, which publishes `session.updated`; server `SessionCache` subscribes to `Session.Event.Updated` and invalidates `session:<id>` entries; frontend `GlobalSync` handles `session.updated` by reconciling the session row by `id`. The observed inconsistency is therefore more likely a tool semantics/current-resolution bug than a missing core metadata write.

Fix direction:

1. Remove or fail-fast `sessionID="current"` for metadata mutation unless the tool receives a true active/visible session ID from runtime context.
2. If `current` remains supported, implement one shared resolver and use it in both `manage_session(rename)` and `get_session`.
3. Split `manage_session(list)` into structured data listing vs UI-open side effect.
4. Make `rename` return the post-write canonical session record from the same read path used by `get_session`.
5. Decide whether title-only rename should touch `time.updated`; if not, stop using `time.updated` as current-session selection evidence.

## Implementation note — 2026-06-15

Applied partial fix for the direct agent ergonomics failure:

- Added `rename_session` to the system-manager tool surface and built-in direct wrapper.
- `rename_session({ title })` now uses the built-in tool runtime `ctx.sessionID` as the current serving session.
- `rename_session({ sessionID, title })` still supports explicit target-session rename.
- `rename_session({ sessionID: "current", title })` is treated like omitted `sessionID` when called through the built-in opencode tool, so agents can complete the intuitive one-step call.
- `rename_session` returns canonical post-write metadata JSON after reading the session back.
- Legacy `manage_session({ operation: "rename" })` now reuses the same rename helper; when it receives `sessionID="current"` from the built-in tool, it also uses runtime `ctx.sessionID` rather than cwd/newest-root selection.

Validation: `bun test packages/mcp/system-manager/src/system-manager-session.test.ts` passed (6 tests).

## Implementation note — 2026-06-15 (contract consistency)

Closed the remaining contract gaps from "Fix direction" / "Requested improvements" (all in `packages/mcp/system-manager/src/index.ts`):

1. **Single `current` resolver (RC1 + RC2).** Extracted `resolveTargetSessionID({ sessionID, currentSessionID })` as the one source of truth: explicit ID wins; `current`/omitted/whitespace → runtime `currentSessionID` (the serving session passed by the built-in opencode tool, `ctx.sessionID`); fails fast otherwise. **Deleted the dead `resolveSessionIDForMetadataMutation`** cwd/newest-root heuristic (RC1) — it is no longer reachable, so `current` can no longer silently rename an unrelated workspace-root session.
2. **`get_session` now resolves `current`.** Schema drops `required: ["sessionID"]`, accepts `current`/omitted, and reads back via the same `GET /session/:id` path rename uses → a rename is verifiable by reading the same session. Description points at `rename_session` for the shared meaning of `current`.
3. **`manage_session(list)` returns structured rows.** Returns `{ structuredContent: { sessions: [...] } }` (id/title/directory/updated/url) plus a readable text table, while still writing `ui_trigger=session.list` so human viewers still get the UI. Agents no longer have to title-guess via `search`.
4. **`manage_session(rename)` returns the canonical post-write record** (same shape/read path as `get_session`) in both text and `structuredContent`, and always forwards `currentSessionID` so omitted-sessionID rename resolves to the serving session.

Tests: added `resolveTargetSessionID` unit cases (explicit/current/omitted/whitespace/fail-fast) + tool-surface assertions (get_session `current`, manage_session docs). `bun test packages/mcp/system-manager/` → 22 pass / 0 fail.

## Measurement probe — 2026-06-15 (E6/E7 RCA)

Added an env-gated, default-off coherence probe (`OPENCODE_SESSION_COHERENCE_PROBE=1`) in
`packages/opencode/src/server/routes/session.ts` (`coherenceProbe()`). It logs via `log.info`
with tag `[coherence-probe]`, including `pid` + `daemonMode`, on all three session paths:

- `session.update` — both `routed→per-user-daemon` and `served-in-process` (the pid that wrote
  the title and fired `Session.Event.Updated`, which only invalidates *that* pid's SessionCache).
- `session.get` — `routed→per-user-daemon` vs `served-in-process` + `cacheHit` + `version` + `title`.
- `session.list` — `routed→per-user-daemon` vs `served-in-process` + `count` + first 10 `titles`
  (storage is source of truth here, so its titles are the ground truth to compare against the
  cached single-GET title).

Topology found while wiring the probe:
- Gateway sources `/etc/opencode/opencode.env` (all SESSION_LIST/READ/MUTATION routing flags =1).
- `opencms-daemon-user@` sources `opencode.env`; `opencms-daemon-wheel@` sources `opencode.cfg`
  (which lacks the routing flags). Probe flag added to **both** files so it fires everywhere.
- `OPENCODE_TRUSTED_LOOPBACK_USER=pkcs12` → loopback MCP calls should resolve to `pkcs12` and
  forward consistently to one per-user daemon. If reads are still stale, the prime suspect is
  **duplicate per-user daemon instances** (overlaps the MCP-child duplication issue in observing/),
  which the `pid` field will confirm/refute.

### Protocol (run after a rebuild+restart picks up code + env)

1. Rebuild+restart via `restart_self` (user-initiated). Ensure the pkcs12 per-user daemon is also
   fresh (it runs `/usr/local/bin/opencode`; a stale long-lived instance keeps the OLD binary/env).
2. Reproduce: `rename_session` (or `manage_session rename`) on the current session → `get_session`
   same ID → `manage_session search` same title.
3. Collect: `grep '\[coherence-probe\]' ~/.local/share/opencode/log/debug.log` (also
   `journalctl --user -u 'opencms-daemon-user@*' -u 'opencms-daemon-wheel@*'` and the gateway unit).

### Reading the result

- **update pid == get pid**, and get `cacheHit` flips false→true with the NEW title → coherent;
  E6/E7 not reproduced (likely closed by the same-path canonical readback).
- **update pid ≠ get pid** → cross-process split confirmed. Disambiguate via `routed`/`daemonMode`:
  one path `routed→per-user-daemon` while the other `served-in-process` = gateway-vs-daemon split
  (identity/routing bug); two different `served-in-process` daemon pids = duplicate instances.
- **get `cacheHit:true` + stale title while list `titles` show NEW** → confirms a stale per-process
  SessionCache that never received the invalidation event → fix = bypass-cache for metadata (c),
  pin routing identity (a), or cross-process invalidation bridge (b).

### Still open (do NOT move to observing yet)

- **Live verification**: needs a daemon rebuild+restart (via `restart_self`, user-initiated per repo daemon-lifecycle rule), then a real rename→get_session→search readback on the same session ID to confirm immediate agreement.
- **E6/E7 cross-process cache disagreement**: `GET /session/:id` is served from `SessionCache` (invalidated on `Session.Event.Updated`); `GET /session` (list/search) reads storage directly. With the multi-daemon (`UserDaemonManager`) routing, a `Session.Event.Updated` fired in one process may not invalidate another process's `SessionCache` — the likely cause of get-stale-while-search-fresh. This is a bus-bridge/cache-coherence concern that overlaps the MCP-child duplication issue in `observing/`; tracked separately, not fixed here. The canonical-readback-from-same-path change reduces but does not prove-away the window.

## Requested improvements

1. Add a canonical `rename_current_session(title)` operation, or make `manage_session(rename, sessionID="current")` resolve to the currently visible chat session, not a workspace/root/default session.
2. Make `get_session(sessionID="current")` support exactly the same current-session resolver as rename, or reject `current` everywhere and require an explicit ID.
3. Make `manage_session(list)` return structured rows to the agent. If opening the UI is needed, split it into a separate operation such as `open_list_ui`.
4. Make `rename` return the post-write canonical session record (`id`, `title`, `directory`, `updated`) from the same read path as `get_session`.
5. Ensure title writes invalidate/synchronize every cache/index used by `search`, `list`, and `get_session` before reporting success.
6. Add an acceptance test covering rename → get_session → search consistency for the same session ID.
7. Add an acceptance test covering `current` consistency across rename/get/list or remove `current` from tool schemas where it is not reliable.

## Acceptance criteria

- Renaming a current session from an agent changes the same session visible to the user.
- `rename` success is immediately verifiable through `get_session` and `search` with identical title values.
- `list` provides structured data without relying on UI side effects.
- An agent no longer needs title-keyword guessing to find the session it is currently serving.

## Notes

This BR is not about whether `[✓]` should be applied automatically. It is about the session-management tool contract: one obvious operation should rename the intended session and all read paths should agree immediately.
