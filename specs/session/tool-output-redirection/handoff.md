# Handoff — session_tool-output-redirection

## Execution Contract

- **Mode:** rebuild the redirection mechanism; behaviour-preserving for small
  results, bounding for large ones. Land R1 → R5 in order.
- **R1+R3 are the core treble-fix** (token gate + bounded-every-send): they remove
  the upstream cause of the compaction cascade. Ship them first.
- **One seam (R4)** — do not leave the per-tool redirect variants alongside the new
  seam; converge them, or it's another half-unification.
- **Token currency** — gauge in estimated tokens (reuse the existing estimator);
  never reintroduce a byte threshold for the context-budget decision.
- **Behaviour-preserving** — typical small tool results must stay inline; guard
  with tests so normal tool use is unchanged.
- **Daemon discipline (AGENTS.md/CLAUDE.md):** no self-lifecycle; restart via
  `webctl.sh restart`. XDG backup before first edit. Sync both enablement
  registries if a threshold config flag is added. Off-main via beta-workflow.
- **Co-located with `compaction/post-compaction-continuity`:** code for both lands
  in the same beta worktree (S1 already there); fetch-back together.

## Required Reads

1. This package's `design.md` (DD-1..DD-6) + `spec.md` + `data-schema.json`.
2. The incident evidence: promptTotal 247K / cacheReadFraction 0; tool outputs
   400KB + 203KB bytes; `Truncate.MAX_BYTES = 256*1024`.
3. Current surfaces: `tool/truncation.ts` (the cap + externalize), `tool/tool.ts`
   (Truncate call), `tool/registry.ts`, `tool/resolve-tools.ts`, `tool/grep.ts`,
   `tool/bash.ts` (bespoke redirects), `tool/session_recall.ts` (fetch), MCP tool
   result path.
4. Downstream relationship: `compaction/post-compaction-continuity` (this removes
   most of its trigger).

## Stop Gates In Force

- Aggressive redirection that breaks a workflow needing inline output — surface the
  threshold trade-off, don't silently over-redirect.
- A handle that cannot resolve after compaction — retention/recall gap; stop.
- MCP results bypassing the seam — the worst offender unfixed; must be covered.
- Any daemon/registry/XDG touch without the required backup/sync.

## Execution-Ready Checklist

- [ ] design.md + spec.md + data-schema.json read.
- [ ] incident evidence + current Truncate/seam surfaces read.
- [ ] XDG backed up; work in the existing beta worktree (off main).
- [ ] Baseline tool + compaction suites green before first edit.
- [ ] R3 bounded-re-send regression test written red, then green.
