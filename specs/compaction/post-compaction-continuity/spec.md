# Spec: compaction_post-compaction-continuity

## Purpose

Make the behaviour *around* a correct compaction trustworthy: report enrichment
honestly, tell the agent it was compacted, resume an interrupted task, and don't
compact claude when it doesn't need it. Builds on `compaction/central-manager`
(the manager already fires exactly once); this spec does not change that contract.

## Requirements

### Requirement: Enrichment is reported as enrichment, not compaction
The recentEvents ring and its Q-card tile MUST distinguish enrichment lifecycle
events from compaction events. Enrichment MUST NOT be stored under
`kind:"compaction"`.

#### Scenario: one compaction + its enrichment
- GIVEN one `cache-aware` narrative compaction that then enriches
- WHEN the recentEvents tile renders the two events
- THEN exactly one entry reads as a compaction and the enrichment entry reads as
  enrichment (no false "double compaction").

### Requirement: The amnesia notice reaches the real compaction
`decideAmnesiaInjection` MUST resolve its decision against the most recent real
client-side compaction, not against a mislabeled enrichment entry.

#### Scenario: enrichment entry does not suppress the notice
- GIVEN a recentEvents ring `[narrative-compaction(success:true), enrichment:success]`
- WHEN `decideAmnesiaInjection` runs
- THEN it returns `inject:true` for the narrative anchor (today: `inject:false`).

### Requirement: An interrupted task resumes after compaction
When a compaction interrupts an unfinished turn, the loop MUST continue the task
without a manual user nudge; a legitimately finished turn MUST NOT be re-fired.

#### Scenario: mid-task compaction
- GIVEN the assistant turn is unfinished (`hasLastFinished:false`) when a
  compaction commits
- WHEN the post-compaction path runs
- THEN the task resumes (replay or minimal Continue) and the loop does NOT exit
  via `no_user_after_compaction`.

#### Scenario: finished turn
- GIVEN the assistant turn finished normally
- WHEN a compaction commits at the boundary
- THEN no synthetic continuation is injected (no infinite loop).

### Requirement: claude declines unnecessary compaction
A `cache-aware` / `legacy-large-policy` compaction MUST be gated by the
per-provider strategy; claude declines when there is no real context pressure.
codex/general behaviour is byte-identical.

#### Scenario: small claude session
- GIVEN a claude-cli session with large window headroom (e.g. 8K used of 1M)
- WHEN a `legacy-large-policy` / `cache-aware` trigger is raised
- THEN claude does NOT compact (no SS-break amnesia), while the same signal on
  codex/general compacts exactly as before.

## Acceptance Checks

- recentEvents schema carries a first-class `enrichment` kind; SDK types regen.
- `decideAmnesiaInjection` regression test (ring above ⇒ `inject:true`) passes.
- Mid-task compaction resumes without manual "go on"; finished-turn does not loop.
- Equivalence test: codex/general compaction on the trigger unchanged; claude
  small-session declines.
- In-scope compaction suite stays green.
