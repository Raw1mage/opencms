# Spec: compaction-fix

Behavioral requirements for the live compaction-fix system: three
itemCount-gated triggers + Phase 2 anchor-prefix expansion + codex
compaction-priority.

## Requirements

### Requirement: Paralysis × bloated-input fires compaction instead of nudge

#### Scenario: 3-turn paralysis with high itemCount

- **GIVEN** the 3-turn paralysis detector matches (sigTriple OR
  narrativeTriple)
- **AND** `paralysisRecoveryCount === 0`
- **AND** estimated codex input itemCount > 250
- **AND** session has no `parentID` (main session, not subagent)
- **WHEN** the runloop reaches the recovery branch
- **THEN** `SessionCompaction.run({observed: "overflow"})` is invoked
- **AND** `paralysisRecoveryCount` is set to 1
- **AND** the existing nudge injection is skipped
- **AND** runloop iteration ends via `continue`

#### Scenario: 3-turn paralysis with low itemCount falls back to nudge

- **GIVEN** the 3-turn paralysis detector matches
- **AND** estimated itemCount ≤ 250
- **WHEN** the runloop reaches the recovery branch
- **THEN** the existing recovery nudge injection runs
- **AND** no compaction is triggered

### Requirement: ws-truncation × bloated-input fires compaction at runloop top

#### Scenario: classifier-failure finishReason with high itemCount

- **GIVEN** `lastFinished.finish` is one of `unknown` / `error` /
  `other` (the codex empty-turn classifier's mapped finishReasons
  per [sse.ts](../../packages/opencode-codex-provider/src/sse.ts))
- **AND** estimated itemCount > 250
- **AND** session has no `parentID`
- **WHEN** runloop iteration reaches the post-`lastFinished` checkpoint
- **THEN** `SessionCompaction.run({observed: "empty-response"})` is
  invoked
- **AND** runloop iteration ends via `continue`

#### Scenario: healthy finishReason skips trigger

- **GIVEN** `lastFinished.finish` is `stop` / `tool-calls` / `length`
- **WHEN** runloop iteration reaches the checkpoint
- **THEN** no compaction is triggered regardless of itemCount

### Requirement: Pre-emptive rebind compaction at handoff

#### Scenario: rebind slices large session

- **GIVEN** daemon is at step=1 for this session
- **AND** `applyStreamAnchorRebind` has produced a sliced `msgs`
- **AND** estimated itemCount > 250 OR `tokenRatio > 0.7`
- **AND** session has no `parentID`
- **WHEN** runloop continues after `applyStreamAnchorRebind`
- **THEN** `SessionCompaction.run({observed: "rebind"})` is invoked
- **AND** runloop iteration ends via `continue`

#### Scenario: rebind slices small session

- **GIVEN** daemon is at step=1
- **AND** sliced `msgs` itemCount ≤ 250 AND `tokenRatio ≤ 0.7`
- **WHEN** runloop continues
- **THEN** no compaction is triggered; flow proceeds to LLM call

### Requirement: Phase 2 anchor-prefix expansion replaces summary with codex compactedItems

#### Scenario: anchor carries valid compactedItems

- **GIVEN** anchor message has
  `metadata.serverCompactedItems` populated
- **AND** `metadata.chainBinding.accountId === current accountId`
- **AND** `metadata.chainBinding.modelId === current modelId`
- **AND** `compaction_phase2_enabled === true`
- **WHEN** `expandAnchorCompactedPrefix` runs after
  `applyStreamAnchorRebind`
- **THEN** anchor message is dropped from the projection
- **AND** for each codex `message`-type entry, a synthetic user-role
  MessageV2 with the entry's text content is emitted
- **AND** non-`message` entries (function_call, function_call_output,
  reasoning) are JSON-serialized into a single labeled wrapper user
  message
- **AND** the projection becomes `[...synthesized, ...messages.slice(1)]`

#### Scenario: chain-binding mismatch falls back to summary

- **GIVEN** anchor has `serverCompactedItems` but
  `chainBinding.modelId` differs from current `modelId` (account
  switch / model switch / cross-chain rotation occurred)
- **WHEN** `expandAnchorCompactedPrefix` runs
- **THEN** compactedItems are skipped from projection
- **AND** anchor's free-form summary text is used
- **AND** stored `compactedItems` are NOT deleted (forensics retained)

### Requirement: Phase 2 storage on CompactionPart metadata is additive

#### Scenario: tryLowCostServer succeeds

- **GIVEN** codex `/responses/compact` plugin hook returns
  non-empty `compactedItems`
- **WHEN** `tryLowCostServer` writes the anchor
- **THEN** `CompactionPart.metadata.serverCompactedItems` is set to
  the codex-issued items
- **AND** `CompactionPart.metadata.chainBinding` is set to current
  `{accountId, modelId, capturedAt}`
- **AND** the anchor's free-form summary text is also written
  (fallback path)

### Requirement: Codex provider tries server-side compaction first

#### Scenario: codex provider, any observed event

- **GIVEN** `providerId === "codex"`
- **WHEN** `resolveKindChain({observed, providerId: "codex"})` is
  called
- **THEN** the returned chain has `low-cost-server` at index 0
- **AND** the rest of the base chain (per `KIND_CHAIN[observed]`)
  follows in order, with `low-cost-server` removed if it was
  already present

#### Scenario: non-codex provider unchanged

- **GIVEN** `providerId !== "codex"`
- **WHEN** `resolveKindChain` is called
- **THEN** the base `KIND_CHAIN[observed]` is returned unchanged
  (local-first ordering preserved)

### Requirement: Layer Purity Invariant

#### Scenario: trace markers and compactedItems do not leak L4 state

- **GIVEN** any compaction payload (anchor summary text, trace
  markers, or `serverCompactedItems`-derived synthetic messages)
- **WHEN** the payload is rendered into the prompt
- **THEN** the rendered text does NOT contain accountId / providerId
  / WS session ID / `previous_response_id` / `conversation_id` /
  connection-scoped credentials
- **AND** WorkingCache reference IDs are sessionID-scoped
- **EXCEPT** the `compactedItems` content from codex is opaque (DD-10
  carve-out); only synthetic labels we add are subject to the guard

### Requirement: Feature flags

#### Scenario: Phase 2 default-on

- **GIVEN** `compaction_phase2_enabled` is unset OR `1`
- **WHEN** prompt assembly runs
- **THEN** `expandAnchorCompactedPrefix` is invoked when the anchor
  carries valid `serverCompactedItems`

#### Scenario: Phase 1 default-off

- **GIVEN** `compaction_phase1_enabled` is `0` (default)
- **WHEN** prompt assembly runs
- **THEN** `transformPostAnchorTail` is NOT invoked
- **AND** the post-anchor message tail is sent to the LLM unchanged
  (matches upstream codex-rs `for_prompt()` full-pass-through)

## Acceptance Checks

- A1: Three trigger sites in `prompt.ts` invoke `SessionCompaction.run`
  with the correct `observed` argument when their preconditions hold,
  and skip when not
- A2: `expandAnchorCompactedPrefix` correctly expands valid items and
  falls back on chain-binding mismatch
- A3: `resolveKindChain` puts `low-cost-server` at index 0 for codex
  regardless of context ratio / subscription flag; non-codex chain
  unchanged
- A4: All three triggers degrade gracefully on compaction failure
  (fall through to original code path)
- A5: Layer purity invariant holds across rotation / rebind / WS
  reconnect (prompt content stays semantically equivalent)
- A6: Feature flags govern Phase 1 and Phase 2 independently
