# Spec: session_tool-output-redirection

## Purpose

Bound how much a tool result costs the context window: govern it in tokens,
externalize large results behind a re-accessible handle, and carry only that
handle on every send so a document-sized result cannot bloat (and re-bloat) the
prompt or trigger a compaction cascade.

## Requirements

### Requirement: Tool output is governed in tokens, not bytes
The externalization threshold MUST be expressed and evaluated in estimated tokens,
not a fixed byte count.

#### Scenario: same byte size, different token cost
- GIVEN two tool results of equal bytes but different token density (e.g. ASCII vs
  CJK/base64)
- WHEN the redirection seam evaluates them
- THEN the decision tracks their estimated TOKEN cost, not their byte length.

### Requirement: Externalization adapts to context headroom
A result MUST be externalized when its estimated tokens exceed the smaller of an
absolute floor and a fraction of the remaining context window; the gate tightens
as the window fills.

#### Scenario: same result, different pressure
- GIVEN a result of N tokens, below the floor
- WHEN context is nearly empty THEN it stays inline
- WHEN context is nearly full THEN it is externalized.

### Requirement: A redirected result is bounded on every send
Once externalized, the prompt MUST carry only a bounded handle + preview for that
result on EVERY subsequent turn — never the full body again.

#### Scenario: cold re-send after redirection
- GIVEN a redirected large result earlier in the conversation
- WHEN a later (cold) turn re-sends the conversation
- THEN that result contributes only its bounded handle+preview to promptTotal.

### Requirement: One seam covering built-in and MCP tools
All tool results (built-in AND MCP) MUST pass through one redirection seam; the
handle is a stable id the model re-accesses on demand and that survives compaction.

#### Scenario: MCP document result
- GIVEN an MCP (e.g. docxmcp) result above the token gate
- WHEN it returns
- THEN it is externalized via the same seam and re-accessible by handle.

## Acceptance Checks

- Threshold evaluated in estimated tokens; byte cap removed/retired.
- Headroom-adaptive gate: a fixed-size result inlines when empty, externalizes when full.
- A redirected result's later-turn prompt contribution is the handle+preview only.
- MCP results flow through the seam (no bypass).
- Handle resolves after a compaction that collapsed the producing turn.
- Small results stay inline (behaviour-preserving); tool suite green.
