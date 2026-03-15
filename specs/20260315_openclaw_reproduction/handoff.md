# Handoff

## Execution Contract

- `openclaw_reproduction` is the single active planning authority for OpenClaw-aligned runner evolution.
- Use benchmark conclusions and implementation slices from this package together; do not bounce between older `openclaw*` packages as if they were co-equal active plans.

## Required Reads

- `/home/pkcs12/projects/opencode/specs/20260315_openclaw_reproduction/implementation-spec.md`
- `/home/pkcs12/projects/opencode/specs/20260315_openclaw_reproduction/proposal.md`
- `/home/pkcs12/projects/opencode/specs/20260315_openclaw_reproduction/spec.md`
- `/home/pkcs12/projects/opencode/specs/20260315_openclaw_reproduction/design.md`
- `/home/pkcs12/projects/opencode/specs/20260315_openclaw_reproduction/tasks.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260315_openclaw_reproduction.md`

## Historical Note

- This consolidated plan supersedes the earlier split between benchmark-only planning and scheduler-substrate planning.

## Stop Gates In Force

- Stop if build work expands beyond Trigger + Queue substrate without explicit approval.
- Stop if any proposal reintroduces multi-authority plan drift for the same workstream.

## Build Entry Recommendation

- Start from Trigger + Queue substrate.
- Treat isolated jobs / heartbeat / daemon lifecycle as deferred follow-up phases.
