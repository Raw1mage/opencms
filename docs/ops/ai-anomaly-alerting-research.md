# AI Anomaly Alerting Research for Warroom

## Executive Summary

Warroom should not begin with deep learning as the primary detector. The first production-friendly path is:

1. **Rules** for obvious security and collection-health conditions.
2. **Rolling baselines** for time-series deviations.
3. **Isolation Forest** for unsupervised entity-level anomaly scoring once enough feature history exists.
4. **LLM-assisted triage** for summaries and recommended actions, not for primary detection or automated response.

The scoring loop should read from Loki, build windowed features, emit normalized `anomaly_alert` events back to Loki, expose scorer health/metrics to Prometheus, and let dashboards / notifiers consume those normalized alerts.

## Common Model Families

| Approach                          | Best for                                                            | Data needed               | Explainability | POC fit        | Caveats                                                           |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------- | -------------- | -------------- | ----------------------------------------------------------------- |
| Static rules / thresholds         | Known bad patterns: auth failures, large downloads, capability gaps | Minimal                   | High           | Excellent      | False positives if thresholds are crude                           |
| Rolling baseline / z-score / EWMA | Counts, bytes, connection counts, host metrics                      | Short history             | High           | Excellent      | Needs enough stable history; weak on seasonality                  |
| Median + MAD                      | Robust outlier detection on noisy counts/bytes                      | Short to medium history   | High           | Excellent      | Still needs careful windows                                       |
| STL / seasonal baseline           | Business-hour / weekday seasonality                                 | Medium history            | Medium         | Good later     | Needs stable daily/weekly seasonality                             |
| Isolation Forest                  | Windowed feature vectors by actor/IP/source                         | Medium history            | Medium         | Good Phase 3   | Needs feature engineering and score calibration                   |
| One-Class SVM                     | Compact normal-only feature space                                   | Medium clean history      | Medium         | Lower priority | Sensitive to scaling and parameters                               |
| LOF / kNN anomaly                 | Local neighborhood anomaly by entity behavior                       | Medium                    | Medium         | Lower priority | More expensive online operation                                   |
| Autoencoder                       | High-dimensional continuous features                                | Medium to large           | Low            | Not first      | Harder to explain and operate                                     |
| LSTM / Transformer sequence model | Event sequences, complex user journeys                              | Large                     | Low to medium  | Not first      | Too heavy for initial NAS POC                                     |
| Graph / UBA                       | User-IP-file-share relationships                                    | Medium to large           | Medium         | Later          | Requires entity graph and relationship store                      |
| LLM-assisted triage               | Alert explanation and operator guidance                             | Alert + evidence snippets | Medium         | Useful Phase 4 | Must not be the only detector; privacy and cost controls required |

## Warroom Data Available Now

### Auth events

Loki selector:

```logql
{nas_host="lishanmei", source_channel="auth_log"}
```

Useful fields:

- `action`: `auth_failure`, `session_opened`, `session_closed`
- `actor`
- `source_ip`
- `event_outcome`
- `failure_reason`
- `network_protocol`

### Network socket snapshots

```logql
{nas_host="lishanmei", source_channel="network_socket"}
```

Useful fields:

- `tcp_connection_count`
- `tcp_established_count`
- `tcp_listen_count`
- `tcp_remote_ip_count`
- `top_remote_ips`
- `listening_ports`

### File/download events

```logql
{nas_host="lishanmei", action="webapp_file_download"}
```

Useful fields:

- `size_bytes`
- `actor` when available
- `source_ip` when available
- file/path metadata when provided by the adapter

### Capability gaps

```logql
{nas_host="lishanmei", action="capability_gap", source_channel="collector_capability_gap"}
```

Useful fields:

- `source_key`
- `affected_source_app`
- `affected_source_channel`
- `affected_capability`
- `gap_stage`
- `gap_detail`

## Feature Table Design

Generate features per time window, e.g. 5m / 15m / 1h:

```text
nas_host
window_start
window_end
entity_type
entity_id
auth_failure_count
auth_success_count
session_opened_count
download_count
download_bytes
large_download_count
tcp_established_max
tcp_remote_ip_count_max
tcp_listen_count_max
capability_gap_count
hour_of_day
day_of_week
is_off_hours
```

Recommended entity keys:

- `nas_host`
- `actor`
- `source_ip`
- `actor + source_ip`
- `source_channel`
- `affected_capability`

## Loki Integration Pattern

Do not run ML logic inside Grafana panels. Add a local service:

