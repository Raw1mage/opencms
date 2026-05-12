# measure-rebind — quantitative measurement for session/rebind-procedure-revision

Read-only post-hoc analysers that mine local session storage to evaluate the chain-init protocol's empirical impact. Spec: `specs/session/rebind-procedure-evaluation/`.

## Inputs

All scripts run against the local opencode storage:

- `~/.local/share/opencode/storage/session/<sid>.db` — sqlite, has `parts` table (tool calls + outputs)
- `~/.local/share/opencode/storage/session_runtime_event/<sid>.json` — runtime event journal (round.telemetry, chain.*, rebind, …)
- `~/.local/share/opencode/storage/session/<sid>/info.json` — session execution config + recentEvents ring

No daemon involvement; all scripts are safe to run on a busy daemon (read-only).

## Scripts

### 1. `detect-stuck-episodes.sh <session_id_or_glob> [min_consecutive=3]`

Finds runs of identical tool calls (same `tool` + `arg`) in a session's `parts` table. The "stuck" pattern is the 11-round read-loop that motivated the parent spec. Output: TSV of `(session, tool, arg, consecutive_count, start_ts, end_ts)`.

```bash
./detect-stuck-episodes.sh ses_1e56ed3f9ffebv4AaWOlcPLz20 5
```

### 2. `burn-rate-per-session.py <session_id> [bucket_minutes=1]`

Aggregates `session.round.telemetry` events into time buckets. Each bucket: rounds, inputTokens sum, outputTokens sum, cacheReadTokens sum. Output: CSV per-minute series. Pipe to chart tool or sqlite for analysis.

```bash
./burn-rate-per-session.py ses_1e56ed3f9ffebv4AaWOlcPLz20 1 > burn.csv
```

### 3. `chain-init-effectiveness.py <session_id> [window_minutes=30]`

For every `chain.init.injected` event, measures the forward window: rounds completed, tokens consumed, stuck episodes detected. Groups by `eventKind` for cohort comparison. Output: CSV per-event.

```bash
./chain-init-effectiveness.py ses_1e56ed3f9ffebv4AaWOlcPLz20 30 > effect.csv
```

### 4. `reduce-cohort.py <cohort_label> <session_id...>`

Combines per-session CSVs from #2 and #3 into a cohort-level summary. Two cohorts to compare: `pre-chain-init` (pre-fix sessions, identify by daemon-start time before parent spec graduation date 2026-05-12) vs `post-chain-init` (sessions after).

```bash
./reduce-cohort.py post-chain-init ses_id1 ses_id2 ses_id3 > post.summary.csv
./reduce-cohort.py pre-chain-init ses_oldA ses_oldB > pre.summary.csv
```

## Identifying baseline cohort

Pre-fix sessions = anything where the session's first round happened before main HEAD was at `43f88c3bf` (the graduation commit, 2026-05-12 evening). Approximation: `info.json.execution.updatedAt < epoch_of_graduation`.

## Recommended daily collection

Cron / manual:

```bash
# every 6h: aggregate all active sessions of the last 6h
for sid in $(ls ~/.local/share/opencode/storage/session_runtime_event/ | sed 's/.json//'); do
  ./burn-rate-per-session.py "$sid" 1 > ~/measure-rebind-data/burn/${sid}.csv
  ./chain-init-effectiveness.py "$sid" 30 > ~/measure-rebind-data/effect/${sid}.csv
done
```

After N=20+ sessions accumulated, run `reduce-cohort.py` to produce the paper figures.
