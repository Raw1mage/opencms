# Observability

## Events

Runtime events emitted via the event bus / log sink. Declare here before code emits them.

- `example.created` — emitted when example entity is created
  - **Payload**: `{ id: string, at: string }`
  - **Emitter**: ExampleService
  - **Consumers**: audit log, analytics

## Metrics

Numeric measurements collected for dashboards / alerts.

- `example.request.latency_ms` — request latency histogram
  - **Type**: histogram
  - **Labels**: `operation`, `outcome`
  - **Dashboard**: example-overview

## Logs

Structured log lines. Declare key fields so code logging conventions are mechanical.

- Log level usage: `error` for recovery-required, `warn` for drift, `info` for transitions, `debug` for developer tracing
- Required structured fields: `request_id`, `user_id` (if auth), `operation`

## Alerts

- `example-error-spike` — fires when `example.request.latency_ms` p99 > threshold for N minutes
