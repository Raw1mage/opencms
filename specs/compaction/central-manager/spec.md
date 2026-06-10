# Spec: compaction_central-manager

## Purpose

Route every compaction- and enrichment-related request through a single
`CompactionManager` service intake that owns all policy, serializes work per
session, fans out post-anchor side-effects exactly once, and records each
request's origin + structured cause as the RCA ledger. This finishes the
"half-done unification" (trigger and chain-reset already centralized; enrichment
and publish are not) and, as a structural consequence, fixes the verified
double-trim amnesia bug without a throwaway guard.

## Requirements

### Requirement: Single intake for compaction/enrichment work

All compaction- and enrichment-related work SHALL be requested through one
`CompactionManager.submit(request)` entrypoint. No subsystem SHALL call `run()`,
`scheduleHybridEnrichment`, or `publishCompactedAndResetChain` directly.

#### Scenario: enrichment is scheduled exactly once per anchor

- **WHEN** a `run()`-path compaction commits a narrative anchor for an eligible
  observed condition
- **THEN** enrichment for that anchor id is scheduled exactly once
- **AND** a second enrichment request for the same anchor id is a no-op recorded
  as a `duplicate-enrich` anomaly (not a second trim).

#### Scenario: the `/compact` path and the run() path share one intake

- **WHEN** a user issues `/compact` (which historically reached enrichment only
  via `writeAnchorFromBody:795`)
- **THEN** it routes through the same `CompactionManager` intake as the runloop
  path, with no duplicated or missing enrichment.

### Requirement: Requests are accountable and carry structured cause

Every request SHALL carry `origin` (stable call-site id), a structured `cause`
(the measured signal values that justified it), and the `provider` class
(claude / codex / general). The manager SHALL log every request and reject
malformed ones at the door.

#### Scenario: a wrong request is attributable at the source

- **WHEN** a call site submits a duplicate or out-of-policy request
- **THEN** the manager logs one structured line naming the `origin` and `cause`
- **AND** raises a policy-violation anomaly event pointing at the source call
  site — no forensic reconstruction across journal + debug.logs is required.

### Requirement: Exactly-once post-anchor side-effects

For each committed anchor the manager SHALL publish chain-reset exactly once with
the anchor's actual kind, and schedule enrichment at most once.

#### Scenario: ai_free no longer double-publishes with the wrong kind

- **WHEN** an `ai_free` (codex server-side) compaction commits an anchor
- **THEN** chain-reset is published exactly once with `kind: ai_free`
- **AND** it is NOT first published as `kind: narrative` (which would wrongly
  SS-break a server-side compaction).

### Requirement: Structural deduplication, no replacement guard

Deduplication SHALL be a property of the single intake plus per-session
serialization. The `hybridEnrichInFlight` guard SHALL be removed and SHALL NOT
be replaced by another guard.

#### Scenario: the 2 ms drop_old fast path cannot double-trim

- **WHEN** two enrichment requests for the same anchor id arrive ~50 ms apart
  (the timing that defeated the in-flight guard)
- **THEN** the manager serves the first and rejects the second by anchor id
- **AND** the anchor is trimmed at most once.

### Requirement: Behaviour-preserving strangler migration

Each migration slice SHALL be observably equivalent to current behaviour except
for the defect it fixes. Policy values SHALL be relocated, not re-tuned.

#### Scenario: provider classes keep their distinct policy branches

- **WHEN** the same signal is reported on claude vs codex vs general sessions
- **THEN** the manager applies the same per-provider policy that exists today
  (claude SL-noop + CLAUDE_NOOP_OBSERVED + absolute aFloor; codex SS-break +
  item-count; general by-request forceRich) — byte-identical thresholds.

## Acceptance Checks

#### Scenario: the verified incident does not recur

- **GIVEN** a claude-cli 1M session that triggers cache-aware compaction
- **WHEN** the compaction commits a ~24K-token narrative anchor
- **THEN** exactly one `compaction.recompress` occurs for that anchor
- **AND** the anchor is not trimmed twice; the session retains its working
  context.

#### Scenario: existing compaction suite stays green

- **WHEN** each strangler slice lands
- **THEN** the in-scope compaction test suite (75/75) passes
- **AND** new exactly-once / accountability regression tests pass.
