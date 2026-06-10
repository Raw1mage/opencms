# Errors — compaction_central-manager

## Error Catalogue

The manager turns previously-silent failures (which corrupted the anchor without
any signal) into first-class, attributable events. Each anomaly names the
offending `origin` so the fix lands at the source, not as a downstream guard.

| Code | Class | Trigger | Manager action | Origin attributed | Severity |
|---|---|---|---|---|---|
| `duplicate-enrich` | policy-violation | second `enrich` for an already-served `anchorId` | reject (no-op), emit anomaly | yes (`origin` + `servedBy`) | warn |
| `compact-during-cooldown` | policy-violation | `compact`/`evaluate→compact` while latest anchor < 30 s old | suppress compaction, emit anomaly | yes | warn |
| `enrich-below-floor` | policy-violation | `enrich` for an anchor below the provider A-tier floor | skip enrichment, emit anomaly | yes | info |
| `publish-kind-mismatch` | invariant-breach | `anchorCommitted` publish kind ≠ committed anchor kind (e.g. ai_free published as narrative) | publish with actual kind, emit anomaly | yes | error |
| `lock-held-too-long` | liveness | per-session execution lock held beyond threshold | emit anomaly (mirrors `session.rebind_storm`); lock still released in finally | yes | error |
| `malformed-request` | intake-reject | request missing `origin` / `cause` / `provider` or unknown kind | reject at the door, log | yes | warn |

### Failure-handling principles

- **Fail observable, not silent.** The verified incident succeeded silently and
  corrupted the anchor. Under the manager, a policy-violating request is a named,
  logged event — never a silent mutation.
- **Reject, don't repair.** Duplicate / out-of-policy requests are rejected at the
  intake; the manager does not "fix" by re-doing or compensating downstream.
- **Executor failures are non-fatal.** Enrichment is fire-and-forget; an executor
  throw is logged + recorded, never blocks the runloop (unchanged from today).
- **Lock safety.** The per-session lock is always released at the manager boundary
  (finally-equivalent); `lock-held-too-long` is a tripwire, not a deadlock path.
- **Daemon-restart resilience.** Per-session manager state is reconstructable from
  the message stream (anchors), so a `restart_self` rebuild loses no correctness —
  at worst an in-flight enrichment is re-evaluated and deduped by `anchorId`.
