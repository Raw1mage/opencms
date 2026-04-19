# Event: session-rebind-capability-refresh (2026-04-20)

## Context

Mandatory-skills-preload (previous spec) added runtime preload + pin for mandatory skills, but field testing revealed three independent holes that all broke the "reopen a session, see its skills" promise:

1. `InstructionPrompt.systemCache` used 10s TTL (time-based, not mtime-aware). Edits to AGENTS.md inside the 10s window were served stale.
2. Pre-loop provider switch detection in `prompt.ts:933+` only re-compacted conversation messages; it did NOT reset the capability-layer cache, so the new provider saw stale AGENTS.md.
3. UI opening an existing session did not trigger any daemon action — the `runLoop` hook only fires when a new user message arrives, so dashboards showing SkillLayerRegistry state remained empty until the user typed something.

User observation crystallized the principle:

> Conversation layer (messages / tool results / task progress) → allowed to be checkpoint-compressed.
> Capability layer (system prompt / driver / skill content / AGENTS.md / enablement) → must NEVER be frozen; refresh per rebind event, not per LLM round.

## Decisions

15 DDs locked via iterative conversation + AskUserQuestion rounds. Highlights:

- DD-1: per-session rebind epoch (no global epoch)
- DD-3 (amended): keep max 2 cache entries per session (current + previous); bump does NOT eagerly clear — reinject success prunes older, failure retains previous for R3 fallback
- DD-4: capability layer refresh **before** conversation-layer checkpoint apply
- DD-5: silent init round when session idle; busy sessions are skipped (runLoop self-heals)
- DD-6: tool call rate limit 3x per `(sessionID, messageID)`
- DD-11: bumpEpoch rate limit 5/sec/session
- DD-13: subagent completely independent epoch (no parent→child chaining)
- DD-14: skill-finder / mcp-finder install does NOT auto-bump
- DD-15: existing mandatory-skills hook becomes forwarder onto CapabilityLayer.get

## Phase Summaries

### Phase 1 — Preflight (2026-04-20)

- 1.1 XDG backup → `~/.config/opencode.bak-20260420-0239-session-rebind-capability-refresh/` (58MB; accounts.json + opencode.json + AGENTS.md verified)
- 1.2 state at `planned`
- 1.3 beta-workflow surface confirmed
- 1.4 `beta/session-rebind-capability-refresh` created from `main @ 46de62228` (0 commits ahead)

### Phase 2 — Core Modules (2026-04-20)

- 2.1 `packages/opencode/src/session/rebind-epoch.ts` — `RebindEpoch` namespace (`current` / `bumpEpoch` / `clearSession` / `stats` / `reset` + sliding-window rate-limit guard)
- 2.2 `src/session/rebind-epoch.test.ts` — 10 cases pass
- 2.3 `src/session/capability-layer.ts` — `CapabilityLayer` namespace (`get` / `reinject` / `peek` / `clearForSession` / `reset` / `listForSession`) + loader injection via `setCapabilityLayerLoader`
- 2.4 `src/session/capability-layer.test.ts` — 13 cases pass (cache hit/miss, MAX_ENTRIES=2 pruning, R3 fallback, partial bundle)
- 2.5 Wiring reconciled: DD-3 amended — bump does not eagerly clear; capability-layer natively cache-misses on new epoch; fallback preserved

### Phase 3 — Instruction Cache Refactor (2026-04-20)

- 3.1 `instruction.ts` systemCache — TTL dropped; cache key now `(directory, instructions, disableProject, sessionID, epoch)`; `system(sessionID?)` accepts optional sessionID
- 3.2 `test/session/instruction.test.ts` +5 epoch-based test cases
- 3.3 `llm.skill-layer-seam.test.ts` audited — 4/4 pass, no TTL-sensitive assertions

### Phase 4 — Runtime Wiring (2026-04-20)

- 4.1 `prompt.ts` runLoop — lazy `RebindEpoch.bumpEpoch(daemon_start)` when epoch=0
- 4.2 Pre-loop provider switch — `bumpEpoch(provider_switch)` BEFORE `compactWithSharedContext` (DD-4 order)
- 4.3 Existing mandatory-skills hook → CapabilityLayer.get forwarder (DD-15)
- 4.4 `mandatory-skills.ts` exposes `loadAndPinAll({sessionID, agent, isSubagent})` convenience
- 4.5 `test/session/capability-layer-runtime.test.ts` — 4 integration cases pass
- 4.6 `capability-layer-loader.ts` — production loader; auto-registers on first runLoop via `ensureCapabilityLoaderRegistered`

