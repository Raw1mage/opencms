# Proposal: session_epoch-reset-orphan-hotfix

## Why

- 2026-05-11 user-reported "input not responding" on docxmcp session `ses_1e90d1cb2ffeIFLWX3iuDsbYCl`.
- Forensic timeline (UTC):
  - 12:32:26.262 — user msg `msg_e172adf41` persisted.
  - 12:32:26.306 — assistant msg row `msg_e172adfc2` created.
  - 12:32:26.458 — `session.rebind` trigger=`daemon_start`, epoch 0→1.
  - 12:32:26.910 — `llm.prompt.telemetry` fired (prompt assembled & sent).
  - **(silent)** — no `session.round.telemetry`, assistant `time_completed` stays NULL, UI hangs in "thinking" state.
  - 12:33:20.637 — user retypes → second user msg `msg_e172bb2a0`.
  - 12:33:21.094 — `session.rebind` trigger=`daemon_start` AGAIN, epoch 0→1 (registry was reset; daemon PID 1491707 unchanged per startup log).
  - 12:33:30.134 — round.telemetry begins; second round streams normally.
- Two distinct anomalies in one event:
  1. **Stream silently exited after prompt fired** — orphan assistant row never finalized.
  2. **Lazy `daemon_start` rebind re-fired in same daemon process** — `RebindEpoch.registry` entry was evicted without `session.deleted`.

## Original Requirement Wording (Baseline)

- "剛剛發生輸入不理我的事件 ... 補plan，用hotfix修"

## Requirement Revision History

- 2026-05-11: initial draft created via plan-init.ts.
- 2026-05-11: hotfix scope locked to two minimal interventions; deeper RCA of stream silence and registry eviction explicitly out of scope (separate spec to follow once anomaly telemetry accumulates evidence).

## Effective Requirement Description

1. When a new user message is persisted on a session, any immediately-preceding assistant message in the same session whose `time_completed IS NULL` and whose `time_created` is older than a small threshold MUST be finalized with `finish="error"` and an `errorReason` of `abandoned_orphan_round`, AND a `session.orphan_assistant_reclaimed` runtime event MUST be emitted (no silent reclaim — AGENTS.md §1).
2. `RebindEpoch.bumpEpoch` MUST emit a `session.rebind_epoch_unexpected_reset` anomaly when a `daemon_start` bump fires for a sessionID this daemon process has already bumped at least once (process-lifetime `Set<sessionID>` breadcrumb). Bump behaviour itself is unchanged.

## Scope

### IN
- `packages/opencode/src/session/index.ts` (or wherever `Session.chat` persists user msgs) — orphan reclaim hook on user-msg arrival.
- `packages/opencode/src/session/rebind-epoch.ts` — process-lifetime everBumped Set + unexpected-reset anomaly emission.
- Unit tests for both behaviours.

### OUT
- Why `LLM.stream` / `processor.process` exits silently after `prompt.telemetry` without producing `round.telemetry` (separate RCA spec; needs anomaly data from this hotfix first).
- Why the `RebindEpoch.registry` entry got evicted (separate RCA; the anomaly emitted here is the breadcrumb).
- Any retry / resume of the dead round — user retype is acceptable UX for hotfix; auto-retry is a follow-up consideration.

## Non-Goals

- Fixing the underlying stream-silence root cause in this hotfix.
- Restructuring `RebindEpoch` registry to be daemon-process-durable.
- Changing UI rendering of in-progress assistant messages.

## Constraints

- AGENTS.md §1 (no silent fallback) — every reclaim and every unexpected reset MUST emit a structured event.
- Memory: "Restart Daemon Requires User Consent" — patch lands, then ask before restarting.
- Memory: beta-workflow — code changes go to a beta branch first, fetched back to main only after verification.
- Memory: "Commit All Means Split Code From Docs" — code commit and plan-doc commit must be separate.

## What Changes

- New helper `Session.reclaimOrphanAssistantBefore(sessionID, newUserMsgCreatedAt)` invoked from the user-msg persistence path.
- New runtime-event types `session.orphan_assistant_reclaimed` (workflow domain) and `session.rebind_epoch_unexpected_reset` (anomaly domain).
- `RebindEpoch` module-scope `everBumped: Set<sessionID>` populated on every successful bump; checked in `bumpEpoch` to detect unexpected reset.

## Capabilities

### New Capabilities
- **Orphan reclaim**: dead assistant rows from cancelled / silently-exited streams are auto-finalized with audit trail.
- **Rebind reset visibility**: previously-silent registry evictions surface as an anomaly event.

### Modified Capabilities
- Session.chat user-msg persistence: now also reclaims preceding orphan assistant row.
- RebindEpoch.bumpEpoch: now emits one extra anomaly event under the specific reset condition.

## Impact

- Affected code: `session/index.ts` (or equivalent), `session/rebind-epoch.ts`, runtime event consumers downstream (telemetry sidebar may render the new event types — no breaking schema change, additive only).
- No DB schema migration: uses existing `finish` and `info_extra_json` columns on `messages` table.
- Operators: new anomaly events appear in `session_runtime_event/*.json`; existing tooling that filters by domain/eventType continues to work.
