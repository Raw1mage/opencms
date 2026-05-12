# Observability

Overview: this change is a surface text substitution; it emits no new events and exposes no new metrics. The signals listed below are the *meta-observability* used to verify the rebrand landed cleanly.

## Events

| Event | Source | When | Payload |
|-------|--------|------|---------|
| rebrand.batch.committed | git log | after each of the 6 batch commits | commit SHA, batch ID, files touched count |
| rebrand.typecheck.parity | bun turbo typecheck | on test/rebrand-opencms | new_failures=0, baseline_failures=<unchanged set> |
| rebrand.merged | git merge | merge to main | merge commit 6c66af0fd, source branch test/rebrand-opencms |

These are observed via `git log` / `git show` / `bun turbo typecheck`; no runtime emitter is introduced.

## Metrics

| Metric | Type | Value at merge |
|--------|------|----------------|
| files_modified | counter | 44 |
| batches_landed | counter | 5 effective (batch 2b superseded) |
| typecheck_new_failures | gauge | 0 |
| preservation_allowlist_violations | gauge | 0 |

No runtime metric emitter is introduced. Future opportunistic sweeps (see tasks.md §4.1) should record the same shape in their own plan packages.
