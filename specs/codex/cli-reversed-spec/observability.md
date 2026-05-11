# Observability — codex-cli reversed spec

This spec is a reference document; it has no runtime, no logs, no metrics. The observability documented here is what *upstream codex-cli emits* — captured during audit and referenced from the relevant chapters.

## Events
- `CodexCompactionEvent`, `AppInvocation`, `TurnSubmissionType`, subagent thread starts, hook runs — shipped via `AnalyticsClient.track_event` (Ch12 A12.4)
- `bus.session.round.telemetry` — per-turn cache observation (Ch11 A11.4)
- Rollout `RolloutItem` records appended to JSONL (Ch12 A12.1)

## Metrics
- OTel counter/gauge/timer via `OtelProvider` + `RuntimeMetricTotals` (Ch12 A12.3)
- `TokenUsage.cached_input_tokens` from `ResponseEvent::Completed` (Ch11 A11.4)
- Per-request + per-turn `SessionTelemetry`

## Traces
- OTel spans with attributes (`thread_id`, `originator`, `model`, …) (Ch12 A12.3)
- W3C trace context propagated via WS `client_metadata` (Ch12 A12.6)

## Console
- `[CODEX-WS] USAGE` log line per completed turn

## Rollout
- JSONL files at `rollout-<ts>-<uuid>.jsonl` partitioned `YYYY/MM/DD` (Ch12 A12.1)
- `policy::is_persisted_rollout_item` gates writes (Ch12 A12.2)