### Phase 5 — Explicit Triggers (2026-04-20)

- 5.1 `Command.reloadHandler` — `/reload` slash command handler
- 5.2 `/reload` registered via `Command.Default.RELOAD`; executor updated to pass `{sessionID}` via `HandlerContext` to all handlers
- 5.3 `src/tool/refresh-capability-layer.ts` — Tool.define with required `reason`; per-(session, messageID) counter enforces 3x limit
- 5.4 `RefreshCapabilityLayerTool` registered in `src/tool/registry.ts`
- 5.5 `command/reload.test.ts` (5 cases) + `tool/refresh-capability-layer.test.ts` (5 cases) = 10 Phase 5 unit tests

### Phase 6 — UI Silent Refresh (2026-04-20)

- 6.1 `POST /session/:id/resume` endpoint added to `src/server/routes/session.ts` — bumps epoch + silent reinject when idle; returns `busy_skipped` when busy (DD-5)
- 6.2 Zod schemas `SessionResumeRequestSchema` / `SessionResumeResponseSchema` published via OpenAPI
- 6.3 `test/server/session-resume.test.ts` — 4 integration cases pass (happy path, busy skip, rate limit, unknown sessionID)
- 6.4/6.5 **Deferred**: TUI + web frontend wiring (per-client scope; runtime + endpoint ready for UI teams to consume)
- 6.6 **Blocked** on 6.4/6.5 UI landing

### Phase 7 — Observability (2026-04-20)

`RuntimeEventService` uses open-ended `eventType: z.string()` — no type registry to update. New events (`session.rebind`, `capability_layer.refreshed`, `session.rebind_storm`, `capability_layer.refresh_failed`, `tool.refresh_loop_suspected`) are emitted inline by the new modules and flow through existing SSE / dashboard channels for free.

### Phase 8 — Architecture Sync (2026-04-20)

- `specs/architecture.md` — new section "Capability Layer vs Conversation Layer (Session Rebind Epoch)" documenting layer boundary, rebind event taxonomy, cache contract, refresh-order contract, silent-init behavior, rate limits, component list, event list
- Updated adjacent "Mandatory Skills Preload Pipeline" section references for DD-15 forwarder relationship
- `docs/events/event_20260420_session_rebind_capability_refresh.md` (this file)

## Validation

Test aggregate (across 11 files):

```
bun test src/session/rebind-epoch.test.ts                               10 pass
bun test src/session/capability-layer.test.ts                          13 pass
bun test src/session/mandatory-skills.test.ts                          24 pass
bun test src/session/skill-layer-registry.test.ts                       5 pass
bun test src/session/llm.skill-layer-seam.test.ts                       4 pass
bun test src/tool/refresh-capability-layer.test.ts                      5 pass
bun test src/command/reload.test.ts                                     5 pass
bun test test/session/instruction.test.ts                               9 pass
bun test test/session/mandatory-skills-integration.test.ts              6 pass
bun test test/session/capability-layer-runtime.test.ts                  4 pass
bun test test/server/session-resume.test.ts                             4 pass

TOTAL: 89 pass / 0 fail / 247 expect() calls
```

Manual verification (Phase 9) blocked on Phase 6.4/6.5 UI landing; runtime + endpoint + events verified via integration tests.

## Remaining

- Phase 6.4/6.5 frontend wiring — handed off to TUI + web client PRs
- Phase 9 manual dashboard verification (open existing session → 已載技能 shows pinned skill within 2s) — requires Phase 6.4/6.5
- Phase 10 cleanup: fetch-back beta → test → main; delete `beta/session-rebind-capability-refresh` branch after merge; XDG backup path `~/.config/opencode.bak-20260420-0239-session-rebind-capability-refresh/` retained for user discretion

## Commits

All beta-branch changes accumulated on `beta/session-rebind-capability-refresh` @ TBD (to be committed before fetch-back).
