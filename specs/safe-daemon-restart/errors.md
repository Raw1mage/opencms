# Error Catalogue: safe-daemon-restart

## Error Catalogue

| Code | Layer | User-visible message | Recovery |
|---|---|---|---|
| `FORBIDDEN_DAEMON_SPAWN` | system-manager MCP | "This command is forbidden — use `restart_self` tool instead." | AI retries via `restart_self` |
| `RESTART_UNAUTHORIZED` | gateway | "JWT uid does not match target daemon uid." | Re-login |
| `RESTART_NO_TARGET` | gateway | "No daemon currently tracked for this user." | Gateway treats as cold-start; proceed to spawn |
| `RESTART_ALREADY_IN_PROGRESS` | gateway | 409 Conflict; "restart already scheduled" | Wait eventId then retry if needed |
| `ORPHAN_CLEANUP_FAILED` | gateway | (log only, not user-visible) | Gateway falls back to spawn attempt; if second attempt also fails → user gets login redirect (existing behavior) |
| `RUNTIME_DIR_CREATE_FAILED` | gateway | 500 Internal; log `mkdir errno` | Operator investigates fs / permission |
| `SPAWN_LOCK_CONTENDED_AFTER_CLEANUP` | gateway | 500 Internal | Manual intervention; escalate |

## Error flow rules

- All user-visible errors carry `eventId` so they can be correlated with gateway log
- `FORBIDDEN_DAEMON_SPAWN` includes the matching denylist rule name in the error detail (for debug only, not surfaced to end user)
- Gateway log MUST NOT include the JWT raw value even on error
