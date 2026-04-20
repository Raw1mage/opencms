# Observability: safe-daemon-restart

## Events

All events are structured log lines on gateway stderr (captured by systemd journal). See also `data-schema.json:OrphanCleanupEvent` for typed shape.

## Metrics

See "Minimal metrics" section below. MVP ships log-only; Prometheus export is deferred.

## Log keywords (grep-able)

| Keyword | Source | Level | Fields |
|---|---|---|---|
| `restart-self` | gateway | INFO | `uid`, `targetPid`, `eventId`, `reason` |
| `restart-sigkill` | gateway | WARN | `uid`, `targetPid`, `eventId`, `timeoutMs` |
| `orphan-cleanup` | gateway | WARN | `uid`, `holderPid`, `lockPath`, `result=exited\|timeout-killed` |
| `runtime-dir-created` | gateway | INFO | `uid`, `path` |
| `runtime-dir-present` | gateway | DEBUG | `uid`, `path` |
| `denylist-block` | system-manager | WARN | `rule`, `argvHash` (argv hashed, not raw) |

## Events (structured)

Gateway writes structured log lines to stderr (captured by systemd journal):

```
[time] [LEVEL] restart-self uid=1000 targetPid=31934 eventId=<uuid> reason="AI requested reload"
[time] [WARN ] orphan-cleanup uid=1000 holderPid=31934 lockPath=/home/pkcs12/.local/share/opencode/gateway.lock result=exited
```

## Minimal metrics (future-facing, not required for MVP)

- `daemon_restart_total{reason,result}` — counter
- `orphan_cleanup_total{result}` — counter
- `restart_duration_ms` — histogram

MVP ships only log keywords; metrics export 屬 out-of-scope（另外排程）.

## Alerts

MVP 不新增 alert；運維可自行用 `journalctl -u opencode-gateway -g 'orphan-cleanup'` 做 spot-check。長期若 `orphan-cleanup` 次數異常升高，代表 denylist 有 bypass 需要查。
