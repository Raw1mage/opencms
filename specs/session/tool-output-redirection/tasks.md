# Tasks — session_tool-output-redirection

Rebuild tool-output redirection token-aware, one seam, small preview. Shipped on
main (`1977aac7b`, commit `70f836a9b`); tool suite green; 3R-deployed.

## R1 — Token gate replaces the byte cap (DD-1) — SHIPPED

- [x] `Truncate.output` gates externalization in TOKENS via `ToolBudget`
      (estimateTokens, 50K cap) instead of `MAX_BYTES` (256KB).
- [x] Small results stay inline (token-gauged) — behaviour-preserving test.

## R2 — Context-adaptive headroom (DD-2) — DEFERRED (justified)

- [x] DEFERRED per DD-7: the static `ToolBudget` cap (50K) + small preview already
      drop the incident (247K → ~120K, below the 200K B-gate). Threading the live
      remaining-window into the gate (`computeForModel`, already a "later phase" in
      ToolBudget) is a refinement to revisit only if medium-result accumulation is
      observed crossing the gate. Not forgotten — documented with revisit condition.

## R3 — Small preview + handle (DD-3) — SHIPPED (core); sliding-window DEFERRED

- [x] On externalization, the inline preview is a SMALL token bound
      (PREVIEW_TOKENS=600) head/tail; full body in the output file (= the handle).
- [x] Test: a large result → ~600-token preview + "Full output saved to: <path>"
      (was up to a 256KB preview).
- [x] Sliding-window (shrink PAST under-gate inline results) + first-class-id
      handle — DEFERRED per DD-7 (root already below the gate; revisit on observed
      accumulation). Handle survives compaction as a 24h-retained readable file.

## R4 — One seam (DD-4) — SHIPPED (already converged)

- [x] Confirmed all five paths (tool.ts generic, registry, resolve-tools, grep,
      bash) already funnel through `Truncate.output`; the token+preview change
      covers them uniformly — no convergence work remained.

## R5 — MCP coverage (DD-5) — SHIPPED

- [x] MCP results flow through `tool.ts → Truncate.output`, so they are covered by
      the same seam change (no separate MCP path / bypass).

## Validation / exit

- [x] Tool suite (truncation 4/0, budget 19/0) + touched compaction suites green (98/0).
- [x] Regression tests (token gate; large→small preview+handle; previewTokens
      override; CJK-heavy result over the token cap externalizes under old byte cap).
- [x] XDG backup; restart via `webctl.sh restart`; no new enablement flag.
- [x] Live fetch-back: deployed; large tool results no longer balloon promptTotal,
      removing the cold B-compaction loop trigger.
