# Errors

## Error Catalogue

| Code | Layer | Message | Recovery |
|---|---|---|---|
| `RegistryShapeError` | Provider Registry (C1.2) | `"providers[X] insertion rejected: X is not a known family. knownFamilies=[...]"` | Code bug: caller is using accountId where family expected. Fix the caller; do NOT add a shim. |
| `UnknownFamilyError` | Auth Lookup (C2.1), SDK Dispatcher (C3.1) | `"Auth.get / getSDK called with family=X which is not registered. knownFamilies=[...]"` | Same as above. Caller-side fix required. |
| `NoActiveAccountError` | Auth Lookup (C2.1) | `"family=X has no activeAccount set; pass accountId explicitly or run admin panel to pick an active account"` | Operator: pick an active account via admin panel. Caller (if AI agent): pass accountId from session-pinned identity. |
| `MigrationRequiredError` | Daemon Boot Guard (C7.1) | `".migration-state.json missing or version=Y (expected 1). Run: bun run packages/opencode/scripts/migrate-provider-account-decoupling.ts --apply"` | Operator: stop daemon; run migration script per [grafcet.json](grafcet.json) S3-S7; restart. Do NOT bypass the boot guard. |

## Error semantics

All four errors are **fail-loud, no fallback** per AGENTS.md rule 1. None of them have a "best-effort" recovery path inside the runtime — every recovery is operator-driven.

`RegistryShapeError` and `UnknownFamilyError` are nominally the same root cause (caller passing the wrong identifier shape); they are split because they fire at different boundaries:

- `RegistryShapeError` — write boundary (registry construction)
- `UnknownFamilyError` — read boundary (auth/SDK lookup)

Splitting them makes it obvious from the error itself whether the bug is in registry population code or in dispatch code.

## Removed error paths

These previously-thrown errors are GONE after this refactor:

- `CodexFamilyExhausted` (kept; emitted by rotation when codex pool is genuinely empty — but no longer mis-emitted because of [enforceCodexFamilyOnly](packages/opencode/src/account/rotation3d.ts#L830-L851) being deleted)
- Various silent-undefined returns from `Auth.get` when given an accountId form not in any family — now throws `UnknownFamilyError` instead
