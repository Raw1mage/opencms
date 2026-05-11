# Observability: provider/codex-installation-id

## Events

| Event | Source | When | Payload |
|---|---|---|---|
| `codex.installation_id.resolved` | codex-installation-id.ts | bootstrap, once per process | `{ source: "existing" \| "generated" \| "rewritten", file_size_before, file_size_after }` — UUID value NOT included (privacy, see errors.md E7) |
| `codex.installation_id.rewritten` | codex-installation-id.ts | corrupted file path (E2) | `{ prior_file_size, prior_first_bytes_hash, reason: "empty" \| "not_a_uuid" }` |
| `codex.installation_id.resolve_failed` | codex-installation-id.ts | IO error (E1) | `{ errno, syscall, path }` |
| `codex.client_metadata.installation_id_present` | provider.ts (test build only) | each outbound turn | `boolean` — emitted in test harness to verify TV7/TV8 |

## Metrics

| Metric | Type | Target |
|---|---|---|
| `codex.installation_id.resolver_calls_per_process` | counter | 1 per opencode process (memoised, DD-5) |
| `codex.installation_id.resolver_failures` | counter | 0 in healthy operation |
| `codex.installation_id.file_rewrites` | counter | 0 in steady state; any non-zero rate warrants investigation |
| `codex.client_metadata.installation_id_missing_in_body` | counter | 0 post-deploy on every turn |
| `codex.cache_hit_ratio` (per session, from turn 2 onward) | gauge | ≥ 0.9 — same metric as provider_codex-prompt-realign; this spec contributes one structural dimension |

## Signals

- **Cache miss stuck at 4608 tokens** — the canonical symptom this spec targets. If the metric still pins at 4608 after deploy with `installation_id_missing_in_body == 0`, the structural fix is complete and any residual cache issue belongs to a different RCA (chain reset, `prompt_cache_key`, bundle drift — see provider_codex-prompt-realign).
- **Account rotation without identity drift** — under heavy rotation, `installation_id` MUST stay byte-identical in the outgoing body (TV8). Drift here implies E5 (refresh / rotation path stripped the field).
- **Spike in `codex.installation_id.file_rewrites`** — operator filesystem misbehaviour or another process is overwriting the file. Investigate; do not silently re-generate forever.

## Privacy posture

- The UUID is per-install client identity. Treat as identifier, not as user content.
- Allowed surfaces: debug-level structured logs scoped to the resolver module; integration test assertions.
- Forbidden surfaces: user-facing messages, error tracebacks shown to end users, third-party telemetry, public dashboards.

## Cross-links

- [errors.md](errors.md) — failure modes and contracts referenced from events above.
- [test-vectors.json](test-vectors.json) — TV7/TV8 provide the test harness for the `installation_id_missing_in_body` counter.
- [../provider_codex-prompt-realign/observability.md](../provider_codex-prompt-realign/observability.md) — sibling spec owns the cache-hit-ratio metric end-to-end; this spec contributes the identity dimension.
