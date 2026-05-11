# Errors: provider/codex-installation-id

## Error Catalogue

| Code | Title | Severity | Stage |
|---|---|---|---|
| E1 | Data home not writable on first launch | fatal | M1 / runtime |
| E2 | Data home read OK, file corrupted | warn (rewrite) | M1 / runtime |
| E3 | Concurrent first-launch UUID divergence | bug (must not happen) | M1 |
| E4 | Resolver bypassed; installationId undefined reaches buildClientMetadata | bug | M2 |
| E5 | `installationId` stripped from credentials during token refresh / rotation | bug | M2 |
| E6 | `x-codex-installation-id` emitted as HTTP header on streaming turn | bug | M3 |
| E7 | UUID value logged at info-level or surfaced in telemetry | privacy bug | M6 |
| E8 | Migration accidentally writes installationId into `accounts.json` | bug | M2 |

## Failure modes & contracts

### E1 — Data home not writable on first launch

**Symptom**: `resolveCodexInstallationId()` rejects with `EACCES` / `EROFS` / `ENOSPC` when the data home directory cannot be written.

**Contract**:
- Resolver MUST throw a typed `CodexInstallationIdResolveError` with the OS error as `cause`.
- Codex auth bootstrap MUST surface this as a startup error scoped to the codex provider; other providers MUST remain initialised.
- NO transient UUID is minted in-memory (DD-4, AGENTS.md rule 1).

### E2 — File corrupted

**Symptom**: File exists, contents are not parseable as a v4 UUID (truncated, garbage, empty).

**Contract**:
- Resolver MUST rewrite the file with a fresh v4 UUID and return the new value.
- Event MUST be recorded (`codex.installation_id.rewritten` with prior file size and reason) so operators can investigate if rewrites recur.
- This is non-fatal — backend cache lineage breaks for that install (expected consequence; documented in operator notes).

### E3 — Concurrent first-launch UUID divergence

**Symptom**: Two processes start simultaneously, both observe missing file, both generate distinct UUIDs.

**Contract**:
- Resolver MUST acquire an advisory lock (or use atomic create-exclusive) before generating.
- If lock unavailable / create-exclusive fails, re-read the file after a brief wait and adopt the winner's UUID.
- Unit test TV6 covers this.

### E4 — Resolver bypassed; installationId undefined reaches buildClientMetadata

**Symptom**: After this spec lands, `body.client_metadata` is missing `x-codex-installation-id` on some path.

**Contract**:
- Integration tests TV7 / TV10 detect this. Failure means a code path is constructing credentials without going through the cached resolver value.
- Fix: trace the offending `getModel` / direct `createCodex` site and route it through the same source.

### E5 — `installationId` stripped during token refresh / rotation

**Symptom**: First turn carries UUID; after token refresh, subsequent turns lose it.

**Contract**:
- `authClient.auth.set({ ...body })` body MUST NOT include `installationId` (per-account file is the wrong place — DD-1, DD-2).
- `credentials.installationId` MUST be re-injected by the in-memory bootstrap cache on every `getModel(...)` call, independent of `accounts.json` round-trips.

### E6 — `x-codex-installation-id` emitted as HTTP header on streaming turn

**Symptom**: Outgoing HTTP headers contain `x-codex-installation-id`.

**Contract**:
- Streaming Responses path MUST NOT emit this header (DD-3, upstream alignment).
- Header form is reserved for the Compact sub-request only (`client.rs:489`).
- Unit test TV9 enforces.

### E7 — UUID logged or surfaced in telemetry

**Symptom**: Grep of log output reveals the UUID value at info-level or in metrics dimensions.

**Contract**:
- UUID is identity, not analytics. MAY appear in debug-level structured logs scoped to the resolver module only.
- MUST NOT appear in user-facing dashboards, error messages, or third-party telemetry.

### E8 — Migration accidentally writes installationId into `accounts.json`

**Symptom**: A future PR adds `installationId` to per-account JSON schema.

**Contract**:
- Code review gate — DD-1 / DD-2 spell out the prohibition.
- If a future need to persist per-account identity arises, open a new spec rather than co-opting this one.
