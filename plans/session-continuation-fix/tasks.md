# Tasks

## 1. Orphan Task Recovery

- [x] 1.1 Add `scanOrphanToolParts()` function in `task.ts`: query all sessions, find ToolParts with `status: "running"` and `tool: "task"`, verify no live worker owns them
- [x] 1.2 Add `TaskWorkerEvent.OrphanRecovered` Bus event for UI notification
- [x] 1.3 Wire orphan scan into `InstanceBootstrap()` completion callback (async, non-blocking, 5-second delay to avoid race with in-flight workers finishing)
- [x] 1.4 Orphan recovery marks ToolPart as "error" and publishes OrphanRecovered event directly in scanOrphanToolParts (atomic detection + recovery)
- [ ] 1.5 Write test: create stale ToolPart, invoke scan, verify state transition to "error"

## 2. Session Version Guard

- [x] 2.1 Add transient `_staleVersion` flag on Session.Info (not persisted, set at load time)
- [x] 2.2 In `Session.get()`: compare `info.version` vs `Installation.VERSION`, set flag and log warning if mismatch
- [x] 2.3 Add `debugCheckpoint` for version drift events (for debug.log observability)
- [ ] 2.4 Propagate `staleVersion` to UI metadata where applicable (session status display)
- [ ] 2.5 Write test: create session with mock old version, load it, verify staleVersion flag

## 3. Worker Pre-Bootstrap Observability

- [x] 3.1 In `session.ts` worker handler: add `fs.appendFileSync` logging before `bootstrap()` call, writing to `{dataDir}/log/worker-{pid}.log`
- [x] 3.2 Add timestamps for key lifecycle points: spawned, bootstrap_start, bootstrap_complete
- [x] 3.3 On successful bootstrap: truncate log to single "completed" marker to prevent accumulation
- [x] 3.4 In parent `task.ts`: when worker fails to become ready, include worker log file path in error message for diagnosis
- [ ] 3.5 Validate: kill worker during bootstrap, verify log file contains pre-bootstrap entries

## 4. Tool Input Normalization

- [x] 4.1 Add `normalizeToolCallInput()` function in `message-v2.ts` with `TOOL_PARAM_MIGRATIONS` table
- [x] 4.2 Implement migration-table-driven normalization: detect missing canonical params, remap from known old names
- [x] 4.3 Add apply_patch-specific migration rule: `patchText` → `input` (codex-rs canonical name)
- [x] 4.4 Wire normalization into `toModelMessages()` at all 3 sites where `part.state.input` is emitted to LLM context
- [x] 4.5 Ensure normalization is read-only: original stored ToolPart.input is never modified
- [ ] 4.6 Write test: create ToolPart with old format, normalize, verify canonical format output

## 5. Execution Identity Validation

- [x] 5.1 Use existing `Account.list(family)` to check if pinned accountId exists in provider's account records
- [x] 5.2 In `processor.ts` account resolution: before using `execution.accountId`, verify account exists
- [x] 5.3 On validation failure: log warning, fall back to current active account for same provider
- [x] 5.4 Fallback guard: `sessionExecution = undefined` clears stale ID, global-active fallback is the terminal case (no recursion)
- [ ] 5.5 Write test: pin session to nonexistent account, resume session, verify graceful fallback
