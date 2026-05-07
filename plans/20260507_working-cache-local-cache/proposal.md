# Proposal — Working Cache / Local Cache

## Why

Create a per-session Working Cache layer with two cooperating tiers (L1 digest + L2 raw ledger) so AI-extracted exploration results survive runloop, compaction, and session-resume boundaries instead of being silently diluted out of context.

## Problem

Two parallel waste streams exist today:

1. **Raw toolcall results evaporate from prompt at compaction.** The data itself stays in message storage, but AI loses prompt-level access and re-runs the same Read/Grep/Glob to recover what already exists on disk.
2. **AI-synthesised digest sentences are written into assistant messages and then diluted.** A claim like "this codebase uses X at file Y" lives only in conversation context, gets compressed lossy at compaction, and is never extracted into a queryable structured form.

Compaction summary captures conversation continuity, not an evidence-backed exploration map keyed by file/topic. Large repo scans therefore get repeated after context loss.

## What Changes

### IN

- Define the two-tier cache (L1 digest, L2 raw ledger) and how each is populated, retrieved, and validated.
- Define the catch-up phasing (A: anchor replay → B: manifest awareness → C: on-demand retrieval) so post-compaction injection is awareness-level only.
- Define `recall_toolcall` and `recall_digest` tool surfaces for on-demand retrieval.
- Define the `cache-digest` fenced-block marker that lets AI emit structured digest as part of normal assistant turns.
- Define a tool-result postscript triggered after exploration sequences to nudge digest emission.
- Define MVP implementation tasks and split validation gates: L2 = engineering gate, L1 = behavioural gate.

### OUT

- Persisting raw tool outputs as a separate copy (message storage already holds them; L2 is index-only).
- Replacing `specs/architecture.md`, `docs/events/`, or formal feature specs.
- Trusting digest entries as authority for code modification — read-before-write still applies.
- Subagent → parent cache promotion (deferred to a follow-up plan after L2/L1 effect is observed).
- Memory-graph promotion / cross-session retention (deferred).
- Repo-scoped and domain-scoped entries (deferred; MVP is session-scoped only).

## Constraints

- Cache entries are advisory, not source of truth.
- Code-editing agents must still re-read evidence files before modifying code.
- Stale evidence must fail closed: omit stale digest instead of injecting incorrect context.
- No fallback mechanism may silently hide missing or invalid cache data.
- L2 must not duplicate raw output — it indexes existing message storage and stores only pointers.

## Capabilities

- **L1 digest**: AI-authored, evidence-backed, structured fact entries emitted via `cache-digest` fenced blocks; persisted under `WorkingCache.Entry` schema.
- **L2 raw ledger**: derived index over existing session message storage, keyed by tool / file path / hash / turn; no duplicated payload.
- Manifest-level post-compaction injection that surfaces the *existence* of L1/L2 without dumping their contents.
- Two retrieval tools (`recall_digest`, `recall_toolcall`) for on-demand access during a live turn.
- Fail-closed selection: invalid schema, stale evidence, and over-budget rendering omit entries instead of injecting fallback prose.

## Impact

- Reduces repeated repo exploration after compaction or session resume.
- Preserves advisory working memory without making cache entries a source of truth.
- Keeps formal architecture/spec docs as long-term knowledge authorities.
- Adds validation coverage along two independent axes: L2 engineering correctness, L1 behavioural emission rate.

## Revision History

- 2026-05-07 — Initial proposal created from user discussion after compaction.
- 2026-05-07 — Revised after design conversation. Split into L1 (digest, behavioural) + L2 (raw ledger, index-only) tiers, added catch-up A/B/C phasing and manifest-level post-compaction injection, deferred subagent / memory / cross-scope work to follow-ups.
