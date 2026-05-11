# Tasks: session_epoch-reset-orphan-hotfix

## M1 — Orphan reclaim helper

- [x] M1-1 Add `reclaimOrphanAssistant({ sessionID, beforeCreatedAt }): Promise<{ reclaimed: boolean; messageID?: string; ageMs?: number }>` helper in `packages/opencode/src/session/user-message-persist.ts` (or a co-located file `orphan-reclaim.ts` imported there)
- [x] M1-2 Wire helper into `persistUserMessage` immediately after the existing `Plugin.trigger("chat.message", ...)` call and before `Session.updateMessage(input.info)`
- [x] M1-3 On reclaim success, emit `RuntimeEventService.append({ domain:"workflow", eventType:"session.orphan_assistant_reclaimed", payload:{...} })`
- [x] M1-4 Use `Session.updateMessage` (not direct SQL) to finalize the orphan, setting `time.completed=Date.now()`, `finish="error"`, `error={ name:"NamedError.Unknown", data:{ message:"abandoned_orphan_round" } }`

## M2 — RebindEpoch unexpected-reset anomaly

- [x] M2-1 Add module-level `const everBumped = new Set<string>()` in `packages/opencode/src/session/rebind-epoch.ts`
- [x] M2-2 In `bumpEpoch`, after `pruneWindow` and before rate-limit check, if `input.trigger==="daemon_start" && everBumped.has(input.sessionID) && entry.epoch===0` call `appendEventSafe({ domain:"anomaly", eventType:"session.rebind_epoch_unexpected_reset", anomalyFlags:["rebind_epoch_reset"], payload:{ trigger, reason, sessionEntryMissing:!registry.has(sid), everBumpedSize:everBumped.size } })`
- [x] M2-3 After every successful `bumpEpoch` outcome (`status==="bumped"`), `everBumped.add(input.sessionID)`
- [x] M2-4 Update `RebindEpoch.reset()` to also clear `everBumped` (test discipline)
- [x] M2-5 Update `RebindEpoch.clearSession` to also delete from `everBumped` (no orphan-key bloat post session.deleted)

## M3 — Tests

- [x] M3-1 Unit test `reclaimOrphanAssistant` — orphan present (age>=5s) → reclaimed; orphan present but fresh (age<5s) → not reclaimed; no orphan → no-op; assistant already completed → no-op
- [ ] M3-2 Integration test wiring through `persistUserMessage` — fake an orphan, persist a user msg, assert reclaim event emitted and orphan row updated
- [x] M3-3 Unit test `RebindEpoch` unexpected-reset path — bump once, simulate registry eviction via `clearSession` (BUT leave everBumped intact via internal access — or use a forced eviction test seam), bump again with `daemon_start`, assert anomaly event emitted
- [x] M3-4 Unit test `RebindEpoch` normal-path negative — first bump for a sessionID with `daemon_start` MUST NOT emit anomaly (everBumped empty for that sid)

## M4 — Validation evidence

- [x] M4-1 Run `bun test packages/opencode/src/session/user-message-persist*` and capture pass output
- [x] M4-2 Run `bun test packages/opencode/src/session/rebind-epoch*` and capture pass output
- [x] M4-3 `bun run typecheck` (or repo's equivalent) green
- [ ] M4-4 Replay docxmcp incident shape in an integration test: simulate prompt.telemetry then no round.telemetry then new user msg → orphan reclaim fires, telemetry contains both `session.orphan_assistant_reclaimed` and (separately) bump path tested
