# Handoff: provider/codex-installation-id

## Execution Contract

Restore the single per-install client identity that upstream codex CLI sends in every Responses request body's `client_metadata["x-codex-installation-id"]`. **Do not change wire shape elsewhere** — the existing plumbing (`buildClientMetadata`, `buildResponsesApiRequest`) is correct; the only gap is the value being `undefined`. **Do not add HTTP headers** for the normal streaming path (upstream doesn't). **Do not store installation_id inside `accounts.json`** — per-install file is the only correct location (DD-1, DD-2).

Stages run in order M1 → M2 → M3 → M4; M5 (sibling-spec sync) and M6 (operator notes) can land alongside M2 or after M4.

## Required Reads

### Source artifacts (this plan)
- [proposal.md](proposal.md) — Why / Effective Requirement / Scope
- [spec.md](spec.md) — Requirements + Acceptance Checks
- [design.md](design.md) — Architecture / DD-1..DD-5 / Critical Files / Risks / Trade-offs
- [tasks.md](tasks.md) — M1..M6 work items
- [c4.json](c4.json) / [sequence.json](sequence.json) / [data-schema.json](data-schema.json) / [idef0.json](idef0.json) / [grafcet.json](grafcet.json) / [errors.md](errors.md) / [observability.md](observability.md) / [test-vectors.json](test-vectors.json)

### Upstream reference (alignment source)
- [refs/codex/codex-rs/core/src/installation_id.rs](refs/codex/codex-rs/core/src/installation_id.rs) — resolver semantics to mirror (read-or-create, file lock, 0644, v4 UUID).
- [refs/codex/codex-rs/core/src/client.rs:758](refs/codex/codex-rs/core/src/client.rs#L758) — `build_responses_request.client_metadata` proof that the field rides in body, not header, on the streaming path.
- [refs/codex/codex-rs/core/src/client.rs:487-498](refs/codex/codex-rs/core/src/client.rs#L487-L498) — `Compact` sub-request — the ONE place upstream uses the HTTP-header form; do not generalise this to the streaming path.
- [refs/codex/codex-rs/codex-api/src/endpoint/responses.rs:70-100](refs/codex/codex-rs/codex-api/src/endpoint/responses.rs#L70-L100) — streaming HTTP responses caller; confirms `extra_headers` does not carry installation-id.

### Local code (to touch or to verify)
- [packages/opencode/src/plugin/codex-auth.ts](packages/opencode/src/plugin/codex-auth.ts) — bootstrap + getModel sink (line ~315).
- [packages/opencode-codex-provider/src/headers.ts](packages/opencode-codex-provider/src/headers.ts) — `buildClientMetadata` at line ~108 (verify only).
- [packages/opencode-codex-provider/src/provider.ts](packages/opencode-codex-provider/src/provider.ts) — `buildResponsesApiRequest` at line ~82 (verify only).
- [packages/opencode-codex-provider/src/transport-ws.ts](packages/opencode-codex-provider/src/transport-ws.ts) — WS first-frame carries body (verify only).
- **NEW** `packages/opencode/src/plugin/codex-installation-id.ts` — resolver module to author.

### Sibling spec
- [../provider_codex-prompt-realign/](../provider_codex-prompt-realign/) — bundle / `prompt_cache_key` / driver alignment. This spec supplies the missing identity dimension that the realign work alone couldn't fix; M5 cross-links it.

## Stop Gates In Force

- **Do not put `x-codex-installation-id` as HTTP header on the streaming turn path.** Upstream only does so for the Compact sub-request (DD-3).
- **Do not put `installationId` in `accounts.json`** (DD-1, DD-2). Per-install file only.
- **Do not silently fallback** to a transient or process-random UUID on IO error (DD-4, AGENTS.md rule 1). Refuse provider start instead.
- **Do not log the UUID value** at info-level or surface it in telemetry. Treat as identity, not analytics (M6-2).
- **Do not migrate or read from `~/.codex/installation_id`.** Operators can symlink manually; we don't auto-import (out of scope per proposal).

## Execution-Ready Checklist

- [ ] M1 resolver module authored and unit-tested (M4-1..M4-6) before wiring into auth.
- [ ] M2 auth threading lands behind a green resolver suite; verify token-refresh / rotation paths do not strip the field.
- [ ] M3 verification reads confirm the field reaches the outgoing body on both HTTP and WS transports (no provider-side code change expected).
- [ ] M4 integration tests cover two consecutive turns + account rotation + HTTP-header negative.
- [ ] M5 cross-link added to `provider_codex-prompt-realign/` so future readers find both halves of the prefix-cache RCA.
- [ ] M6 operator surface documented in the spec; no CLI / config schema change required.
- [ ] Spec-driven validation evidence captured in `events/` once tests pass; advance to `verified` then await user-triggered `plan_graduate` to `/specs/provider/codex-installation-id/`.
