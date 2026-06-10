# Proposal: session_tool-output-redirection

## Why

Incident `ses_14d8b1edeffegiR0uf52A2ZbT8` (docxmcp, claude-cli) bloated to a
**247K-token fully-cold prompt** (`cacheReadFraction: 0`). The bulk was tool-call
results from document processing carried inline in the conversation and re-sent
on every cold turn. This is the UPSTREAM root that triggers a cascade:

- inline tool bloat → promptTotal crosses the claude cold-cache B-compaction gate
  (200K tokens) → a narrative compaction fires;
- compaction can only shrink conversation (8.3K → 2.6K here) — it cannot touch the
  re-sent tool bulk → the next cold turn is still over the gate → it re-fires
  ("又發生了") → repeated pointless amnesia.

A redirection mechanism already EXISTS but is partial and mis-built:

- `Truncate.output` (tool/truncation.ts) only externalizes a result when it
  exceeds **256 KB BYTES or 2000 lines**; under that, the full result is inlined
  and re-sent every turn.
- The threshold is in **bytes**, but everything it should protect — the context
  window, the compaction gate, promptTotal — is in **tokens**. A byte cap's token
  impact drifts with content (CJK / base64 / structured JSON differ), so it does
  not actually bound the token budget.
- The same "redirect to <path>" pattern is re-implemented separately in
  `truncation.ts`, `grep.ts`, `bash.ts`, `registry.ts`, `resolve-tools.ts` — no
  single seam, no first-class handle; the "handle" is a raw filesystem path plus a
  prose "use Read/Grep" hint.
- Redirection only changes the turn it was produced; nothing guarantees a large
  result stays bounded on EVERY subsequent re-send.

## Original Requirement Wording (Baseline)

- "不可壓的東西暴漲那麼大，這也是很大的威脅。我猜應該是toolcall的result…這又牽扯到toolcall result是不是要用redirection link的問題"
- "你說的K是token數還是byte數？" → confirmed the cap is bytes; the budget is tokens (unit incoherence).
- "這個tool part redirection的機制要重建完整。並且其他抓到的bug一併修好"

## Requirement Revision History

- 2026-06-11: initial draft; rebuild tool-output redirection token-aware + context-adaptive.

## Effective Requirement Description

1. Tool-output size is governed in TOKENS (context-window currency), not bytes.
2. A large tool result is externalized and carried as a bounded handle + preview
   on EVERY send (not just the turn it was produced), so cold re-sends stay small.
3. One coherent redirection seam with a first-class, re-accessible handle (fetch
   on demand), replacing the scattered per-tool variants.
4. MCP tool results (the worst offenders) flow through the same seam.
5. The externalization threshold adapts to context pressure (tighter as the
   window fills).

## Scope

### IN
- Token-based + context-adaptive externalization threshold (replaces 256KB bytes).
- A single redirection seam + first-class tool-output handle the model re-accesses.
- Coverage of built-in tools AND MCP tool results.
- Bounded re-send: a redirected result never re-inflates the prompt on later turns.

### OUT
- The post-compaction symptom fixes (telemetry misreport, mid-task strand, B-gate
  on incompressible total) — owned by `compaction/post-compaction-continuity`
  (this plan removes most of their trigger; they remain as the safety layer).
- Changing the recall tool's API surface beyond what a handle fetch needs.

## Non-Goals

- Compressing/altering tool-result content semantics (only how it's carried).
- Tuning compaction thresholds (handled in the downstream plan).

## Constraints

- Behaviour-preserving for small tool results (inline as today, just token-gauged).
- No daemon self-lifecycle; restart via `webctl.sh restart`. XDG backup before
  first edit. Both enablement registries synced if a flag is added.
- Implement off-main via beta-workflow. Default: no PR.

## What Changes

- Tool-output governance moves from a byte cap to a token + context-adaptive gate.
- The scattered redirect-to-path variants converge to one seam with a handle.
- Large results are bounded in the prompt on every turn, not just at creation.

## Capabilities

### New Capabilities
- Token-aware, context-adaptive tool-output externalization.
- A first-class re-accessible tool-output handle (stable across re-sends/compaction).

### Modified Capabilities
- `Truncate.output`: token/context-gauged instead of fixed 256KB bytes.
- Built-in + MCP tool result handling: one redirection seam.

## Impact

- `packages/opencode/src/tool/truncation.ts` (threshold unit + seam)
- `packages/opencode/src/tool/tool.ts`, `registry.ts`, `resolve-tools.ts`,
  `grep.ts`, `bash.ts` (converge on the seam)
- MCP tool result path (ensure coverage)
- `packages/opencode/src/tool/session_recall.ts` (handle fetch)
- token estimation util (reuse existing)
- Downstream: removes most triggers for `compaction/post-compaction-continuity`.
