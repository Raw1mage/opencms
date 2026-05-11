---
date: 2026-05-11
summary: "M1+M2 implementation landed; resolver + auth threading + 7 unit tests green"
---

# M1+M2 implementation landed; resolver + auth threading + 7 unit tests green

## What landed

- New module `packages/opencode/src/plugin/codex-installation-id.ts` exposing `resolveCodexInstallationId(): Promise<string>` and `CodexInstallationIdResolveError`.
  - Path: `Global.Path.config/codex-installation-id` (overridable for tests via `_resetForTesting({ path })`).
  - Read-or-create: read existing → validate v4 UUID → return; else generate `crypto.randomUUID()`, write atomically via `open("wx", 0o644)`, fsync, close.
  - Concurrent-launch race handled by `O_CREAT|O_EXCL` lock-substitute (`wx` flag): loser re-reads after EEXIST; if still invalid, rewrites with own UUID.
  - Memoised at module scope (DD-5).
  - Fail-loud: any non-EEXIST/ENOENT IO error wrapped in typed `CodexInstallationIdResolveError` (DD-4, AGENTS.md rule 1).

- `packages/opencode/src/plugin/codex-auth.ts` patches:
  - Import resolver.
  - Call `resolveCodexInstallationId()` once inside the auth loader (before returning credentials).
  - `getModel(...)` line 315 now passes `credentials?.installationId ?? installationId` — keeps any per-request override from callers while supplying the resolved UUID as the default. Token-refresh `authClient.auth.set` body unchanged — installationId stays out of `accounts.json` (DD-2).

- Unit tests `packages/opencode/src/plugin/codex-installation-id.test.ts` — 7 cases, all green:
  - TV1 first-launch generates valid v4 UUID, mode 0644.
  - TV2 + TV2b idempotent across calls and across pre-populated file.
  - TV3 rewrites non-UUID contents.
  - TV4 treats empty file as missing.
  - TV5 fails loud on read-only parent with `CodexInstallationIdResolveError`.
  - TV6 concurrent in-process calls converge.

## What remains

- M3 verification reads (no code change expected; trace through `buildClientMetadata` + `buildResponsesApiRequest` + WS transport).
- M4-7 / M4-8 / M4-9 integration tests (two consecutive turns, account rotation, HTTP-header negative).
- M5 sibling-spec cross-link to `provider_codex-prompt-realign/`.
- M6 operator surface notes (no CLI / config schema change).

## Risk notes

- `wx` flag (open with O_CREAT|O_EXCL) is the cross-platform lock substitute; Bun's fs/promises does not expose `flock`. The race-loss path re-reads and adopts the winner's UUID, which is the same semantics as upstream's file-lock approach for this use case.
- Test path override (`_resetForTesting({ path })`) was added because `Global.Path` is evaluated at module-load time and cannot be re-derived from a late `process.env.OPENCODE_DATA_HOME` change. Production code path (no override) reads `Global.Path.config` as designed.
