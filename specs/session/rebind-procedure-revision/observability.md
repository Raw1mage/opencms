# Observability: session/rebind-procedure-revision

## Events

This plan introduces 3 new runtime event types and extends 1 existing event payload, all via the existing `RuntimeEventService.append` API. No new metric backend is added; observability rides on the existing per-session journal at `~/.local/share/opencode/storage/session_runtime_event/<sessionID>.json`.

## Metrics

No new metric counters / histograms. Aggregation is post-hoc via `jq` over the per-session JSON journal or via the existing web-UI telemetry sidebar projection. Three derived quantities should be tracked once telemetry has accumulated:

- **Chain-init injection rate per kind**: `count(chain.init.injected) group by eventKind`
- **Skip-vs-inject ratio**: `count(chain.init.skipped) / count(chain.init.injected)` — sanity check; should be non-zero (subagent_spawn / user_clear etc. legitimate skips) but not dominant
- **Mean digest entry count**: average `digestEntryCount` in `chain.init.injected` payloads — informs whether mutation activity per session is captured well

## New runtime events

| Event Type | Domain | Level | Anomaly Flags | When |
|---|---|---|---|---|
| `chain.init.injected` | workflow | info | — | `Continuation.run` dispatched and `chain_init_notice` is queued for next outbound |
| `chain.init.skipped` | workflow | info | — | `Continuation.run` evaluated but suppressed notice (subagent_spawn, user_clear, sl_provider, capability_only, ws_reconnect, no_prior_chain) |
| `chain.commitment.captured` | telemetry | info | — | `captureDigest` returned (success or empty, but NOT null) |
| `chain.commitment.failed` | workflow | info | — | `captureDigest` returned null (F-1 path); subsequent fragment uses sentinel |
| `chain.invalidate.failed` | workflow | warn | — | `invalidateContinuationFamily` threw (F-2 path) |
| `chain.init.persist.failed` | workflow | warn | — | `markPendingInjection` storage write failed (F-4 path) |

Payload fields are normative — see `data-schema.json#events`.

## Existing events extended

- **`session.rebind`** — payload gains `chainBreakClass: "SS-break" | "SL-noop" | "capability-only" | "user-intent" | "preserved"`. Existing fields unchanged; consumers reading without the new field continue to work (additive change).

## Existing events unchanged

- `session.rebind_storm` (anomaly, rate-limit) — unchanged
- `session.round.telemetry` — unchanged
- `llm.prompt.telemetry` — unchanged (but the fragment composition flowing into it changes due to `chain_stable` retag)

## How to observe

### Live tail (per session)

```
tail -f ~/.local/share/opencode/storage/session_runtime_event/<sessionID>.json | \
  jq 'select(.eventType | test("chain\\.|session\\.rebind"))'
```

### Per-session chain-break audit

```
jq '[.[] | select(.eventType=="session.rebind" or (.eventType | startswith("chain.")))]
    | sort_by(.ts)' \
   ~/.local/share/opencode/storage/session_runtime_event/<sessionID>.json
```

Returns the full chain-break timeline for a session, in order, including which kind of break, which class, and whether a notice was injected.

### Aggregate (last 24h, all sessions)

```
find ~/.local/share/opencode/storage/session_runtime_event -name '*.json' -mtime -1 \
  -exec jq -c '.[] | select(.eventType=="chain.init.injected") | {sessionID, eventKind: .payload.eventKind, digestEntryCount: .payload.digestEntryCount}' {} \; \
  | jq -s 'group_by(.eventKind) | map({eventKind: .[0].eventKind, count: length, avgDigest: ([.[].digestEntryCount] | add / length)})'
```

### Per-provider chain break class distribution

```
find ~/.local/share/opencode/storage/session_runtime_event -name '*.json' -mtime -1 \
  -exec jq -c '.[] | select(.eventType=="session.rebind") | {trigger: .payload.trigger, chainBreakClass: .payload.chainBreakClass}' {} \; \
  | jq -s 'group_by(.chainBreakClass) | map({class: .[0].chainBreakClass, count: length})'
```

Sanity check: SL-noop count for an account-switch trigger should equal account switches on anthropic / gemini sessions; SS-break count should match codex / copilot.

## What "healthy" looks like post-rollout

- For every `session.rebind` event there is a corresponding `chain.init.injected` OR `chain.init.skipped` event within 100ms.
- `chain.init.skipped` reasons are dominated by `sl_provider` and `capability_only` (legitimate); `user_clear` and `subagent_spawn` appear in proportion to those actions.
- `chain.invalidate.failed` and `chain.init.persist.failed` are rare (< 0.1% of total). Spike indicates regression.
- Mean `digestEntryCount` in `chain.init.injected` is ≥ 1 for sessions with non-trivial mutation history; 0 only on very fresh sessions.
- After rollout, sessions previously known to跳針 (e.g. ses_1e56ed3f9ffebv4AaWOlcPLz20 fixture replay) emit chain.init.injected at the rebind point and exit the would-be loop within 2 turns.

## What "broken" looks like

- `session.rebind` without a matching `chain.init.*` event → executor was bypassed; some old call site still calls `invalidateContinuationFamily` directly. Find via `grep` regression (M10-A1).
- `chain.init.injected` with `digestEntryCount: 0` consistently → digest capture broken, even when mutations exist. Check F-1 path.
- `session.rebind.chainBreakClass: "preserved"` for an event that should break (account_switch on codex) → classifier wrong. Audit classify().
- `chain.init.skipped` with `reason: "no_prior_chain"` on an account_switch → classifier wrong (suppression rule firing inappropriately).
- Compaction events emit `chain.init.injected` instead of using `amnesia-notice` → both fragments firing when only amnesia should. Check pendingInjection flags.

## Alert hooks (future, out of scope here)

If a metrics backend is added later (Prometheus / Grafana), recommended alerts:

- `chain.invalidate.failed` rate > 1/min for 5 min → page
- `chain.init.injected` rate suddenly drops to zero → indicates code path broken
- `digestEntryCount` mean across population trends to 0 → digest capture degrading

These belong in a separate spec when alerting infrastructure exists.
