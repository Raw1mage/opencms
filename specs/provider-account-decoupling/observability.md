# Observability

## Events

| Event | Emitter | Payload | When |
|---|---|---|---|
| `registry.populate.completed` | C1.3 populate loop | `{ familyCount, accountCount }` | Once per registry rebuild |
| `registry.shape.rejected` | C1.2 guard | `{ providerId, knownFamilies }` | Whenever `assertFamilyKey` would throw `RegistryShapeError` (in addition to throwing) |
| `auth.lookup.failed` | C2.1 Auth.get | `{ family, accountId, errorCode }` | UnknownFamilyError or NoActiveAccountError |
| `getSDK.completed` | C3.1 | `{ family, accountId, modelId, durationMs }` | Per call (existing telemetry; just confirm signature change carries through) |
| `rotation.candidate.built` | C4.1 | `{ family, accountCount, source: "step1" \| "step3b" }` | Per buildFallbackCandidates run |
| `migration.start` | C6 | `{ mode: "dry-run" \| "apply", backup_path? }` | Migration script invocation |
| `migration.file.rewritten` | C6.2 | `{ path, before_providerId, after_providerId }` | Per file write |
| `migration.file.skipped` | C6.2 | `{ path, reason: "already-clean" }` | Per skipped file |
| `migration.completed` | C6 | `{ filesScanned, filesRewritten, filesSkipped, durationMs, marker_path }` | At end of script |
| `daemon.boot.marker.verified` | C7.1 | `{ marker_version, migrated_at }` | Successful boot |
| `daemon.boot.marker.missing` | C7.1 | `{ expected_version, found }` | Failed boot — emitted before MigrationRequiredError throw |

## Metrics

| Metric | Type | Labels | Why |
|---|---|---|---|
| `provider_registry_size` | gauge | `kind=family` | Should equal `Account.knownFamilies().length` after refactor; sanity invariant |
| `provider_registry_populate_duration_ms` | histogram | — | Watch for regression after restructuring populate loop |
| `auth_get_total` | counter | `family, result=hit\|missing\|throw` | Catch silent-miss regressions |
| `auth_get_throw_total` | counter | `family, errorCode` | Spike = caller passing wrong identifier shape |
| `rotation_candidate_pool_size` | histogram | `family` | Should NOT collapse to 0 for codex with healthy accounts (this metric would have caught the 2026-05-02 incident) |
| `rotation_codex_family_exhausted_total` | counter | — | Genuine exhaustion only — should be near zero in normal ops |
| `migration_files_rewritten_total` | counter (one-shot) | — | Visible in migration log; archived after cutover |

## Logs

All errors and migration events use structured logging via the existing `Log.create({ service: "..." })` pattern. No new log infrastructure introduced.

Log levels:
- `INFO` — `registry.populate.completed`, `migration.*`, `daemon.boot.marker.verified`
- `WARN` — `migration.file.skipped` (high volume during early dry-run)
- `ERROR` — `registry.shape.rejected`, `auth.lookup.failed`, `daemon.boot.marker.missing`

## Alerts

| Alert | Condition | Severity | Action |
|---|---|---|---|
| RegistryShapeRegression | `registry_shape_rejected_total > 0` over any 5m window | critical | Code regression — a caller is inserting per-account providerId. Block release. |
| RotationCodexFamilyExhausted | `rotation_codex_family_exhausted_total` rate > 0 sustained 10m AND at least one codex account has `5h_remaining > 50%` | high | Possible regression of 2026-05-02 bug. Inspect rotation candidate pool size + recent code changes. |
| DaemonBootMarkerMissing | `daemon_boot_marker_missing_total >= 1` | informational (operator) | Expected during planned cutover; alert only if not within a known maintenance window. |

## Acceptance via observability

Three signals together = refactor working:

1. `provider_registry_size{kind=family}` equals `knownFamilies().length` (no per-account inflation)
2. `auth_get_throw_total{errorCode=UnknownFamilyError}` is zero in normal traffic
3. `rotation_candidate_pool_size{family=codex}` reaches its expected size (~16 accounts, minus those rate-limited)
