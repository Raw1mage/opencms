# Errors — session_tool-output-redirection

## Error Catalogue

Failure modes this rebuild removes or guards:

| Failure (today) | Class | Cause | Fix | Slice |
|---|---|---|---|---|
| Prompt balloons on inline tool bulk | budget-overrun | byte cap (256KB) too high + wrong unit | token gate | R1 |
| Same result fine when empty, fatal when full | non-adaptive | fixed threshold ignores headroom | context-adaptive gate | R2 |
| Large result re-sent in full every cold turn | re-send bloat | redirection only at creation, not every send | bounded handle every send | R3 |
| Scattered, inconsistent redirect logic | drift | per-tool variants | one seam | R4 |
| MCP document results bypass governance | coverage gap | MCP path may not hit the seam | force MCP through the seam | R5 |
| Handle unresolvable after compaction | liveness | retention/recall gap | handle survives anchor collapse | R4 |

## Failure-handling principles

- **Token is the currency.** The context budget is in tokens; the gate must be too.
  A byte threshold is a category error for a token budget.
- **Bound on every send, not once.** Externalizing only at creation does not stop
  the re-send bloat — the prompt serializer must emit the handle every turn.
- **One seam.** Converging the redirect variants is part of the fix; leaving them
  alongside the new seam is another half-unification.
- **Don't strand the data.** A redirected result must remain fetchable (handle
  resolves) even after a compaction collapses its turn — externalization must never
  lose the content, only move it out of the hot prompt.
- **Preserve small-result behaviour.** Over-redirecting forces needless fetch
  round-trips; the gate's floor keeps typical small outputs inline.
