# account

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/account/`, `packages/opencode/src/auth/`,
> `packages/opencode/src/google-binding/`, plus `daemon/opencode-gateway.c`
> for the gateway-side Google login path. Replaces the legacy spec
> packages `account-management/` and `google-auth-integration/`.

## Status

shipped (live as of 2026-05-04).

The 3-tier architecture (storage / identity service / clients) the legacy
`account-management` proposal asked for is the de-facto runtime today: the
storage layer (`Account`) refuses silent overwrites, the identity layer
(`Auth.set`) owns deduplication, and call sites (`cli/cmd/auth.ts`,
`cli/cmd/accounts.tsx`, TUI dialogs, webapp routes) all funnel through
`Auth.set` / `Auth.remove`. The split is not yet pure — `Account` still
carries provider-universe assembly (`knownFamilies`, `resolveFamily`)
and identity normalization (`normalizeIdentities`), and `Auth` still
imports `Account` rather than the other way around — but the boundary
asks of the legacy spec are honoured.

The Linux↔Google binding policy from `google-auth-integration` is also
shipped: the C gateway routes Google logins through
`/etc/opencode/google-bindings.json` and rejects unbound identities, and
the per-user daemon exposes self-service bind/unbind flow under
`/api/v2/google-binding/*`. `gauth.json` carries OAuth tokens but is no
longer treated as binding evidence.

## Current behavior

### What an "account" is

An account is one credential record bound to one provider family. The
shape is:

- `Account.ApiAccount` — `{ type: "api", name, apiKey, addedAt,
  projectId?, metadata? }`.
- `Account.SubscriptionAccount` — `{ type: "subscription", name, email?,
  refreshToken, accessToken?, expiresAt?, accountId?, projectId?,
  managedProjectId?, addedAt, metadata?, rateLimitResetTimes?,
  coolingDownUntil?, cooldownReason?, fingerprint? }`.

`Account.Info` is the discriminated union over those two. Each account
sits inside a `ProviderData = { activeAccount?, accounts: Record<id,
Info> }`. The whole storage is `Storage = { version: 2, families:
Record<providerKey, ProviderData> }` — note the on-disk key is
`families` for backward compatibility, but conceptually it is provider-
keyed (one entry per account-bearing provider boundary, e.g.
`claude-cli`, `openai`, `gemini-cli`, `google-api`, `github-copilot`).

### Storage location and migration

The single source of truth is `~/.config/opencode/accounts.json`
(`Global.Path.user`). One-time migrations honoured at load:

- Legacy `~/.opencode/accounts.json` — robust check (target missing OR
  size < 50 bytes) renames into `~/.config/opencode/accounts.json` with
  cross-device EXDEV fallback to copy+rm. Mode forced to `0600`.
- Pre-v2 `auth.json` — `Account.forceFullMigration()` reads
  `~/.local/share/opencode/auth.json`, backs it up to
  `auth.json.migrated`, and rewrites entries into `accounts.json`.
- `~/.local/share/opencode/accounts.json` (XDG shadow-write artifact)
  is no longer migrated — that path is dead since `@event_20260314`.

`opencode` and `opencode-beta` share the same primary path because both
use `const app = "opencode"` for `Global.Path.*`. Beta runs must export
`OPENCODE_DATA_HOME` (or run as a different uid) to isolate their
accounts.json from production — same-uid beta `bun test` has wiped
`accounts.json` before (2026-04-18, lost 5 codex tokens).

### Storage layer is strict (3-tier rule 1)

`Account.add(provider, accountId, info)` throws if `accounts[accountId]`
already exists for that provider —
`Account.add does not permit silent overwrites.` is the exact error
message. Direct callers that want upsert semantics must either go
through `Auth.set` (which handles dedup) or call
`Account.update(provider, accountId, partial)` explicitly. All mutating
operations (`add`, `update`, `remove`, `setActive`,
`deduplicateByToken`, `repairEmails`) run under the `withMutex` Promise-
chain so concurrent TUI + webapp + CLI writers in the same per-user
daemon cannot race on `accounts.json`.

State caching is mtime-based: `state()` rereads from disk if
`Bun.file(filepath).lastModified` differs from the cached `_mtime`.
External processes (admin scripts, gateway) that touch the file are
picked up automatically on the next `state()` call.

### Identity service does the deduplication (3-tier rule 2)

`Auth.set(providerId, info)` is the unified entry point. It:

1. Resolves `providerKey = Account.resolveProviderOrSelf(providerId)`.
2. For `type: "api"` — scans existing accounts and returns the existing
   account ID if any account already holds the same `apiKey`, updating
   `name`/`projectId` in place. On true new-key, generates an ID via
   `Account.generateId` and bumps a `-N` suffix while the ID collides.
3. For `type: "oauth"` — runs the unified identity resolution chain:
   `info.email` → JWT-decoded email from `info.access` →
   JWT-decoded email from `info.refresh` → `info.accountId` if it
   contains `@` → `info.username` → `sha256(baseToken).slice(0,8)` as
   ultimate fallback. Then it parses `refreshToken` for the
   `token|projectId|managedProjectId` pipe form, dedups by base token
   (re-auth with same identity updates the existing record), and on
   collision-by-email-but-different-token still updates the existing
   record (re-auth with new refresh token). Only when no match exists
   does it call `Account.add`.

Slug resolution is the unified chain `email > username > token-hash`,
never falling back to `providerId` itself. `gemini-cli` is the only
family that splits `refreshToken` into projectId/managedProjectId
parts.

`Auth.get(family, accountId?)` is the dispatch read path. It is strict
per `specs/_archive/provider-account-decoupling` DD-2/DD-8: the `family` must be
in `Account.knownFamilies()`; an unknown family throws
`UnknownFamilyError`; a family with accounts but no `activeAccount`
throws `NoActiveAccountError` (no silent first-pick). The legacy
single-arg form, `parseProvider` recovery, and string-shape inference
are removed. Empty families return `undefined` (probe-friendly).

`Auth.remove(providerId)` first tries `Account.getById(providerId)` for
exact-ID match; on miss, resolves to the family and removes that
family's `activeAccount`.

### Codex revoke-on-remove

`Account.remove(provider, accountId)` for `provider === "codex"` AND
`info.type === "subscription"` calls `logoutCodex(refreshToken,
{accountId})` from `plugin/codex-auth.ts` BEFORE deleting the local
record. `logoutCodex` is fail-closed: on revoke failure it throws and
the local account stays in place so the operator can retry. This is
the only family where remove has a network side-effect.

Codex accounts also degrade silently to free-tier when the upstream
OAuth login expires; the fix is delete + re-login (no refresh path).

### Identity normalization on load

`Account.normalizeIdentities()` (and the on-load
`normalizeFamilyKeys = normalizeProviderKeys` shim) rewrites
non-canonical family keys into their canonical form. Two recognition
paths are tried per family:

- Direct: `resolveCanonicalProviderKeyFromKnown(familyKey, known)` —
  matches exact family, `{family}-{api|subscription}-` account-ID
  prefix, or `{family}-{instanceSlug}` provider-instance prefix
  (longest-prefix wins).
- Inferred: `inferProviderKeyFromAccountIds(accounts, known)` —
  majority-vote on account-ID prefixes when the family key itself is
  unrecognized.

When the canonical key differs from the stored key, accounts are
merged into the canonical entry; collisions retain both records via
`{accountId}-migrated[-N]` rather than silently dropping data. The
report (`NormalizeIdentitiesReport`) lists `{from, to, accountCount}`
moves so admin tooling can audit changes.

`resolveFamilyFromKnown` and `parseProvider` are explicitly tagged
`@internal:migration-only` — runtime dispatch must carry `family` and
`accountId` as separate dimensions; reintroducing string-shape
recovery brings back the 2026-05-02 `CodexFamilyExhausted` bug class.

### Managed-app stripper

On every load, residual `accounts.json` entries whose key matches a
`ManagedAppRegistry` entry's `auth.providerKey` are deleted. Managed
apps (Gmail, Google Calendar) store OAuth tokens in `gauth.json`, not
`accounts.json`; if their family key leaks into `accounts.json` they
incorrectly surface as LLM providers in the Model Manager. The
stripper closes that hole on every read.

### Manual pin bypasses pre-flight cooldown

The pre-flight rotation gate at `session/processor.ts:404` only fires
for **auto-resolved** account selection. When the operator pinned an
account explicitly (`explicitAccountId`) or the session has an
execution-pinned identity (`sessionExecution`), the gate is skipped:
`sessionPinnedAccountId = explicitAccountId ?? sessionExecution`, and
the rotation branch only runs `if (!sessionPinnedAccountId && accountId)`
(L450). Stale persisted cooldowns in `rotation-state.json` therefore
cannot silently override an explicit pin — a real upstream 429 still
classifies via `RateLimitJudge` mid-stream, but the request actually
goes out first. The sibling gate in `session/llm.ts:354` shares the
same `!sessionPinnedAccountId` guard.
`packages/opencode/test/session/preflight-cooldown-guard.test.ts` is the
trip-wire regression covering this contract.

### Async deletion (no UI freeze)

The TUI dialogs (`dialog-account.tsx`, `dialog-admin.tsx`) treat
`Auth.remove` / `Account.remove` as background work — the row
disappears optimistically and disposal happens via the Bus event
listener on the backend. The freeze the legacy spec called out is
gone; remove is fast because it is synchronous local-only writes
plus an async `Bus.publish(AccountRemoved)`. Codex revoke is the one
exception that does block on a network round-trip (by design).

### No-account providers (FreeToUse)

Some providers (e.g. `ollama`) have no account dimension at all. The
webapp's `dialog-select-model.tsx` derives `selectedProviderUsesFreeToUseLabel`
from `usesFreeToUseAccountLabel(...)` and renders the middle account
column as `FreeToUse` instead of treating empty rows as a configuration
error. Submission paths pass `accountID: undefined` for these providers
rather than synthesising a placeholder account, so the runtime
account-less contract is preserved end-to-end.

### Bus events

Storage-layer mutations publish:

- `account.added` — `{ providerKey, accountId, info: sanitizeInfo(info) }`
  (sanitized; tokens stripped).
- `account.removed` — `{ providerKey, accountId }`.

Listeners include the provider registry (rebind on identity change,
cross-references `session.md` rebind narrative) and the rotation
trackers.

### Rotation, health, rate-limits, monitor

The account directory carries the runtime accountancy that picks an
account for each request:

- `account/rotation/` — health-tracker, rate-limit-tracker, account-
  selector, backoff, coalesce, error-classifier, same-provider-
  rotation guard. `Account.getNextAvailable(provider, model?)`
  composes them.
- `account/rotation3d.ts` — model-vector aware fallback selection,
  `WHAM_USAGE_FAMILIES` (`openai`, `codex`) for the wham-usage quota
  evaluator.
- `account/rate-limit-judge.ts` — `RateLimitJudge`,
  `shouldPromoteToProviderCooldown`, `getBackoffStrategy` (cockpit /
  counter / passive), `CodexFamilyExhausted` named error.
- `account/monitor.ts` — `RequestMonitor` class for per-request
  observability.
- `account/quota/` — quota hint + display + openai-specific quota
  surface.

These all read account state via `Account.list*` / `Account.getActive*`
and write back rate-limit / cooldown metadata via `Account.update`
(field-level merge, not whole-record overwrite).

### Multi-user gateway model

The C gateway (`daemon/opencode-gateway.c`, port 1080) routes incoming
HTTP into per-user daemons. PAM is the primary identity source. Each
known Linux user (system accounts: `pkcs12`, `cece`, `rooroo`, `liam`,
`yeatsluo`, `chihwei`) gets its own daemon process under
`/run/user/<uid>/`, each with its own
`~<user>/.config/opencode/accounts.json`. Per-user dirs are auto-
created on first login (no `/tmp` fallback).

Login redirect clears `localStorage` on user switch to prevent cross-
user pollution.

### Google login as compatibility path

The gateway accepts Google OAuth at `GET /auth/login/google` (redirect
to Google) and `GET /auth/google/callback` (exchange + bind lookup).
The full flow:

1. Gateway redirects to Google with `openid email profile` scopes and
   a CSRF state token.
2. Callback exchanges code → access_token, fetches `/oauth2/v2/userinfo`
   for the verified email.
3. `google_binding_lookup(google_email, ...)` reads
   `/etc/opencode/google-bindings.json` (path overridable via
   `OPENCODE_GOOGLE_BINDINGS_PATH`); if no entry, `LOGW` and reject
   with explicit "unbound identity" message — no silent fallback.
4. If the bound Linux user is missing on the host, reject with
   "bound Linux user missing".
5. Otherwise route to that user's per-user daemon exactly as PAM login
   would.

The same fail-fast behaviour applies to the legacy
`POST /auth/login/google` form-submit path. `gauth.json` is never
treated as binding proof — only `/etc/opencode/google-bindings.json`
is.

### Self-service binding (per-user daemon)

`server/routes/google-binding.ts` exposes:

- `GET /api/v2/google-binding/status` — current PAM user's binding.
- `GET /api/v2/google-binding/connect` — start Google OAuth (verify
  identity, not store tokens).
- `GET /api/v2/google-binding/callback` — exchange code, fetch
  userinfo, require `verified_email`, call `GoogleBinding.bind(email,
  username)`.
- `DELETE /api/v2/google-binding/` — `GoogleBinding.unbind(username)`.

`GoogleBinding.bind` enforces 1:1 cardinality both directions: an
email already bound or a username already bound throws explicitly
rather than silently overwriting. State token carries the username,
and the callback rejects with HTTP 403 if the session user has changed
since `connect` was issued (5-minute TTL).

### Shared Google OAuth tokens (gauth.json)

`~/.config/opencode/gauth.json` holds OAuth tokens shared across all
managed Google apps (currently Gmail, Google Calendar). It is written
by `server/routes/mcp.ts` after the token-exchange step, with merged
scopes from each installed app's manifest. Token refresh uses the
stored `refresh_token`; absence triggers `log.warn("no refresh_token in
gauth.json, cannot auto-refresh")` instead of silent failure. This file
is identity-token storage, not identity-binding storage — the two
concerns are deliberately separated per the legacy
`google-auth-integration` spec.

## Code anchors

Storage + service layer:
- `packages/opencode/src/account/index.ts` — `Account` namespace (1458
  lines). `add` at L516, `remove` at L632, `setActive` at L732,
  `getById` at L503, `generateId` at L808, `parseProvider` at L832
  (migration-only), `normalizeIdentities` at L1122,
  `forceFullMigration` at L1153, `getNextAvailable` at L1242,
  rotation passthroughs from L1242 onwards.
- `packages/opencode/src/auth/index.ts` — `Auth` namespace (395 lines).
  `get` at L94, `set` at L206, `remove` at L341, `accountToAuth` at
  L49.

Rotation / quota / monitor:
- `packages/opencode/src/account/rotation/` — selector, backoff,
  health, rate-limit, coalesce, same-provider guard.
- `packages/opencode/src/account/rotation3d.ts` — multi-axis fallback.
- `packages/opencode/src/account/rate-limit-judge.ts` —
  `RateLimitJudge` namespace, `CodexFamilyExhausted` error, backoff-
  strategy chooser.
- `packages/opencode/src/account/monitor.ts` — `RequestMonitor` class.
- `packages/opencode/src/account/quota/` — quota hint and openai
  quota wiring.

Google binding:
- `packages/opencode/src/google-binding/index.ts` — `GoogleBinding`
  namespace (`lookup`, `getByUsername`, `bind`, `unbind`, `list`),
  mtime-cached, `withMutex`-serialized writes, atomic temp+rename.
- `packages/opencode/src/server/routes/google-binding.ts` — self-
  service status / connect / callback / unbind.
- `daemon/opencode-gateway.c` — `google_binding_lookup` at L1094;
  Google OAuth redirect at L2283; callback + binding check at L2371.

Bus + call sites:
- `packages/opencode/src/bus/index.ts` — `AccountAdded` /
  `AccountRemoved` event definitions (`account.added`,
  `account.removed`).
- `packages/opencode/src/cli/cmd/auth.ts` — CLI add/remove call sites
  (all via `Auth.set`).
- `packages/opencode/src/cli/cmd/accounts.tsx` — CLI Ink-based account
  table, calls `Auth.set` (L195).
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` —
  admin TUI dialog. `Auth.set("google-api", ...)` at L2316,
  `Auth.set(props.providerId, ...)` at L2681.
- `packages/opencode/src/server/routes/account.ts` — webapp account
  routes; `Auth.remove` at L373, `Account.setActive` at L217.
- `packages/opencode/src/server/routes/mcp.ts` — managed-app OAuth
  callback writes `gauth.json` and best-effort piggybacks
  `GoogleBinding.bind`.
- `packages/opencode/src/provider/auth.ts` — provider-side `Auth.set`
  call sites (L109, L131, L146).

## Notes

### Storage path discipline

`accounts.json` lives at `~/.config/opencode/accounts.json` only. The
legacy `~/.local/share/opencode/accounts.json` path is not migrated
(it was a shadow-write artifact, not a real legacy source). Code that
needs to read account state must go through `Account.list` /
`Account.listAll` / `Account.getActive*` — not direct file reads — so
the in-process mtime cache stays coherent.

Beta workspaces share the same path because both `opencode` and
`opencode-beta` use `app = "opencode"` for `Global.Path.*`. Run beta
under `OPENCODE_DATA_HOME=...` or a separate uid to avoid the
`bun test` wipe class of incident (2026-04-18 lost 5 codex tokens).

### Incident: family normalization can lose data

Before the `mergeProviderData` collision-fallback was added,
normalization moved accounts under a canonical family key by direct
overwrite, which silently dropped accounts when both old and new keys
held an entry with the same `accountId`. The current code retains
both via `{accountId}-migrated[-N]`. Before changing this path, read
`account/index.ts` L352-L379.

### Incident: codex stale OAuth degrade

When a codex OAuth login expires upstream, the account silently
degrades to free-plan responses (no auth error, no rate-limit error).
There is no in-process refresh path. The fix is `Account.remove`
followed by re-login, which forces `logoutCodex` to revoke and the
operator to redo the OAuth flow.

### Open work

- `Account` still owns provider-universe assembly (`knownFamilies`,
  `resolveFamily`) and identity normalization. The legacy spec asked
  for a strict storage-only role; the practical reality is that those
  helpers depend on `ModelsDev` + `RUNTIME_SYNTHETIC_FAMILIES` which
  are not pure storage concerns. Keep the migration-only annotation on
  `parseProvider` / `resolveFamilyFromKnown` to prevent regression.
- Slice `account-management/slices/20260327_provider-llmgateway-bug/`
  broadened the domain into provider-registry / provider-SSOT
  territory; the surviving wiki home for that work is `provider.md`,
  not this entry.

### Related entries

- [provider.md](../provider/README.md) — the binding partner; account ↔
  provider dispatch, fingerprint-aware caching, codex-side compaction.
- [session.md](../session/README.md) — rebind on identity change (account
  switch invalidates LLM continuation; runloop reissues with new
  account headers).
- [compaction.md](../compaction/README.md) — `rebind` and
  `continuation-invalidated` observed conditions are the narrative
  anchor for account-switch driven compactions.
- [daemon.md](../daemon/README.md) — gateway-managed user dirs, per-user
  daemon lifecycle, PAM authority and the Google compatibility path.
