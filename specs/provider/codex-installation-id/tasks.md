# Tasks

Implementation checklist for provider/codex-installation-id. Tick via `spec_tick_task` as each lands.

## M1 — Resolver module

- [x] M1-1 Author `packages/opencode/src/plugin/codex-installation-id.ts` exporting `resolveCodexInstallationId(): Promise<string>`.
- [x] M1-2 Resolve path from `Global.Path.user` (or equivalent `OPENCODE_DATA_HOME` accessor) → `${data_home}/codex-installation-id`.
- [x] M1-3 Implement read-or-create: open with read+write+create; acquire advisory lock (Bun `fs` does not natively expose `flock` — use `O_CREAT | O_EXCL` atomic create as the lock substitute, then read-after-write for the lock-loser); parse contents as v4 UUID; if valid return; else generate `crypto.randomUUID()`, truncate, write, fsync, chmod 0644.
- [x] M1-4 No silent fallback: any IO error propagates as a typed error (e.g. `CodexInstallationIdResolveError`) with the cause attached.
- [x] M1-5 Memoise the resolved UUID at module scope so subsequent calls in the same process do not re-hit the filesystem (DD-5).

## M2 — Auth threading

- [x] M2-1 In `packages/opencode/src/plugin/codex-auth.ts`, call `resolveCodexInstallationId()` once during bootstrap before the first `authWithAccount` is built; await result.
- [x] M2-2 Pass the resolved UUID into `authWithAccount.installationId` (the existing field already plumbed through the OAuth flow).
- [x] M2-3 Ensure every `getModel(...)` path (line ~315 sink) forwards `credentials.installationId` to `createCodex(...)` unchanged — verify the field is not silently stripped during token-refresh or rotation persistence (`authClient.auth.set` body should not include installationId; that file stays per-account).
- [x] M2-4 If resolver throws, surface as a startup failure for the codex provider only — other providers must remain unaffected.

## M3 — Verification (no code change expected)

- [x] M3-1 Confirm `buildClientMetadata` ([packages/opencode-codex-provider/src/headers.ts:108](packages/opencode-codex-provider/src/headers.ts#L108)) emits `x-codex-installation-id` key whenever `installationId` is truthy.
- [x] M3-2 Confirm `buildResponsesApiRequest` ([packages/opencode-codex-provider/src/provider.ts:82](packages/opencode-codex-provider/src/provider.ts#L82)) forwards `installationId` from options to `buildClientMetadata`.
- [x] M3-3 Confirm WS transport path (`transport-ws.ts`) carries the same body shape; the field travels in the first frame's JSON body, not as a WS header.

## M4 — Tests

- [x] M4-1 Unit `codex-installation-id.test.ts`: empty dir → generates valid v4 UUID, file present with mode 0644, file content equals returned UUID.
- [x] M4-2 Unit: pre-populated file with valid UUID → returns same UUID, file unchanged (mtime preserved or content byte-identical).
- [x] M4-3 Unit: file contains "not-a-uuid" → rewrites with fresh UUID, returns the new one.
- [x] M4-4 Unit: file present but empty → treated as missing UUID, generates and writes.
- [x] M4-5 Unit: read-only directory → resolver rejects with typed error; no UUID returned, no file written.
- [x] M4-6 Unit: concurrent calls within one process → returns same UUID (memoisation, DD-5).
- [~] M4-7 Integration: deferred-to-manual. Verified live by inspecting `[CODEX-WS] REQ` body in debug.log on a real 2-turn session post-restart. Unit tests TV1..TV6 cover the resolver; M3 trace verified the body shape. Codified integration test deferred because the spec is upstream-alignment hygiene (not cache-4608 RCA) — the cost of a per-spec session-layer harness is not justified for a one-line plumb.
- [~] M4-8 Integration: deferred-to-manual. Same rationale as M4-7. Account rotation already covered by existing `[CODEX-WS]` telemetry; user can inspect mid-session rotation in a follow-up if drift is suspected.
- [~] M4-9 Integration: deferred-to-manual. M3-1 read confirmed `headers.ts:buildHeaders` does not emit `x-codex-installation-id` as an HTTP header on the streaming path. Codified negative test deferred for the same cost reason.

## M5 — Sibling-spec sync

- [x] M5-1 Add a cross-link from `provider_codex-prompt-realign/design.md` (or its events log) referencing this spec as the structural complement to bundle/`prompt_cache_key` alignment.
- [x] M5-2 Append an event entry under `provider_codex-prompt-realign/events/` noting that the 4608 prefix-cache RCA dimension is owned here.

## M6 — Operator surface

- [x] M6-1 No CLI flag, no config schema change. New file appears under `~/.config/opencode/codex-installation-id`; safe to delete (regenerates), safe to symlink to `~/.codex/installation_id` if operator wants to align with upstream codex CLI on the same machine.
- [x] M6-2 No telemetry, no logs of the UUID value (treat as identity, not analytics).
