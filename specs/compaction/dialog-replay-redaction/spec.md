# Spec: dialog-replay-redaction

## Purpose

Restore the two-tier compaction model originally designed in the codebase (extend + recompress) by patching four divergence points the v1-v6 evolution introduced. After this spec lands, the formal model holds exactly:

```
extend:    anchor[n+1].body = anchor[n].body + serialize_redacted(tail_between(anchor[n], now))
recompress: if size(anchor.body) > 50K: codex → /responses/compact, else → llm-agent
```

No new mechanisms; this is a refit.

## Requirements

### Requirement: Extend produces anchor[n+1] = anchor[n] + redact(tail)

Every compaction commit via the `narrative` kind must produce an anchor body that equals the previous anchor's body concatenated with a serialised, redacted form of all messages between the previous anchor and the new compaction point.

#### Scenario: First compaction in a session (anchor[0] doesn't exist)

- **GIVEN** a fresh session with no prior anchor and ten user/assistant rounds
- **WHEN** narrative kind fires for the first time
- **THEN** the anchor body equals `serializeRedactedDialog(messages[0..10])` (no prepended prevAnchor.text)
- **AND** the body is markdown-formatted with `## Round N`, `**User**`, `**Assistant**`, `**Reasoning**`, `**Tool**: ...` sections per the agreed grammar
- **AND** every `tool.state.output` in the redacted form is replaced by `recall_id: <part.id>`
- **AND** assistant text + reasoning + tool args are preserved verbatim

#### Scenario: Subsequent compaction (anchor[n] exists)

- **GIVEN** a session whose latest anchor[n] has body text `"## Round 1\n\n**User**\n..."`
- **AND** twenty new messages exist after anchor[n]
- **WHEN** narrative kind fires
- **THEN** the new anchor[n+1] body equals `anchor[n].body + "\n\n" + serializeRedactedDialog(those 20 messages)`
- **AND** the round numbering continues from where anchor[n] left off (no reset)
- **AND** all redaction rules apply uniformly across the appended segment

#### Scenario: Round numbering across a recompressed boundary

- **GIVEN** anchor[n] was just recompressed by `/responses/compact` (its body is now an LLM summary, not the original redacted-dialog text)
- **AND** five new messages exist after the recompressed anchor[n]
- **WHEN** the next extend fires
- **THEN** the redacted-dialog appended starts at `## Round <last visible round + 1>` if recoverable, else `## Round 1` (TBD: design phase decides numbering rule)
- **AND** the LLM summary text is preserved verbatim as the prefix of anchor[n+1] body

### Requirement: Recompress triggers on size, not on observed condition

The background recompress mechanism (`scheduleHybridEnrichment`) must trigger when anchor body exceeds 50,000 tokens, regardless of which `observed` condition originally drove the compaction.

#### Scenario: Anchor exceeds 50K — codex provider

- **GIVEN** a codex session whose latest anchor body has 52,000 estimated tokens
- **AND** any compaction kind just committed (narrative / replay-tail / etc.)
- **WHEN** scheduleHybridEnrichment is invoked
- **THEN** the dispatcher routes to `tryLowCostServer`-style `/responses/compact` (not `Hybrid.runHybridLlm`)
- **AND** on success, the anchor body is overwritten in-place with the LLM-distilled summary
- **AND** telemetry records `recompress.trigger: "size-ceiling"` and `recompress.kind: "low-cost-server"`

#### Scenario: Anchor exceeds 50K — non-codex provider

- **GIVEN** a claude / openai / other session whose latest anchor body has 52,000 estimated tokens
- **WHEN** scheduleHybridEnrichment is invoked
- **THEN** the dispatcher routes to `Hybrid.runHybridLlm` (not server-side)
- **AND** on success, the anchor body is overwritten in-place
- **AND** telemetry records `recompress.kind: "hybrid_llm"`

#### Scenario: Anchor below 5K — skip floor

- **GIVEN** anchor body has 4,000 estimated tokens
- **WHEN** scheduleHybridEnrichment is invoked
- **THEN** no recompress fires (skip floor preserved)
- **AND** telemetry records `recompress.skip: "below-floor"`

#### Scenario: observed === "rebind" (was previously gated out)

- **GIVEN** a rebind pre-emptive compaction with anchor body at 60K tokens post-extend
- **WHEN** scheduleHybridEnrichment is invoked
- **THEN** recompress fires (the previous `observed in {overflow, cache-aware, manual}` gate is removed)
- **AND** behaviour matches the codex / non-codex routing scenarios above

### Requirement: Post-anchor stream is redacted, not dropped

The post-anchor-transform pipeline must replace tool result payloads with recall references, not drop completed assistant messages.

#### Scenario: Multi-task session post-extend

- **GIVEN** a session with a recent anchor and 3 prior user-task chains in the post-anchor stream (each chain = user msg + multiple completed assistant turns)
- **WHEN** the runloop builds the LLM-visible context via post-anchor-transform v7
- **THEN** all 3 user msgs survive (as before)
- **AND** all completed assistant turns survive (NEW — v6 dropped these)
- **AND** every `tool.state.output` content is replaced by `recall_id: <part.id>` placeholder
- **AND** all assistant text / reasoning / tool_call args are preserved verbatim
- **AND** the in-flight assistant carve-out still applies (no redaction on pending parts)
- **AND** the compaction-bearing assistant carve-out still applies (Mode 1 inline server compaction state untouched)

#### Scenario: Token budget exceeded post-redaction

