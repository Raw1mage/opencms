# Observability

## Events

- `file.operation.requested`: emitted before a server mutation or stream operation is attempted; includes operation kind, target class, and redacted relative paths.
- `file.operation.rejected`: emitted when validation, permission, conflict, confirmation, or boundary checks reject an operation.
- `file.operation.completed`: emitted after a successful create, rename, copy, move, recoverable delete, restore, upload, or download preparation.
- `file.explorer.selection.changed`: UI-only signal for selected-set changes that affect enabled batch actions.
- `file.popout.opened`: emitted when File Explorer, file-view, or terminal pop-out succeeds and source pane cleanup starts.

## Metrics

- Count file-operation requests by operation kind and outcome.
- Count rejection codes from `errors.md` to identify recurring UX or permission problems.
- Measure mutation latency from request received to normalized operation result returned.
- Measure tree refresh latency for affected directories after mutation success.
- Count pop-out success/failure by surface type: File Explorer, file view, terminal.

## Server Logs

- Log file-operation rejection reason with redacted source/destination path metadata.
- Log successful mutation operation type, relative source/destination paths, and byte size where applicable.
- Log destructive confirmation failures separately from execution failures.

## UI Signals

- Success toast includes operation type and affected filename/folder.
- Error toast maps API error into a specific user action.
- Context menu disables invalid actions where target type or clipboard state makes the operation impossible.
- Pending copy/cut state is visible enough that paste behavior is not surprising.

## Debug Checkpoints

- Boundary: file-tree row/background target -> context-menu action model.
- Boundary: UI operation request -> server file-operation payload.
- Boundary: server route validates source, destination, name, conflict, and confirmation fields.
- Boundary: File module mutates or streams bytes and returns relative result paths.
- Boundary: File context refreshes affected directories and reconciles open tabs/tree state.
