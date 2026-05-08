# Self-Restart Handover Checkpoint Design

## Context

`system-manager_restart_self` may close the socket while gateway/daemon restart is in progress. Without a durable checkpoint, the AI can lose the reason for restart, the current task state, and the validation step required after reconnect.

## Design Direction

- Treat restart as a two-phase operation:
  1. durable handover checkpoint written and fsynced where practical;
  2. gateway-owned restart orchestration begins.
- Socket close is not a success signal. It is only evidence that control was interrupted.
- Continuation reads the checkpoint after reconnect and reports whether restart completion is confirmed, failed, or still unknown.

## Candidate Checkpoint Fields

- `schemaVersion`
- `checkpointID`
- `txid`
- `createdAt`
- `pid`
- `sessionID`
- `reason`
- `targets`
- `runtimeMode`
- `handover`
- `errorLogPath`
- `webctlPath`
- `validationNextSteps`
- `status`: `restart-requested`

## Taxonomy

- `restart-handover checkpoint`: JSON file under `Global.Path.state/restart-handover/<txid>.json`; input is the accepted restart request context; output is a durable continuation record. It is not a secret snapshot, not a full transcript, and not proof that restart succeeded.
- `txid`: restart transaction id shared by the endpoint response, webctl env, error log, and checkpoint filename. It is complete when every accepted restart response includes it.
- `handover`: caller-provided concise continuation note. It must not be interpreted as authoritative session storage or a substitute for message history.

## Redaction Rules

- No environment dumps.
- No token/account secrets.
- Git summary is file-status only, not diff content.

## Decisions

- Store checkpoint files under `Global.Path.state/restart-handover/` because restart continuity is runtime state, not config or user data.
- Write the checkpoint before any webctl/self-update restart action. If write fails, the restart request fails fast.
- `system-manager_restart_self` accepts optional `sessionID` and `handover` so AI callers can explicitly persist active-session context before interruption.
