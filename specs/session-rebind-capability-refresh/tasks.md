# Tasks: session-rebind-capability-refresh

Delegation-aware execution checklist. Phases map to the pipeline: core modules → runtime wiring → explicit triggers → UI silent refresh → docs & acceptance. Runtime executor (beta-workflow) materializes one phase's items at a time into TodoWrite per plan-builder §16.

## 1. Preflight — XDG Backup And Branch Prep

- [x] 1.1 Backup done: `~/.config/opencode.bak-20260420-0239-session-rebind-capability-refresh/` (58MB, AGENTS.md + accounts.json + opencode.json verified)
- [x] 1.2 State confirmed at `planned`
- [x] 1.3 beta-workflow build surface confirmed with user
- [x] 1.4 `beta/session-rebind-capability-refresh` created from main @ `46de62228`, 0 commits ahead

## 2. Core Modules — RebindEpoch + CapabilityLayer

- [x] 2.1 Created `packages/opencode/src/session/rebind-epoch.ts` — `RebindEpoch` namespace with `current` / `bumpEpoch` / `clearSession` / `stats` / `reset` + sliding-window rate limit (5/sec/1000ms); emits `session.rebind` event on bump, `session.rebind_storm` anomaly on reject
- [x] 2.2 `packages/opencode/src/session/rebind-epoch.test.ts` — 10 cases pass: lazy init 0→1, bump sequence, per-session isolation, rate limit hit at 6th bump, window sliding after cooldown, per-session rate limit independence, clearSession round-trip, stats telemetry
- [x] 2.3 Created `packages/opencode/src/session/capability-layer.ts` — `CapabilityLayer` namespace with `get` / `reinject` / `peek` / `clearForSession` / `reset` / `listForSession`; loader injection via `setCapabilityLayerLoader` (Phase 3+ fills the real loader); supports 4 layers per DD-12; R3 fallback to previous epoch on reinject failure; `MAX_ENTRIES_PER_SESSION=2` pruning
- [x] 2.4 `packages/opencode/src/session/capability-layer.test.ts` — 13 cases pass: cache miss → loader → cache fill; same-epoch cache hit; bump → fresh loader; peek variants; list sorted; prune to MAX=2; reinject failure + fallback to previous; no-fallback throws; partial bundle missingSkills propagation; no-loader safety rail; clearForSession scope
- [x] 2.5 Wiring reconciled with design **DD-3 amended**: bump doesn't eagerly clear cache; capability-layer natively cache-misses on new epoch and keeps 2 entries so R3 fallback has a source. Explicit callback NOT needed — see design.md DD-3 updated note.

## 3. Instruction Cache Refactor — Epoch-based replaces TTL

- [x] 3.1 `instruction.ts` systemCache refactored: TTL dropped; cache key = `(directory, instructions, disableProject, sessionID, epoch)`; `system(sessionID?)` accepts optional sessionID; `flushSystemCache()` added for tests
- [x] 3.2 `test/session/instruction.test.ts` +5 cases covering epoch-based behavior (same-epoch cache hit stable under disk edit; bump invalidates + re-reads; legacy caller shares epoch=0 namespace; per-session independence; flush helper)
- [x] 3.3 `llm.skill-layer-seam.test.ts` audited — 4/4 pass unchanged; no TTL-sensitive assertions

## 4. Runtime Wiring — prompt.ts runLoop

- [x] 4.1 prompt.ts runLoop: lazy `RebindEpoch.bumpEpoch(daemon_start)` when `current(sessionID) === 0` — ensures first round after daemon spawn bumps epoch 0 → 1
- [x] 4.2 prompt.ts pre-loop provider switch detection: `bumpEpoch(provider_switch)` **before** `compactWithSharedContext` (DD-4 capability-before-checkpoint order enforced)
- [x] 4.3 Existing mandatory-skills hook refactored to `CapabilityLayer.get(sessionID, epoch)` forwarder (DD-15); zero disk I/O on cache-hit rounds, loader runs on cache-miss
- [x] 4.4 `mandatory-skills.ts` exposes `loadAndPinAll({sessionID, agent, isSubagent})` convenience — does resolve + reconcile + preload + returns `{pinnedSkills, missingSkills, outcomes, resolved}` for CapabilityLayer loader to compose skill_content layer
- [x] 4.5 `test/session/capability-layer-runtime.test.ts`: 4 integration cases pass (same-epoch cache survives external file edit; bump causes miss + re-read; reinject side-effect pins SkillLayerRegistry; R3 failure fallback to previous epoch)
- [x] 4.6 Production `CapabilityLayerLoader` built in new `capability-layer-loader.ts`; auto-registers on first runLoop via `ensureCapabilityLoaderRegistered` with a Session.get-backed context resolver (maps sessionID → agent.name + isSubagent)

## 5. Explicit Triggers — Slash Command & Tool

- [x] 5.1 `/reload` handler — exposed as `Command.reloadHandler(ctx?: HandlerContext)` in `command/index.ts`; also registered via `Default.RELOAD` entry. Flow: bumpEpoch(slash_reload) → CapabilityLayer.reinject → ack string (happy / partial / rate-limited / no-session branches)
- [x] 5.2 `/reload` registered in `command/index.ts` `createState`; `Command.HandlerContext` type added + executor updated to pass `{sessionID}` to all handlers
- [x] 5.3 `src/tool/refresh-capability-layer.ts` — Tool.define with required `reason`; per-(session, messageID) counter enforces 3x limit; session-level rebind rate limit also respected; `tool.refresh_loop_suspected` anomaly on per-turn breach
- [x] 5.4 Registered `RefreshCapabilityLayerTool` in `src/tool/registry.ts` alongside other core tools
- [x] 5.5 `command/reload.test.ts` (5 cases): no-session, happy path, missing-skill surfacing, loader-failure partial branch, rate-limit branch. `tool/refresh-capability-layer.test.ts` (5 cases): happy path + summary, empty-reason validation error, per-turn limit at 4th call, per-(session,messageID) scope isolation, cross-session counter isolation