- **GIVEN** post-anchor stream contains so much dialog (after redaction) that it exceeds filterCompacted's token budget guard
- **WHEN** filterCompacted runs
- **THEN** it stops scanning at the budget and reports `stoppedByBudget: true`
- **AND** the LLM-visible context is bounded; older messages (post-anchor but earliest) are simply not surfaced this iteration
- **AND** the next compaction triggers extend, absorbing them into the next anchor

### Requirement: Synergy with user-msg-replay-unification (excludes unanswered user msg from extend)

`serializeRedactedDialog` must exclude the most-recent unanswered user message (the user msg whose nearest assistant child has `finish ∉ {stop, tool-calls, length}` or no assistant child at all) from the tail it serialises. The unanswered user message stays in the post-anchor stream where Spec `user-msg-replay-unification`'s replay helper handles it.

Without this rule, the unanswered user msg would appear twice from the model's perspective: once embedded in anchor body via redacted dialog, once replayed post-anchor by the helper.

#### Scenario: Compaction during pending user question

- **GIVEN** the post-anchor stream has 5 finished rounds + 1 unanswered user msg `msg_X` at the tail (no completed assistant child yet)
- **WHEN** narrative kind extends the anchor
- **THEN** anchor[n+1].body = anchor[n].body + serializeRedactedDialog(only the 5 finished rounds, EXCLUDING msg_X)
- **AND** msg_X is left untouched in the post-anchor stream
- **AND** Spec 1's replay helper (running after anchor write) replays msg_X to msg_X' with id > anchor.id
- **AND** filterCompacted on next iter returns [anchor[n+1], msg_X']
- **AND** model sees msg_X exactly once (as the live question), with prior history available in anchor body

#### Scenario: All rounds in tail are finished

- **GIVEN** the post-anchor stream has 5 finished rounds and no unanswered user msg
- **WHEN** narrative kind extends the anchor
- **THEN** anchor[n+1].body absorbs all 5 rounds via serializeRedactedDialog
- **AND** Spec 1 helper detects no unanswered user msg and skips with reason `"no-unanswered"`

### Requirement: Memory.read fallback handles reasoning channel

`lastTextPartText` (memory.ts:201) must accept `type === "reasoning"` parts in addition to `type === "text"`. This affects all consumers of `Memory.read`'s turnSummaries (renderForHumanSync, debug dumps, cold-start fallback for tryNarrative).

#### Scenario: Codex turn with reasoning-only content

- **GIVEN** a codex assistant message whose parts are `[reasoning, tool_call, tool_call]` with no `text` part
- **WHEN** Memory.read processes this message into turnSummaries
- **THEN** the reasoning part's text is captured (not skipped due to empty text)
- **AND** the turn contributes a non-empty entry to turnSummaries

### Requirement: Feature flag for safe rollout

A new Tweaks key `enableDialogRedactionAnchor` (default `true`) gates the new tryNarrative behaviour. Setting `false` reverts tryNarrative to the legacy `Memory.renderForLLMSync` body source for emergency rollback.

#### Scenario: Flag disabled

- **GIVEN** `Tweaks.compactionSync().enableDialogRedactionAnchor === false`
- **WHEN** narrative kind fires
- **THEN** anchor body is constructed from `Memory.renderForLLMSync(mem)` (legacy behaviour)
- **AND** post-anchor-transform falls back to v6 logic (drop completed assistants before lastUserIdx)
- **AND** scheduleHybridEnrichment retains legacy thresholds and observed-gate

## Acceptance Checks

1. **Anchor extension correctness**: integration test runs N compactions on a synthetic session; verifies anchor[n+1].body always equals anchor[n].body + redacted(tail) for every n.
2. **Round numbering monotonic across extends**: `## Round N` numbers strictly increase within an anchor body.
3. **Redaction completeness**: in any anchor body, no raw tool output payload appears; every tool result is represented by `recall_id: <part.id>` only.
4. **Recall round-trip**: for every `recall_id: prt_xxx` in an anchor body, calling `recall_toolcall_raw(prt_xxx)` returns the original tool output.
5. **Recompress trigger boundary**: anchor at 49,999 tokens → no recompress; at 50,000+ → recompress fires.
6. **Provider routing**: codex sessions hit `tryLowCostServer`; others hit `Hybrid.runHybridLlm`. Verified via mocked anchor writer + provider mock.
7. **observed-gate removal**: rebind / continuation-invalidated / provider-switched sessions can trigger recompress when anchor > 50K.
8. **post-anchor v7 preserves continuity**: in a multi-task session, model can read its own assistant turns from prior tasks (text + reasoning + tool args), no amnesia loop reproduction.
9. **Reasoning-only turns counted**: codex messages with `[reasoning, tool_call]` parts contribute to turnSummaries (not skipped).
10. **Backwards compatibility**: existing anchors written before this fix (with old narrative format) still parse correctly via Memory.read; transition is seamless.
11. **Feature flag rollback**: setting `enableDialogRedactionAnchor=false` restores exact pre-fix behaviour with no daemon restart.
12. **Token budget honoured**: redacted-dialog anchor body never exceeds the configured `anchorRecompressCeilingTokens` for more than one extend cycle (the next compaction must recompress it).
13. **Spec 1 synergy — single-occurrence guarantee**: in any post-extend + post-replay state, an unanswered user msg appears in EXACTLY ONE place: the post-anchor stream as a fresh-ULID replay. Anchor body does NOT contain it. Verified by integration test that asserts `anchorBody.includes(msg.text)` is false AND `postAnchorStream.contains(msg)` is true.
14. **Spec 1 synergy — full coverage across all observed conditions**: with both specs landed, msg-lost is solved for ALL nine observed conditions (overflow / cache-aware / idle / empty-response / rebind / continuation-invalidated / provider-switched / stall-recovery / manual). Reproduction test for the 2026-05-09 rebind incident must pass.
