# Design: provider/codex-installation-id

## Context

Upstream codex CLI maintains a per-install UUID file (`$CODEX_HOME/installation_id`) via `codex-rs/core/src/installation_id.rs::resolve_installation_id`. The value is loaded once into `ModelClientSession.state.installation_id` and attached to every Responses turn's request body inside `client_metadata`. Our codex provider plumbs an `installationId` field end-to-end through `codex-auth.ts → provider.ts → buildClientMetadata`, but the value is always `undefined` — no resolver exists and `accounts.json` has no slot for it. So every outgoing request body is missing the field that upstream consistently emits.

### Why this matters even though it isn't the cache-4608 root cause

`provider_codex-prompt-realign/` closed the cache-4608 RCA on May 11 (commit `458617657`): the actual root cause is a **server-side GPT-5.5 model regression** (`openai/codex#20301`, no fix yet; workaround = use GPT-5.4). installation_id has been missing since day one of the codex provider, so it cannot be the cause of a regression that surfaced two days ago.

The justification for this spec is upstream-alignment / hygiene, not RCA:

- Wire-shape divergence with upstream is a confound during every future regression chase. The 4608 hunt cost days because there were multiple plausible drift points.
- Each gap we close shrinks the suspect set for next time.
- This particular gap is cheap to close (≈100 LoC + one file) and low-risk (the value is opaque to clients; we mirror upstream resolver semantics 1:1).

## Goals / Non-Goals

### Goals
- Persist a single per-install UUID at `${OPENCODE_DATA_HOME}/codex-installation-id` (mode 0644).
- Resolve it once per process at codex auth bootstrap; cache in scope for the lifetime of the process.
- Thread it through the existing `credentials.installationId` plumbing into every `getModel(...)` call regardless of active OAuth account.
- Emit `body.client_metadata["x-codex-installation-id"] = <UUID>` on every Responses turn (HTTP streaming and WebSocket transports).
- Fail loud on resolver IO error; do not mint a transient fallback UUID.

### Non-Goals
- No HTTP header emission of `x-codex-installation-id` on the normal Responses turn path (upstream does not, except on Compact sub-requests). Stay byte-aligned with upstream.
- No migration tool to import `~/.codex/installation_id`. Operators may symlink or `cp` manually if they want to align with upstream codex CLI on the same machine.
- No persistence of installationId inside `accounts.json` (per-account would diverge from upstream identity semantics).
- No rotation, no telemetry surfacing — single consumer is the outgoing request body.

## Architecture

```
First launch (no file)             Subsequent launches
───────────────                    ───────────────────
codex-auth bootstrap               codex-auth bootstrap
  └─ resolveCodexInstallationId()    └─ resolveCodexInstallationId()
       ├─ open file (create)              ├─ open file
       ├─ acquire lock                    ├─ read contents
       ├─ generate uuid v4                ├─ parse as UUID
       ├─ write + fsync                   └─ return existing UUID
       ├─ chmod 0644
       └─ return UUID
            │
            ▼
authWithAccount.installationId ◄── stored once per-process
            │
            ▼ (every getModel call)
createCodex({ ..., installationId })
            │
            ▼
provider.ts buildResponsesApiRequest
            │
            ▼
buildClientMetadata({ installationId })
            │
            ▼
body.client_metadata["x-codex-installation-id"] = <uuid>   ← every turn
            │
            ▼
ChatGPT backend sees stable client identity → prefix-cache routes by lineage
```

The resolver is called **once per opencode process** at codex-auth bootstrap. The resulting UUID is held in memory and threaded through `credentials.installationId` for every `getModel()` call regardless of account. Token-refresh / account-rotation paths do not touch installationId — it is orthogonal to OAuth state.

## Risks / Trade-offs

- **Concurrent first-launch race.** Two opencode processes started simultaneously may both observe the file missing and both generate UUIDs. Mitigation: advisory file lock during read-modify-write; second process re-reads after acquiring the lock and finds the first writer's UUID. If file-lock is unavailable on a platform, fall back to atomic create-exclusive (`O_CREAT | O_EXCL`) + read-after-write; the loser of the race reads the winner's value.
- **OPENCODE_DATA_HOME drift.** Beta installs use `OPENCODE_DATA_HOME` isolation. That is the desired behaviour — beta gets its own installation_id, same as upstream's per-`$CODEX_HOME` model.
- **Operator file deletion.** Deleting the file regenerates a fresh UUID on next launch and invalidates backend cache lineage. Document as a known operator-visible consequence.
- **No silent fallback.** If write fails (read-only home, disk full), bubble the error up through codex-auth bootstrap and refuse to start the codex provider. AGENTS.md rule 1.
- **Trade-off: separate file vs accounts.json embedding.** Separate file mirrors upstream and avoids per-account duplication accidents; cost is one extra file under data home. Accepted.
- **Trade-off: per-install vs per-machine vs per-account.** Per-install (one per OPENCODE_DATA_HOME) matches upstream and survives beta isolation. Per-account would re-introduce anonymous-client miss on every account switch. Rejected.

## Critical Files