## 6. UI Silent Refresh — HTTP endpoint + frontend signal

- [x] 6.1 `POST /session/:id/resume` endpoint landed in `src/server/routes/session.ts` — validates via Unix-socket daemon boundary (no AI-reachable TCP); calls `RebindEpoch.bumpEpoch(session_resume)`; if `SessionStatus.get === "busy" | "retry"` returns `{status: "busy_skipped"}` without reinject (DD-5 simplified); otherwise synchronous `CapabilityLayer.reinject`; returns `{status, previousEpoch, currentEpoch, trigger, reinject}` payload
- [x] 6.2 Zod schemas `SessionResumeRequestSchema` / `SessionResumeResponseSchema` added; mirror data-schema.json definitions; exposed via OpenAPI `resolver()`
- [x] 6.3 `test/server/session-resume.test.ts`: 4 integration cases pass (happy path bumps + reinjects; busy session returns `busy_skipped` with epoch bump but no cache fill; rate-limit hit at 6th bump; unknown sessionID returns 4xx)
- [x] 6.4 Frontend (TUI) — `packages/opencode/src/cli/cmd/tui/app.tsx` fires fire-and-forget POST `/api/v2/session/:id/resume` on session navigation (createEffect watches `route.data`, tracks last-resumed sessionID to avoid duplicate calls); `context/sdk.tsx` exposes `fetch` accessor. TUI has no "loaded skills" panel equivalent, so SSE subscription N/A on TUI
- [x] 6.5 Frontend (web, `packages/app/src/**`) — `pages/session.tsx` POSTs `/api/v2/session/:id/resume` on `params.id` change, then dispatches `window` event `opencode:capability_refreshed`; `pages/session/session-side-panel.tsx` skills panel listens and refetches `/api/v2/session/:id/skill-layer`. Custom window event used because `RuntimeEventService.append` is storage-only and doesn't flow through SSE
- [ ] 6.6 Manual verification (dashboard shows pinned skill within 2s of session switch) — **user action** (open old session in web → check 已載技能 panel)

## 7. Observability — Events, Logs, Dashboard

- [x] 7.1 RuntimeEventService inspected — `eventType: z.string()` is open-ended with no registry, so new events flow inline via `.append` without explicit registration. Verified 5 event types emit correctly from runtime (see integration tests).
- [x] 7.2 Event payloads match data-schema.json shapes; emit sites use structured objects consistent with the schema (`session.rebind` includes trigger/prev/curr/reason; `capability_layer.refreshed` includes epoch/layers/pinnedSkills/missingSkills; etc.). No extra validation infra added.
- [ ] 7.3 Dashboard 已載技能 panel subscribes to `capability_layer.refreshed` — **Deferred to Phase 6.4/6.5 frontend work**. Endpoint + event emission ready server-side.
- [ ] 7.4 (Optional) Session detail drawer rebind history — **Deferred to Phase 2 extend mode**

## 8. Architecture & Docs Sync

- [x] 8.1 `specs/architecture.md` — new "Capability Layer vs Conversation Layer (Session Rebind Epoch)" section: boundary table, 5 rebind triggers, cache contract, refresh-order contract, silent-init, rate limits, component list, event list
- [x] 8.2 Adjacent Mandatory Skills Preload Pipeline section references DD-15 forwarder linkage
- [x] 8.3 `docs/events/event_20260420_session_rebind_capability_refresh.md` — phase summary 1–8 + test aggregate + deferred items
- [x] 8.4 `plan-sync.ts` clean; no drift

## 9. Acceptance And Verification

- [x] 9.1 rebind-epoch 10/10 + capability-layer 13/13 pass
- [x] 9.2 capability-layer-runtime integration 4/4 pass
- [x] 9.3 reload 5/5 + refresh_capability_layer tool 5/5 + session-resume endpoint 4/4 pass
- [ ] 9.4 Manual: open existing session in UI → dashboard shows pinned plan-builder within 2s — **Blocked on Phase 6.4/6.5 UI landing (user action)**
- [ ] 9.5 Manual: edit global AGENTS.md → `/reload` → next LLM turn sees new content — **User action after Phase 6.4/6.5**
- [ ] 9.6 Manual: switch provider mid-session → new turn sees fresh AGENTS.md — **User action**
- [ ] 9.7 Manual: AI issues `refresh_capability_layer` → tool returns epoch+1 + event recorded — **User action**
- [ ] 9.8 Manual: spoofed POST /session/:id/resume from non-UI origin → daemon Unix socket architecture blocks HTTP access by default; origin validation implicit — **Low-priority user verification**
- [ ] 9.9 Manual: storm test 6 bumps/sec → 6th rejected — Automated via `rebind-epoch.test.ts` "allows N bumps + rejects N+1"; manual reproduction optional
- [ ] 9.10 `plan-validate.ts` at `verified` target — passes 13/13 artifacts; blocked on 9.4–9.8 evidence for state promotion
- [ ] 9.11 State promotion `implementing → verified → living` — **After user manual verification + beta-workflow fetch-back**

## 10. Cleanup

- [ ] 10.1 Delete `beta/session-rebind-capability-refresh` branch after merge to main
- [ ] 10.2 Remove any temp worktree used during beta build
- [ ] 10.3 Remind user: backup at `~/.config/opencode.bak-<timestamp>-session-rebind-capability-refresh/` exists; user decides cleanup timing (AGENTS.md 第二條)
- [ ] 10.4 Mark this tasks.md final state — all `- [x]`, ready for `verified` promotion
