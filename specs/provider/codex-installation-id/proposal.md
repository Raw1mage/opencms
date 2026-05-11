# Proposal: provider/codex-installation-id

## Why

Upstream codex CLI sends a stable per-install UUID on every Responses turn — inside the request body's `client_metadata["x-codex-installation-id"]` field. ChatGPT backend uses this as one of several client identity signals (alongside `originator`, `User-Agent`, `session_id`, `thread_id`, `x-codex-window-id`, attestation). Our codex provider **never sends this field** — the variable `installationId` is plumbed end-to-end through `codex-auth.ts → provider.ts → buildClientMetadata`, but it is always `undefined` because `~/.config/opencode/accounts.json` has no `installationId` slot and no resolver code generates one.

### Honest framing (post-reframe)

Initial framing (proposed via the byte-diff trail from a prior SSH-dropped session) was that this gap was **the** root cause of prefix-cache stuck at 4608 tokens. That framing is **wrong on time-ordering**: installation_id has been missing since the codex provider's first day, but the cache regression only appeared in the last two days. Commit `458617657` (May 11 03:44) closed the cache-4608 RCA on `provider_codex-prompt-realign/` with the actual root cause: a **server-side GPT-5.5 model regression** tracked in `openai/codex#20301` (no fix yet; workaround is switching default model to GPT-5.4).

This spec therefore stands on a narrower, time-independent justification:

- Upstream sends this field on every turn — we don't. That is a real wire-shape divergence regardless of which way it affects cache today.
- The 4608 regression chase makes it clear we cannot afford **any** non-trivial alignment gap with upstream: each one we don't close is one more confound when the next regression surfaces.
- Closing this gap is cheap (≈100 LoC + one file) and risk-low (the value is opaque to clients; we mirror upstream's resolver semantics 1:1).
- If `openai/codex#20301` is eventually fixed but cache still misbehaves on our path, having this gap closed removes one suspect from the next investigation.

So: **upstream alignment / hygiene**, **not** a cache-4608 hotfix.

## Original Requirement Wording (Baseline)

- "原版程式每回合都會打的 ID 值，我們的不會打。你只能重新去找了" (2026-05-11)
- 上 session 因 SSH 斷線遺失；逐 byte 比對新舊 context 找到的差異點。

## Requirement Revision History

- 2026-05-11: initial draft created via plan-init.ts
- 2026-05-11: scope captured after upstream/provider header re-verification

## Effective Requirement Description

1. Generate and persist a per-install UUID at first launch; reuse it forever after.
2. Inject it into every codex Responses request body's `client_metadata["x-codex-installation-id"]` field on both HTTP and WebSocket transports.
3. The id is **per-install (per-machine, per-opencode-home), NOT per-account**. All codex accounts under one opencode install share the same UUID.
4. Match upstream persistence shape closely enough that operators can swap files between `~/.codex/installation_id` and our store if needed.

## Scope

### IN
- Resolver: write `installation_id` UUID to `${OPENCODE_DATA_HOME}/codex-installation-id` (default `~/.config/opencode/codex-installation-id`), 0644, first-launch generate + idempotent re-read on subsequent calls.
- Wire path: `codex-auth.ts` reads the resolver result and passes `installationId` through `getModel(...)` credentials into `createCodex(...)`.
- Request body: `buildClientMetadata` already supports the field; verify it is now non-undefined and that `client_metadata["x-codex-installation-id"]` appears in the outgoing JSON body for both HTTP streaming and WS first-frame.
- Test: snapshot one full outgoing request body and confirm the field exists and matches the persisted UUID across two consecutive runs.

### OUT
- HTTP header `x-codex-installation-id` for the normal Responses turn path. Upstream does **not** emit it as an HTTP header on the streaming turn path (only on the Compact sub-request). We mirror that.
- Multi-machine sync of installation_id (intentionally per-install).
- Migration tool to import an existing `~/.codex/installation_id` (operators can `cp` manually if desired).
- Changing accounts.json schema for any other reason.

## Non-Goals

- Solving any other cache-realign issue (`provider_codex-prompt-realign/` continues to own bundle / prompt_cache_key / instructions alignment).
- Adding installation_id to telemetry, logs, or analytics surfaces (one consumer only: outgoing request body).
- Rotating installation_id (it is intentionally permanent per install).

## Constraints

- AGENTS.md rule 1 — no silent fallback. If the resolver cannot read or write the file, surface the IO error; do not invent a transient UUID.
- File mode 0644 to match upstream (`installation_id.rs:27`).
- Resolver must be safe under concurrent first-launches (multiple opencode processes racing the create). Upstream uses file-lock; we may use atomic write + read-after-write.
- Must not break the existing `installationId` plumbing in `codex-auth.ts:315` — only add a source of truth that was previously absent.

## What Changes

- New module: `packages/opencode/src/plugin/codex-installation-id.ts` (or co-located in `codex-auth.ts` if small enough) exposing `resolveCodexInstallationId(): Promise<string>`.
- `codex-auth.ts` boot path resolves the UUID once and threads it as `credentials.installationId` into every `getModel(...)` call.
- No change to `headers.ts` or `provider.ts` — the plumbing is already in place; only the value source is added.

## Capabilities

### New Capabilities
- Per-install stable UUID for codex provider, persisted at `${OPENCODE_DATA_HOME}/codex-installation-id`.

### Modified Capabilities
- Codex Responses request body: `client_metadata["x-codex-installation-id"]` now consistently populated on every turn instead of being absent.

## Impact

- Affected code: `packages/opencode/src/plugin/codex-auth.ts`, new resolver module, `packages/opencode-codex-provider/src/headers.ts` (verification only).
- Affected runtime: every codex turn outgoing body grows by ~50 bytes; backend prompt-cache routing should start hitting prior prefixes.
- Affected operators: a new file appears at `~/.config/opencode/codex-installation-id`; safe to delete (regenerates), safe to copy across machines if intentional.
- Affected specs: `provider_codex-prompt-realign/` should be notified (link in design.md) — this plan supplies the missing dimension that bundle/prompt_cache_key alignment alone couldn't fix.
