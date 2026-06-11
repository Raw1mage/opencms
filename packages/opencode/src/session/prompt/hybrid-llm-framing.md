# `LLM_compact` Framing Prompt — Draft v1 (design-phase)

> Lives in `specs/` during design-phase. During Phase 2 implementation, this
> file is copied (or `git mv`'d) to
> `packages/opencode/src/session/prompt/hybrid-llm-framing.md` and consumed
> by `compaction.ts::runHybridLlm`.
>
> Maps to **DD-3, DD-6, DD-9, DD-11, DD-13** in `design.md`. Enforces
> **INV-2, INV-3, INV-5** in `invariants.md`.

---

## Purpose

`LLM_compact` is the single LLM call inside the hybrid-llm compaction kind. It
takes (`prior_anchor`, `journal_unpinned`, optional `pinned_zone`, optional
`drop_markers`) and returns a new anchor body that:

1. Distils the inputs into bounded plain text (`targetTokens`).
2. Re-emphasises content that the journal still actively references
   (attention-driven dilution).
3. Honours pin / drop hints when present.
4. Conforms to the provider-agnostic anchor schema (DD-11).

This file is the prompt template. The runtime fills the `{{...}}` slots from
`LLMCompactRequest`.

---

## Input wrapping (runtime → LLM provider)

The runtime sends a chat-completion request with these messages:

```
system  → §"System framing" below (Phase 1 or Phase 2 variant)
user    → §"User payload" below, populated from LLMCompactRequest
```

No tool definitions are attached. The LLM is expected to return plain assistant
text (no tool_calls, no thinking blocks for providers where that is
configurable).

---

## System framing — Phase 1 (normal path)

```
You are the Context Compactor for an AI coding assistant. Your only job is to
distil prior conversation context into a single Markdown summary that the
assistant can use as memory in subsequent turns.

You will receive:
1. PRIOR_ANCHOR — the previous compaction's output (may be empty on cold start)
2. JOURNAL — recent rounds of raw conversation since PRIOR_ANCHOR
3. (optional) DROP_MARKERS — tool_call ids whose results should NOT be carried
   forward; treat them as if their content were never present

You must output a new anchor body. Strict contract:

OUTPUT SHAPE (mandatory):
- First line, exactly: "[Context Anchor v1] generated at <ISO-8601> by
  <provider>:<model> covering rounds [<earliest>..<latest>]"
  Use the values supplied in the user payload's META block; do not invent.
- Body: plain Markdown. Use ## / ### headings, bullet lists, fenced code
  blocks for code/paths. Nothing else.
- FORBIDDEN: <thinking>, <scratchpad>, provider-specific control tokens,
  embedded JSON for tool_call or tool_result blocks, raw tool transcripts.
- TARGET SIZE: at most {{targetTokens}} tokens — this is a HARD CEILING, not
  a fill target. Extract the essence: real decisions, constraints, unfinished
  work. A genuinely useful anchor is usually ~5,000 tokens; do NOT pad to the
  ceiling. Smaller is better. Larger is a contract violation.
- DO NOT emit tool_calls or function calls. Output is text only.

CONTENT PRIORITY (in order):
1. Decisions and conclusions reached by the assistant or user (preserve
   verbatim quotes for any decision the journal still references).
2. File paths, function/symbol names, command outputs that the recent journal
   still mentions or operates on.
3. Open questions or pending tasks.
4. Errors encountered and their resolutions.
5. Lower-priority background context — compress aggressively or omit.

ATTENTION RULE:
The recent JOURNAL tells you what the assistant is currently working on.
Content the journal still references must remain vivid (specifics, names,
exact values). Content the journal has stopped touching may fade to higher
abstraction. This is the system's primary information-density mechanism;
take it seriously.

DROP RULE:
If DROP_MARKERS is non-empty, any tool_result whose tool_call id appears in
the list must be treated as absent. Do not summarise its content; do not
mention it. (The assistant has explicitly released those results.)

NO META-COMMENTARY:
Do not say "I will now summarise" or "Here is the summary". Begin with the
header line and proceed directly to content.
```

---

## System framing — Phase 2 (fail-safe, strict)

Phase 2 is invoked when Phase 1's resulting context still exceeds budget OR
`pinned_zone` exceeded its hard cap (DD-5). It additionally absorbs
`pinned_zone` into the anchor.

```
You are the Context Compactor in EMERGENCY MODE. The assistant's context
budget cannot accommodate the full conversation; you must produce a ruthlessly
compact summary.

You will receive everything Phase 1 received PLUS:
4. PINNED_ZONE — high-priority content the assistant explicitly marked for
   preservation. In this emergency mode you must absorb it into the anchor; it
   will be cleared after this call.

STRICT TARGET: at most {{phase2TargetTokens}} tokens (default 5000). Hard
ceiling. Better to omit detail than overflow.

CONTENT PRIORITY (REVISED for emergency):
1. PINNED_ZONE content — highest priority. Capture the substance even if you
   must drop other context.
2. Decisions and outstanding tasks from JOURNAL.
3. File paths and symbol names the journal recently touched.
4. Everything else — drop or compress to a single sentence.

Same OUTPUT SHAPE / FORBIDDEN / DROP / NO META-COMMENTARY rules as Phase 1.
```

---

## User payload

```
META:
  generated_at: {{iso8601_now}}
  provider: {{provider}}
  model: {{model}}
  rounds_covered: [{{earliest_round}}..{{latest_round}}]
  target_tokens: {{targetTokens}}
  phase: {{1|2}}

PRIOR_ANCHOR:
{{prior_anchor.content || "(none — cold start)"}}

JOURNAL (rounds {{earliest_round}}..{{latest_round}}):
{{for each round in journal_unpinned:}}
--- round {{roundIndex}} ---
{{render messages as: USER: ... / ASSISTANT: ... / TOOL_CALL <name> <id>: <args> / TOOL_RESULT <id>: <content> }}
{{end for}}

{{if drop_markers non-empty:}}
DROP_MARKERS: {{comma-separated tool_call ids}}
{{end if}}

{{if phase == 2 and pinned_zone non-empty:}}
PINNED_ZONE:
{{for each entry in pinned_zone:}}
--- pinned: tool '{{toolName}}' (round {{roundIndex}}, id={{toolCallId}}) ---
{{content}}
{{end for}}
{{end if}}

Produce the new anchor body now.
```

---

## Output validation (runtime side)

After receiving the LLM response, the runtime applies these checks (DD-6
sanity layer). Failure causes one stricter retry; second failure triggers
graceful degradation.

| Check                       | Rule                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Header present              | First line matches `^\[Context Anchor v1\] generated at \S+ by \S+:\S+ covering rounds \[\d+\.\.\d+\]$` |
| Size bounded                | `tokenCount(body) ≤ targetTokens * 1.10` (10% slack for tokenizer drift)                                |
| Strictly smaller than input | `tokenCount(body) < tokenCount(prior_anchor) + tokenCount(journal_input)`                               |
| No forbidden tokens         | Body does not match `<thinking>`, `<scratchpad>`, `<\|im_start\|>`, `<`, `"tool_calls":`, `"tool_use":` |
| No JSON tool blocks         | Body does not parse as JSON nor contain a balanced `{ "name": ..., "input": ... }` block at top-level   |
| Drop respected              | If DROP_MARKERS non-empty, body does not mention any of the dropped tool_call ids verbatim              |

Failed retry uses a "stricter" framing addendum prepended to the system
message:

```
PREVIOUS ATTEMPT FAILED VALIDATION:
- Reason: {{validation_failure_reason}}
You must comply with the OUTPUT SHAPE and TARGET SIZE rules exactly. Reduce
detail; cut secondary content; halve the size if necessary. Begin with the
header line and produce nothing else.
```

---

## Cross-provider compatibility notes

| Provider                        | Behaviour                                                           | Mitigation in this prompt                                                                          |
| ------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| OpenAI gpt-5.x                  | Tendency to add explanatory preambles                               | "NO META-COMMENTARY" + first-line header check                                                     |
| Anthropic Claude                | May emit `<thinking>` blocks if extended thinking enabled           | Runtime sets `thinking: { type: "disabled" }` for compaction calls; FORBIDDEN list rejects if leak |
| Codex (GPT-5 via Responses API) | Reliably text-out; concern is reasoning tokens leaking into content | Header check + token sanity catches                                                                |
| Google Gemini                   | May wrap in markdown code fences if uncertain                       | Header on first line will fail validation if wrapped → triggers stricter retry                     |

Cross-provider regression test (in `test-vectors.json` `xprovider/` slice)
verifies the same `(prior_anchor, journal)` input produces structurally
similar outputs across all four providers.

---

## Open items for build-phase tuning

- **F-1**: Decide whether `target_tokens` is communicated as a hard "you must
  not exceed" or a soft target. Current draft uses hard. Empirical tuning
  during Phase 2 implementation may relax to soft if quality regression seen.
- **F-2**: Decide whether pin/drop instructions should also include
  human-readable rationale (when human-set via admin UI). Current draft
  treats them uniformly as ids only.
- **F-3**: Multi-modal content (G-14, deferred). Phase 1 implementation strips
  non-text and adds a notice; framing here assumes text-only input.
- **F-4**: Tokenizer for size check. Current INV uses `util/token-estimate.ts`.
  Cross-provider drift is bounded by the 10% slack; if drift exceeds that for
  any provider, switch to provider-native tokenizer for that provider's
  validation step.
