# Spec: compaction_recall-affordance

## Purpose

Provide a three-layer affordance enabling the AI to recover from narrative-compaction-induced amnesia: TOOL_INDEX in the anchor body (addressability), `recall` tool (recovery channel), and rebind-aware system note (self-awareness). Scoped to opencode session runtime; no provider API changes; no storage changes.

The dominant failure mode this addresses: when rebind forces narrative compaction (because server-side compaction is unavailable post-rotation/restart), all pre-anchor tool results collapse into unaddressable prose. The AI cannot detect that its tool history is hollow, has no API to retrieve original content, and loops re-deriving conclusions it already had — observed in production as 跳針.

## Requirements

### Requirement: TOOL_INDEX is addressable post-compaction

Every narrative-kind anchor body MUST contain a `## TOOL_INDEX` section listing every pre-anchor tool call as `(tool_call_id, tool_name, args_brief, status, output_chars)`. Tool_call_ids in this section MUST be resolvable by `recall(tool_call_id)` from any subsequent turn in the same session, until a new anchor supersedes the current one.

#### Scenario: Rebind triggers narrative compaction with multiple pre-anchor tools

- **GIVEN** a session with 30 pre-anchor tool calls (read, grep, bash, etc.)
- **AND** rebind triggers narrative compaction at `SessionCompaction.run({observed:'rebind'})`
- **WHEN** `tryNarrative` produces the anchor body via LLM
- **THEN** the persisted anchor message contains a `## TOOL_INDEX` markdown table
- **AND** the table has 30 rows with verbatim tool_call_ids
- **AND** `compaction.tool_index.emitted` telemetry fires with `entryCount=30`
- **AND** subsequent `recall(<any of the 30 callIDs>)` returns the original output

#### Scenario: LLM omits TOOL_INDEX section

- **GIVEN** the LLM ignores the TOOL_INDEX instruction (formatting variance)
- **WHEN** post-write `validateToolIndex` scans the anchor body
- **THEN** `compaction.tool_index.missing` telemetry fires with `anchorBytes`
- **AND** the anchor still persists (compaction does not retry)
- **AND** the next turn's amnesia notice (L3) instructs the model to guess ids from the narrative

### Requirement: AI can invoke recall as a tool

The build-agent tool catalog MUST expose `recall(tool_call_id: string)` returning the original tool output text. The tool MUST be available without configuration in every build-agent session.

#### Scenario: Recall returns content for a TOOL_INDEX-listed callID

- **GIVEN** a narrative anchor with TOOL_INDEX listing `call_abc` (tool=read, output_chars=1234)
- **WHEN** the AI invokes `recall({tool_call_id: 'call_abc'})`
- **THEN** the tool returns `{title: 'call_abc', metadata: {resolvedCallID, originalToolName: 'read', redundant: false}, output: <original 1234 chars>}`
- **AND** `tool.recall.invoked` telemetry fires with `found=true`

#### Scenario: Recall fails for unknown callID

- **GIVEN** no ToolPart with the requested callID exists in the session stream
- **WHEN** the AI invokes `recall({tool_call_id: 'call_nonexistent'})`
- **THEN** the tool returns `metadata: {error: 'unknown_call_id'}` and an output advising re-execution
- **AND** `tool.recall.invoked` telemetry fires with `found=false`
- **AND** no retry storm is initiated

### Requirement: AI is told when its memory is narrative-compacted

When the most-recent anchor's kind is `narrative`, the next prompt assembly MUST inject a `system_block_amnesia_notice` block instructing the AI about the compaction state and recall affordance.

#### Scenario: Narrative anchor present, AI is informed

- **GIVEN** session has a narrative anchor as the most recent summary
- **WHEN** prompt assembly runs for the next turn
- **THEN** `promptSummary.blocks` includes a `system_block_amnesia_notice` entry with `injected=true`
- **AND** the block content includes "narrative-compacted", "TOOL_INDEX", and "recall(tool_call_id)"
- **AND** `prompt.amnesia_notice.injected` telemetry fires

#### Scenario: Hybrid_llm or server-side anchor present, no notice

- **GIVEN** session has a hybrid_llm-kind or server-side-equivalent anchor as the most recent summary
- **WHEN** prompt assembly runs for the next turn
- **THEN** `promptSummary.blocks` does NOT contain `system_block_amnesia_notice`
- **AND** no `prompt.amnesia_notice.injected` event is published

## Acceptance Checks

- [ ] Manual: run a session, force narrative compaction, inspect anchor body for `## TOOL_INDEX` section
- [ ] Manual: verify build-agent tool listing includes `recall` with correct description
- [ ] Manual: trigger narrative compaction, observe `system_block_amnesia_notice` in `bus.llm.prompt.telemetry` blocks array
- [ ] Manual: invoke `recall` on a pre-anchor callID, verify returned content matches original tool output
- [ ] Automated: vitest suite per [test-vectors.json](test-vectors.json) all green
- [ ] Automated: `bun typecheck` clean
- [ ] Telemetry: after 1 hour of production, ratio of `compaction.tool_index.emitted` to `compaction.tool_index.missing` is ≥ 95% (LLM compliance with TOOL_INDEX instruction)

