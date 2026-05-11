# Errors: session_epoch-reset-orphan-hotfix

Failure modes the hotfix MUST handle, plus the error contracts the hotfix introduces.

## Error Catalogue

| Code | Source | Severity | Surfaced as |
|---|---|---|---|
| F-1 | `Session.updateMessage` throws while finalizing orphan | warn | log + `session.orphan_assistant_reclaim_failed` event |
| F-2 | `RuntimeEventService.append` throws on reclaim emit | warn | log only (reclaim itself already succeeded) |
| F-3 | `MessageV2.stream` errors or yields nothing | info | log + no-op (no orphan candidate) |
| F-4 | `appendEventSafe` throws on rebind anomaly emit | warn | log (existing wrap, no new handling) |

## Failure modes handled

### F-1: Session.updateMessage throws while finalizing orphan

- **Source**: SQLite write failure, Bus.publish exception, StorageRouter failure.
- **Handling**: catch inside `reclaimOrphanAssistant`; log via `log.warn` with `{ sessionID, orphanID, error }`; DO NOT throw. Falls through to existing `persistUserMessage` chain so the new user msg still gets persisted. Anomaly is implicit (assistant row stays orphan), so we also emit `session.orphan_assistant_reclaim_failed` (workflow domain, level=warn) with the error message — keeps AGENTS.md §1 satisfied.
- **Test**: M3-1 negative variant — inject thrown error from updateMessage stub, assert no propagation + failure event emitted.

### F-2: RuntimeEventService.append throws during reclaim emit

- **Source**: filesystem write failure on session_runtime_event journal.
- **Handling**: catch + `log.warn`; reclaim itself already succeeded so no rollback. Emission failure does NOT throw to caller.
- **Test**: covered by reusing existing `appendEventSafe` pattern from rebind-epoch.ts.

### F-3: MessageV2.stream throws or yields nothing

- **Source**: missing storage, race during session deletion.
- **Handling**: try/catch around the stream walk; on error, log + skip reclaim (no orphan candidate identified); falls through to existing chain. Empty stream is also a no-op (no orphan to reclaim).
- **Test**: M3-1 variant with empty stream → no reclaim, no event.

### F-4: RebindEpoch unexpected-reset detection emit throws

- **Source**: same as F-2.
- **Handling**: existing `appendEventSafe` wraps in try/catch (line 99-105 of rebind-epoch.ts). No additional handling needed.

## Error contracts introduced

### NamedError.Unknown.data.message values

- `abandoned_orphan_round` — written into reclaimed assistant `error.data.message`. Downstream code that filters errors by message text MUST treat this as a recovered state, not a user-facing failure to surface.

### RuntimeEventService anomaly flags

- `rebind_epoch_reset` — new anomaly flag string on `session.rebind_epoch_unexpected_reset`. Existing anomaly consumers (dashboard, telemetry sidebar) ignore unknown flags; no migration needed.

## What this hotfix does NOT promise to handle

- Concurrent multiple-orphan reclaim (e.g. two parallel `persistUserMessage` calls racing on the same session). Out of scope — `Session.update` and the runtime's session-singleton lock make this practically impossible in current architecture. If it surfaces, that's a separate bug.
- Reclaim of orphans older than ~24h (e.g. session resumed from disk after a process crash). The user-msg-arrival trigger is the only entry; if a session is silently abandoned, orphans persist. Acceptable — recovery happens on next interaction.
