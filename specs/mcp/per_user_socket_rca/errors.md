# Errors: mcp_per_user_socket_rca

## Error Catalogue

### E1 — `mcp_app_url_unresolved`

- **Condition:** Resolver received a templated URL but could not expand a required token (e.g. `${USER}` requested while `process.env.USER` is empty and `os.userInfo()` throws).
- **Likely boundary:** `packages/opencode/src/mcp/url-resolver.ts` token expansion.
- **Recovery:** Fail fast; do not return the partially-resolved string. Log `appId`, `templatedUrl`, and the missing token. Do not invent a default for `${USER}` — that's a host configuration problem.

### E2 — `mcp_app_user_override_rejected`

- **Condition:** User-tier `mcp-apps.json` entry tries to override an immutable system field (`path`, `source`, `tools`, `settingsSchema`, `modelProcess`).
- **Likely boundary:** `McpAppStore.loadConfig()` layered merge.
- **Recovery:** Silently drop the offending field from the user-tier entry; log at debug with `appId` + field name. Merge proceeds with system value. Never raise — operator could be hand-editing JSON, must not brick boot.

### E3 — `mcp_app_install_target_invalid`

- **Condition:** `system-manager_install_mcp_app` received a `target` value other than `"system"` or `"user"`.
- **Likely boundary:** `packages/mcp/system-manager/src/index.ts` `install_mcp_app` argument validation.
- **Recovery:** Reject with structured error before touching disk; do not default-to-system silently.

### E4 — `mcp_app_install_failed` (with structured `cause`)

- **Condition:** `install_mcp_app` could not persist to the chosen tier.
- **Likely boundary:** `McpAppStore` write path; tier file open / parse / schema validation / write.
- **Recovery:** Surface `cause` exactly: `fs_permission` (no write access to chosen tier), `json_parse` (existing tier file is corrupt), `schema_validation` (new entry violates schema), `tier_conflict` (system-immutable field was supplied for user tier or vice versa). Today's path collapses every failure into generic `McpAppStoreError`; that must end.

### E5 — `mcp_app_resolver_bypassed`

- **Condition:** A consumer reads `app.url` directly without passing through `resolveRuntimeUrl()`, leading to a literal `${UID}` reaching the socket dial.
- **Likely boundary:** New consumer site added after the resolver landed; failure surfaces as ENOENT on a socket path containing `$`.
- **Recovery:** Add the new site to the resolver wiring; add a lint rule or boundary test that scans `mcp/`, `incoming/`, `server/` for direct `.url` reads in dial contexts.

### E6 — `mcp_app_stale_system_url_dialed`

- **Condition:** Daemon dials the stale system-tier URL despite the layered merge — the user-tier override was not loaded.
- **Likely boundary:** `~/.config/opencode/mcp-apps.json` missing the entry, or filesystem permissions block read.
- **Recovery:** Verify user-tier file is readable by the daemon process; user-tier entry contains the templated URL; `loadConfig()` invoked from the post-restart daemon, not a stale process. Do **not** edit `/etc/opencode/*` — fix at the user tier (DD-5).

### E7 — `mcp_app_uid_from_header`

- **Condition:** Resolver pulls uid from anything other than `process.getuid()` (e.g. a request header, env-trusted source).
- **Likely boundary:** Resolver context construction.
- **Recovery:** Hard-rule violation (INV-5). Code review must catch this; runtime test asserts uid context source via mock-uid injection that should be ignored.

### E8 — `mcp_app_xdg_runtime_dir_unset`

- **Condition:** `$XDG_RUNTIME_DIR` is empty and the resolver's fallback `/run/user/${UID}` directory does not exist (rare; non-systemd hosts).
- **Likely boundary:** Resolver fallback path.
- **Recovery:** Expand to `/run/user/${UID}` literally; if the socket itself is missing the failure surfaces at dial time (ENOENT) — that's the correct boundary for that error class. Resolver does not check filesystem existence.