```text
Loki
  -> warroom-ai-anomaly-scorer
      -> query_range / instant LogQL
      -> feature extraction
      -> rules + baseline + ML scoring
      -> anomaly_alert events
  -> Loki Push API
  -> Grafana Anomaly Alert Center
  -> notifier service
```

### `anomaly_alert` event schema

```json
{
  "action": "anomaly_alert",
  "source_app": "warroom_ai",
  "source_channel": "anomaly_scorer",
  "nas_host": "lishanmei",
  "display_name": "TheSmartAI",
  "severity": "high",
  "rule_id": "auth_bruteforce_source_ip",
  "model_family": "rule",
  "entity_type": "source_ip",
  "entity_id": "1.2.3.4",
  "window": "5m",
  "score": 0.91,
  "reason": "auth_failure_count exceeded threshold",
  "feature_snapshot": {
    "auth_failure_count": 25
  },
  "evidence_query": "{nas_host=\"lishanmei\", source_channel=\"auth_log\"}",
  "recommended_action": "Review auth log, confirm maintenance activity, consider blocking source IP after approval."
}
```

## First Rule Catalog

| Rule ID                     | Condition                                              | Severity    | Data source                |
| --------------------------- | ------------------------------------------------------ | ----------- | -------------------------- |
| `auth_bruteforce_source_ip` | auth failures > 20 / 5m by source IP                   | High        | `auth_log`                 |
| `auth_failures_by_actor`    | auth failures > 10 / 15m by actor                      | Medium      | `auth_log`                 |
| `success_after_failures`    | >5 failures then successful session within 10m         | High        | `auth_log`                 |
| `large_download`            | any download >= 100MB                                  | Medium      | file download evidence     |
| `download_burst_actor`      | download count > 50 / 15m by actor                     | High        | file download evidence     |
| `download_volume_actor`     | download bytes above rolling baseline                  | Medium/High | file download evidence     |
| `tcp_established_spike`     | tcp established > rolling baseline or static threshold | Medium      | `network_socket`           |
| `capability_gap_active`     | active collector capability gap > 0 / 2m               | High        | `collector_capability_gap` |

## Alert Lifecycle

Minimum lifecycle:

```text
detected -> deduplicated -> notified -> acknowledged -> resolved/expired
```

POC can start with:

```text
scorer emits anomaly_alert
notifier polls anomaly_alert
dedupe by nas_host + rule_id + entity_id + severity + rolling window
send LINE/email
push notification_sent event back to Loki
```

## Email and LINE Bot Integration

### Email

Recommended POC options:

- SMTP relay
- Gmail API
- SES / SendGrid / Mailgun later

Message should include:

- severity
- rule ID
- affected entity
- feature counts / score
- time window
- Grafana link
- evidence query
- recommended action

### LINE Bot

Use LINE Messaging API, not deprecated LINE Notify.

Message format:

```text
[HIGH] TheSmartAI 異常登入警訊
Rule: auth_bruteforce_source_ip
Source IP: x.x.x.x
Failures: 25 / 5m
Score: 0.91
Evidence: <Grafana link>
Action: 檢查 NAS auth log；若非維護行為，走人工批准封鎖流程。
```

Security rules:

- LINE channel access token and SMTP secrets must never be committed.
- High severity can be immediate LINE push.
- Medium/low should be email digest or dashboard-only to avoid alert fatigue.
- Notifier must implement rate limit, dedupe, and quiet-hour policy.

## POC Roadmap

### Phase 1 — Rule-based scorer

- New service: `warroom-ai-anomaly-scorer`.
- Query Loki every 1 minute.
- Emit `anomaly_alert` events back to Loki.
- Dashboard reads only `action="anomaly_alert"`.

### Phase 2 — Rolling baseline

- Add z-score / EWMA / median-MAD.
- Store feature history in SQLite initially.
- Use baseline for download volume and TCP connection spikes.

### Phase 3 — Isolation Forest

- Train per `nas_host` and source category.
- Input: windowed feature vectors.
- Output: anomaly score and top contributing features.

### Phase 4 — LLM-assisted triage

- Input: anomaly event + feature snapshot + sample Loki evidence.
- Output: Chinese summary, likely cause, severity suggestion, recommended actions, notification draft.
- LLM must not directly approve destructive response.

## Caveats

- Without labeled data, avoid supervised models at the start.
- Deep learning requires stable historical data and is not suitable for first POC.
- Loki is good for event query and aggregation; long-term feature history should move to SQLite/Postgres/Parquet.
- Raw users/IPs/paths should remain payload/feature-store values, not Prometheus labels.
- AI score must be traceable: keep `rule_id`, query, window, features, and evidence references.
