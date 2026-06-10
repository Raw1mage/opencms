# Design: session_tool-output-redirection

## Context

Rebuild the tool-output redirection mechanism so a single large tool result (or
an accumulation of them) cannot bloat the prompt and trigger the downstream
compaction cascade. The current mechanism (`Truncate.output` + per-tool variants)
externalizes only above 256 KB bytes / 2000 lines, in the wrong unit, with no
single seam and no bounded re-send guarantee. Evidence: a docxmcp session sent a
247K-token fully-cold prompt dominated by inline document tool results; the cold
B-compaction fired and could not shrink the tool bulk, looping.

## Goals / Non-Goals

### Goals
- Govern tool-output size in TOKENS, adaptive to context pressure.
- A large result is carried as a bounded handle + preview on EVERY send.
- One redirection seam + a first-class re-accessible handle.
- Cover built-in AND MCP tool results.

### Non-Goals
- Altering tool-result semantics/content.
- Tuning compaction thresholds (downstream plan).
- Replacing the recall tool wholesale (only add a handle fetch).

## Decisions

- **DD-1 — Token, not byte.** Replace `MAX_BYTES = 256*1024` with a token budget.
  Gauge results with the existing token estimator. A byte cap's token impact
  drifts with content; the budget being protected (window, compaction gate,
  promptTotal) is token-denominated, so the gate must be too.

- **DD-2 — Context-adaptive threshold.** The externalization point is a fraction
  of the active model's context window, tightening as the window fills (e.g.
  externalize a result above X% of remaining headroom). A result that's fine at 5%
  context is redirected at 60%. Absolute floor/ceiling guard the extremes. (The
  exact curve — fixed % vs piecewise vs headroom-relative — finalized in design
  review; default proposal: redirect when a single result > min(absoluteFloor,
  headroomFraction * remainingWindow).)

- **DD-3 — Bounded on EVERY send, not just at creation.** Two sub-findings from
  the code:
  1. **The preview is the real bloat.** `Truncate.output` already externalizes the
     full body to a file when over cap, BUT the inline preview it keeps is bounded
     by the SAME limit (256KB / 2000 lines) — so a 400KB result becomes a ~256KB
     preview, still re-sent every turn. The preview MUST be a small token bound
     (head/tail, e.g. a few hundred tokens), independent of the externalize trigger.
  2. **Accumulation needs a sliding window.** Even token-gated, multiple sub-budget
     results stay inline-full and accumulate (the 247K was an accumulation, not one
     blob). Resolution: the ACTIVE turn's result may stay inline up to budget (the
     model needs to see what it just got), but PAST-turn large results are carried
     as small preview + handle on every subsequent send. The prompt serializer
     shrinks a past redirected part to preview+handle, never the full body.
  Foundation: this reuses the EXISTING `ToolBudget` (tool/budget.ts —
  `estimateTokens` CJK-aware + `computeForModel` context-adaptive, default
  absoluteCap 50K tokens) already used by grep/webfetch/glob; the gap is that the
  generic + MCP path (`Truncate.output`, byte-capped) does not use it and keeps a
  byte-capped preview. So this plan extends `tool-output-chunking`'s ToolBudget to
  the generic/MCP seam + shrinks the preview, rather than building anew.

- **DD-4 — One seam + a first-class handle.** Converge `truncation.ts`,
  `grep.ts`, `bash.ts`, `registry.ts`, `resolve-tools.ts` onto one redirection
  function. The handle is a stable tool-output id (not a raw fs path string) that
  the model re-accesses via a dedicated fetch (Read/Grep by handle, or a
  recall-by-handle affordance), and that survives compaction (so post-amnesia the
  agent can still pull the full result).

- **DD-5 — MCP coverage.** MCP tool results (docxmcp etc. — the worst offenders)
  must flow through the same seam. Verify the MCP result path reaches the seam
  (it currently goes through `tool.ts` Truncate unless self-truncating) and is
  token-gauged identically.

- **DD-6 — Relationship to compaction (downstream).** With DD-1..DD-3 bounding
  promptTotal, the claude cold-cache B-compaction is no longer falsely triggered
  by tool bloat — this resolves the D3 cascade at its root, so the downstream
  `compaction/post-compaction-continuity` DD-4 (B-gate on incompressible total)
  becomes hygiene rather than load-bearing. The downstream telemetry fix (S1,
  shipped) and mid-task resume (S3) remain as the safety layer for compactions
  that are genuinely warranted.
- **DD-7**: DD-7 (implementation outcome / scope closure). R1+R3-core shipped: Truncate.output (the ONE seam all paths already funnel through — tool.ts generic, registry, resolve-tools, grep, bash) now gates externalization in TOKENS via ToolBudget (CJK estimator, 50K cap) and keeps a SMALL token-bounded preview (PREVIEW_TOKENS=600) with the full body behind the output-file handle. Consequences for the rest of the plan: (R4) ALREADY one seam — confirmed all five call sites route through Truncate.output, so no convergence work remained; the token+preview change covers them uniformly. (R5) MCP results flow through tool.ts→Truncate.output, so they are covered by the same change — no separate MCP path. (R3 sliding-window — shrink PAST under-gate inline results) DEFERRED as justified, not forgotten: the incident's 247K was dominated by two large results that, with the small-preview change, drop from ~256KB previews (~2×64K tokens) to ~600 tokens each → promptTotal falls to ~120K, below the 200K B-gate. So R1+R3-core already removes the cascade without a sliding window; the window is a refinement to revisit only if medium-result accumulation is observed to cross the gate in practice. Handle survives compaction because it is a 24h-retained output file readable by Read/Grep anytime (first-class-id upgrade deferred with the sliding window).

## Architecture

```
tool runs → result.output
        │
        ▼
  redirection seam (one function, token-gauged, context-adaptive)   ← DD-1/DD-2/DD-4
        │
        ├── small (under budget): inline as today
        └── large: write full body to output store; return {handle, preview}
              │
              ▼
        conversation part records {handle, preview}                  ← DD-3
              │
   prompt serializer: emit handle + preview EVERY send (never full body)
              │
        model fetches full body on demand via handle (Read/Grep/recall)  ← DD-4
```

## Critical files

- `packages/opencode/src/tool/truncation.ts` — the seam; token+context gauge.
- `packages/opencode/src/tool/tool.ts` / `registry.ts` / `resolve-tools.ts` —
  route all results through the seam (remove per-tool variants).
- `packages/opencode/src/tool/grep.ts` / `bash.ts` — fold their bespoke redirect
  into the seam.
- MCP tool result path — ensure coverage (DD-5).
- prompt/conversation serializer — emit handle, not full body, for redirected
  parts on every send (DD-3).
- `packages/opencode/src/tool/session_recall.ts` — fetch-by-handle (DD-4).
- token estimation util — reuse.

## Risks / Trade-offs

- **More fetch round-trips** — aggressive redirection means the model reads more
  often. Mitigate with a useful preview (head/tail + shape) so most turns don't
  need the full body. The threshold tuning (DD-2) governs this trade-off.
- **Handle survival across compaction** — the handle must resolve after an anchor
  collapses the producing turn; the output store retention (currently 24h) and the
  recall path must cover it.
- **Behaviour change for small results** — must stay inline (token-gauged ≈ today
  for typical small outputs); guard with tests so normal tool use is unchanged.
- **MCP path divergence** — if MCP results bypass the seam, the worst offender is
  unfixed; DD-5 explicitly verifies coverage.
