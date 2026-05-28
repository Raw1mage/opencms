# Event 2026-05-29 — Validation: registry contract hardening live

## Scope

Validation pass for the reframed plan (registry contract hardening).
Code shipped across Phases 2/3/4/5 — see prior event
`event_2026-05-28_scope-reframing.md` for the scope change context.

## Evidence

### Unit tests (post-rebuild)

```
$ bun test packages/opencode/test/mcp/app-store-merge.test.ts \
           packages/opencode/test/mcp/url-resolver.test.ts \
           packages/opencode/test/mcp/app-store-error.test.ts

 30 pass
 0 fail
 78 expect() calls
Ran 30 tests across 3 files. [784.00ms]
```

Coverage:

- 8 layered-merge tests (system-only / user-only / collision-runtime-override
  / collision-immutable-rejected / regression / transport-stays-system /
  multi-app / collision-only-immutable-override).
- 13 URL resolver tests (all four tokens isolated + combined, literal
  passthrough, unknown-token preservation, `${XDG_RUNTIME_DIR}` fallback,
  uid-from-process-not-env, `resolveForApp` convenience).
- 9 structured-error tests (each `cause` class + schema acceptance +
  backward-compat optional fields + cause enum coverage).

### Rebuild + restart

```
$ ./webctl.sh restart --force
[OK] Frontend built: /usr/local/share/opencode/frontend
[OK] MCP binary installed: system-manager → /usr/local/lib/opencode/mcp/system-manager
[OK] Recompiled 1 MCP binary(ies)
[OK] Restarted 1 daemon(s) via systemctl
[OK] Reload complete (prod mode)
  Version:   0.0.0-main-202605281617
  Binary:    /usr/local/bin/opencode (updated)
```

Daemon up post-restart (`server` log "global event connected" at
2026-05-29T00:18:01); no boot regression. system-manager MCP binary
recompiled, picking up the new `target` parameter and structured
error surfacing.

### docxmcp smoke (live socket)

`curl --unix-socket /home/pkcs12/projects/docxmcp/.run/docxmcp.sock http://docxmcp.local/healthz`:

```
{"ok":true,"tokens":{"active_tokens":0,"storage_bytes":0,
"ttl_seconds":3600,"size_cap_bytes":1073741824}}
```

MCP `initialize` over the same socket returned
`serverInfo.name=docxmcp v0.6.0` with the full tool-contract
instructions. The user-tier registry entry continues to point at the
live `.run/docxmcp.sock` path; under the new layered merge it would
also win against any future system-tier entry with the same id.

### Resolver behaviour for docxmcp

The user-tier docxmcp URL is literal
(`unix:///home/pkcs12/projects/docxmcp/.run/docxmcp.sock:/mcp/`); it
contains no `${...}` tokens. The `resolveRuntimeUrl()` literal-passthrough
path returns the URL unchanged (`expandedTokens.length === 0`), so
docxmcp's dial path is byte-identical to pre-change. The resolver is
exercised on every connect but does no work for this app — exactly the
forward-looking utility behaviour intended.

## Impact

- The system-wins collision bug is closed in the running daemon as of
  2026-05-29T00:17. Any future system-tier entry sharing an id with
  the user-tier entry can now be overridden for `url` / `enabled` /
  `config` per the layered contract.
- `install_mcp_app({ target: "user" })` is now live; user-tier installs
  no longer require hand-editing JSON.
- Install / persistence failures surface structured `cause` + `tier` in
  both the HTTP response body and the system-manager tool text.
- docxmcp continues to work exactly as before. No deployment changes.

## Methodology notes

- Phase 0 evidence collection should have included reading the
  downstream system's own deployment config (docxmcp's
  `docker-compose.yml` header comment). Skipping that step caused the
  initial framing to be wrong; reframing cost ≈ artifact-rewrite-only
  because the code itself was sound on its own merits.
- `feedback_compare_to_correct_upstream`: still applies — when in
  doubt about a downstream system's contract, read its own code/config
  first.

## Remaining

- Final `plan_advance` to `verified`.
- `architecture.md` MCP App Store section authored 2026-05-29 under
  `## MCP App Store (User-Installable Apps)`.
- Memory pointers (optional): record the registry contract hardening
  as a project memory if it is likely to surface in future MCP App
  installation conversations.