## Invariants

- **INV-1**: A `tool_call_id` listed in a narrative anchor's TOOL_INDEX section MUST be resolvable by `recall(tool_call_id)` from any subsequent turn in the same session, until the next compaction supersedes the anchor.
- **INV-2**: Narrative compaction MUST NOT silently produce an anchor body without TOOL_INDEX. Missing-section emits `compaction.tool_index.missing` telemetry. (Anchor still persists; affordance degrades gracefully.)
- **INV-3**: The rebind-aware system note MUST fire if and only if the active anchor's kind is `narrative`. Other kinds (hybrid_llm, low-cost-server) preserve content via provider-side mechanisms and do not need the note.
- **INV-4**: RecallTool MUST be idempotent. Calling recall twice with the same id in the same session returns identical content; no side effects.
- **INV-5**: RecallTool MUST NOT introduce cross-session leakage. Lookup is bound to `ctx.sessionID`; subagent stream access remains via the existing internal `recallMessage` API only.
- **INV-6**: TOOL_INDEX emission MUST NOT increase anchor body size beyond `targetTokens * 1.1` (the existing post-write size ceiling in `compaction.ts:3031`). If the index would exceed the budget, oldest entries are truncated with a synthetic `[truncated N earlier entries — recall by guessing id from narrative]` placeholder. Operator-tunable.

## Behavioural contract

### L1 — TOOL_INDEX emission

- `buildUserPayload` prompt template includes:
  ```
  After the prose narrative, emit a fenced ## TOOL_INDEX section with format:
  | tool_call_id | tool_name | args_brief | status | output_chars |
  Include every pre-anchor tool call seen in JOURNAL. Preserve ids verbatim. Truncate args_brief to 80 chars.
  ```
- Post-write: `defaultWriteAnchor` calls `validateToolIndex(sanitized.body)` → counts entries via regex; emits telemetry.
- The validator MUST be tolerant of LLM formatting variance (extra whitespace, code-fence variations) — only require the `## TOOL_INDEX` marker and at least one parseable table row.

### L2 — RecallTool

- Tool id: `recall`.
- Parameters (zod): `{ tool_call_id: z.string().min(1).describe("...") }`.
- Description: ≤500 chars, instructive: "Retrieve the full original output of a prior tool call by its tool_call_id. Use when prior tool history has been narrative-compacted (you will see a notice in your context). The TOOL_INDEX section of the most recent narrative anchor lists recallable ids."
- Execute:
  1. `Memory.Hybrid.recallByCallId(ctx.sessionID, params.tool_call_id)` → `ToolPart | null`
  2. If found and ToolPart.state has output text: return `{ title: callID, metadata: { resolvedCallID, originalToolName, redundant }, output: <output text> }`
  3. If not found: return `{ title: callID, metadata: { error: "unknown_call_id" }, output: <typed error message instructing re-execution> }`
- Registered in `registry.ts` unconditionally; available to build agent.

### L3 — Rebind-aware system note

- Trigger condition: prompt assembly observes `mostRecentAnchor.kind === "narrative"` AND the anchor was written within the current session's lifetime (not loaded from cold storage of a different session).
- Block id: `system_block_amnesia_notice`.
- Block policy: `session_stable_until_next_anchor` — block re-emits on every turn until a new anchor (any kind) supersedes the current narrative one.
- Block content:
  ```
  COMPACTION NOTICE: Your tool-call history from rounds before the most recent anchor has been narrative-compacted. The TOOL_INDEX section in that anchor's body lists tool_call_ids you can retrieve via the `recall` tool. If you need to act on or verify a prior tool result, prefer recall(tool_call_id) over assuming the narrative summary is sufficient.
  ```

## API additions

- `Memory.Hybrid.recallByCallId(sessionID: string, callID: string): Promise<MessageV2.ToolPart | null>`
- `RecallTool: Tool.Info` exported from `packages/opencode/src/tool/recall.ts`
- `buildUserPayload`: behaviour change only, signature unchanged
- `applyStreamAnchorRebind`: adds metadata to its return so the prompt assembler can decide L3 injection (or L3 injection happens independently in prompt assembly by reading the anchor message directly)

## Observed events

- `compaction.tool_index.emitted` — `{sessionID, anchorId, entryCount, indexBytes}`
- `compaction.tool_index.missing` — `{sessionID, anchorId, anchorBytes}`
- `tool.recall.invoked` — `{sessionID, callID, found, redundant?, originalToolName?}`
- `prompt.amnesia_notice.injected` — `{sessionID, anchorId, anchorKind}`

All events route through existing Bus channels.