- `packages/opencode/src/plugin/codex-auth.ts` (line ~315) — sink that currently receives undefined. Will receive resolved UUID after fix.
- `packages/opencode-codex-provider/src/headers.ts` (line ~108, `buildClientMetadata`) — already keys `x-codex-installation-id` when installationId is truthy. Verification target only; no code change here.
- `packages/opencode-codex-provider/src/provider.ts` (line ~82, `buildResponsesApiRequest`) — entry of installationId into outgoing body. Verification target only.
- **NEW** `packages/opencode/src/plugin/codex-installation-id.ts` — resolver module hosting `resolveCodexInstallationId()`.
- `refs/codex/codex-rs/core/src/installation_id.rs` — upstream reference implementation; mirror semantics (read-or-create, 0644, lock-safe, deterministic UUID per install).
- `refs/codex/codex-rs/core/src/client.rs` (line ~758) — upstream proof that `client_metadata` is the per-turn carrier for `x-codex-installation-id`, not an HTTP header on the streaming path.

## Decisions

<!-- DD entries appended via spec_record_decision -->
- **DD-1**: installation_id is per-install, not per-account. One UUID shared by all codex accounts under one opencode install. Why: upstream `codex-rs/core/src/installation_id.rs::resolve_installation_id` reads/writes a single `$CODEX_HOME/installation_id` regardless of which OAuth account is active; the value travels through `ModelClientSession.state.installation_id` (one per process) into `client_metadata` on every Responses request. Per-account storage would diverge from upstream identity semantics and re-introduce the anonymous-client miss whenever the user switches accounts mid-session.
- **DD-2**: Persist the UUID at `${OPENCODE_DATA_HOME}/codex-installation-id` (default `~/.config/opencode/codex-installation-id`), mode 0644, in a dedicated file — NOT inside accounts.json. Why: accounts.json is per-account state; embedding a per-install constant there invites per-account duplication on every account add. A dedicated file mirrors upstream's `~/.codex/installation_id` and lets operators `cp` between machines or align with upstream codex CLI without editing a structured config.
- **DD-3**: Inject only into request body `client_metadata["x-codex-installation-id"]`; do NOT add an HTTP header for the normal Responses turn path. Why: upstream `client.rs::build_responses_options` does not emit `x-codex-installation-id` as an HTTP header on the streaming turn path; the header form appears only on Compact sub-requests (`client.rs:489`). Adding the header on normal turns would diverge from upstream wire shape and risk a fresh anti-abuse signal. Existing `buildClientMetadata()` already targets the correct location; the only gap is the value being undefined.
- **DD-4**: Resolver fails loud on IO error (AGENTS.md rule 1, no silent fallback). If the file cannot be read or written (permission denied, disk full, parent missing), surface the error to codex auth bootstrap and refuse to start the codex provider. Do NOT mint a transient per-process UUID as fallback — that would silently reintroduce the original bug while appearing to work, exactly the failure mode AGENTS.md exists to prevent.
- **DD-5**: Resolver runs once per opencode process at codex-auth bootstrap and caches the UUID in process scope; getModel / token refresh / account rotation paths read from the cache. Why: upstream loads installation_id once into `ModelClientSession.state.installation_id`; per-call resolution would duplicate filesystem reads and create a window where a corrupted file could change identity mid-session. Process-scoped cache is the minimum behaviour to keep identity stable across rotations.

## Code anchors

<!-- entries appended via spec_add_code_anchor -->
- `packages/opencode/src/plugin/codex-auth.ts:315` — `getModel.installationId` — Current sink — receives undefined today; will receive resolved per-install UUID after fix.
- `packages/opencode-codex-provider/src/headers.ts:108` — `buildClientMetadata` — Builds body.client_metadata; already keys x-codex-installation-id when installationId is truthy. No code change needed; verification target only.
- `packages/opencode-codex-provider/src/provider.ts:82` — `buildResponsesApiRequest.client_metadata` — Where installationId enters the outgoing body. After fix, body.client_metadata must contain x-codex-installation-id on every turn.
- `refs/codex/codex-rs/core/src/installation_id.rs` — `resolve_installation_id` — Upstream reference implementation. Mirror behaviour: open with read+write+create, file lock, read existing UUID or generate v4, write+fsync, 0644.
- `refs/codex/codex-rs/core/src/client.rs:758` — `build_responses_request.client_metadata` — Upstream proof point — body.client_metadata is the per-turn carrier for x-codex-installation-id on the normal Responses streaming path, NOT an HTTP header.

## Submodule references

- `refs/codex` — upstream behaviour reference (read-only; do not modify).

## Testing

- Unit: resolver returns same UUID across two calls on a populated directory; generates and persists when file missing; rejects and rewrites when contents are non-UUID; sets mode 0644 on POSIX; surfaces IO error without fallback.
- Integration: spin two consecutive codex turns, capture outgoing JSON body, assert `body.client_metadata["x-codex-installation-id"]` equals persisted UUID on both turns; also verify cross-account-switch keeps the field stable.
- Manual: after applying, observe whether the prefix-cache miss at 4608 resolves on a long session. Subjective signal — depends on backend behaviour we cannot directly inspect; the structural fix is independent of the cache outcome.
