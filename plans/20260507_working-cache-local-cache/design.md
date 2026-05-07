# Design — Working Cache / Local Cache

## Context

OpenCode already has three adjacent context surfaces:

- Message-stream compaction anchors: durable conversation continuity, derived from assistant summaries.
- `SharedContext`: small per-session file/action workspace, budgeted and coarse.
- `PostCompaction` providers: recovery addendum for runtime state such as todolist and in-flight subagents.

Working Cache fills the gap between raw tool output and formal docs: per-session, evidence-backed exploration memory that survives compaction or session resume without requiring re-scans.

The design splits along the two waste streams identified during refinement:

1. **Raw toolcall results** persist on disk in `Session.messages`, but the AI loses prompt-level access after compaction. Indexing — not duplication — closes the gap.
2. **AI-synthesised digest** (the "I learned X" sentences) lives only in conversation prose and dilutes / lossy-compresses across compaction. Closing this gap requires behavioural change at toolcall return time, not storage change.

## Goals

- Persist AI-extracted reusable facts from exploration with evidence refs and invalidation triggers (L1).
- Index existing toolcall message storage so AI can re-discover what it already saw (L2).
- Inject only awareness-level manifest at post-compaction; defer details to on-demand retrieval.
- Keep formal docs as long-term architecture truth; cache entries remain advisory.

## Non-Goals

- Automatic trust of stale cache entries.
- Raw toolcall payload duplication into a sidecar store.
- Silent fallback when cache validation or indexing fails.
- Replacement of read-before-write rules for code edits.
- Subagent ↔ parent cache promotion (deferred follow-up).
- Memory-graph / cross-session promotion (deferred follow-up).
- Repo-scoped or domain-scoped entries (deferred follow-up; MVP is session-scoped only).

## Decisions

### Tier Architecture

- **DD-1** Working Cache is a two-tier system. **L1 = digest** (AI-authored, dense, lossy, behavioural). **L2 = raw ledger** (mechanical index over message storage, ground-truth, populated automatically). Both derive independently from the same source (raw `ToolPart` records); L1 is *not* a subset of L2.
- **DD-2** L1 retrieval is the **first-priority** path for AI re-orientation. AI consults digest first; falls to L2 raw ledger when digest is insufficient or untrustworthy; falls to fresh toolcall when L2 lookup misses or evidence is stale.
- **DD-3** L1 entries always carry pointers to source evidence. Modifying-class actions (Edit, Write, commit) require fresh evidence verification — L1 alone never authorises a write.
- **DD-4** Storage strategy is asymmetric:
  - **L1** persists structured `Entry` records via existing `Storage.read/write` JSON namespace (this is what current `working-cache.ts` already does).
  - **L2** is a *derived view* over `Session.messages`. MVP may compute it lazily on every retrieval; if hot-path performance matters later, a sidecar index can cache the derivation. Either way, the canonical data lives in message storage — L2 stores no payload.

### Catch-up Phasing

- **DD-5** Cache exposure follows three phases when AI rejoins or restarts:
  - **Phase A (anchor + tail replay)**: cache is invisible. Only conversation continuity matters.
  - **Phase B (control acquired)**: cache emits a *manifest* — count, kind, topic labels, retrieval tool names. No facts, no hashes, no contents. Token budget bounded ≤ ~120 tokens regardless of cache size.
  - **Phase C (action)**: AI calls `recall_digest` / `recall_toolcall` on demand when a specific need arises.
- **DD-6** Post-compaction `WorkingCacheProvider` renders Phase B manifest only. The previous full-table render is replaced by the manifest form to preserve catch-up phasing.

### Population Mechanisms

- **DD-7** L2 is populated by an automatic post-tool hook in `tool-invoker.ts`. Every read-class tool call (Read, Grep, Glob, and exploration-class Bash patterns) produces an L2 index entry. Hook captures `(toolCallID, toolName, args_summary, file_path?, output_hash?, mtime?, turn, message_ref)` — never a payload copy.
- **DD-8** L1 is populated by behavioural change at the AI side, not by storage hooks:
  - `tool-invoker` tracks "exploration-sequence depth" — a counter that increments on read-class tools and resets on modify-class or non-tool turns.
  - When depth ≥ threshold (default 3), the **next tool-result rendering** appends a postscript inviting the AI to emit a `cache-digest` fenced block if a reusable fact crystallised.
  - A turn-end parser scans the assistant message for `cache-digest` fenced blocks, validates against `Entry` schema, and writes through `WorkingCache.record()`.
- **DD-9** The `cache-digest` fenced block is the **single canonical L1 emission format**. No separate `cache_record` tool is added in MVP — the fenced-block path avoids a tool round-trip and keeps L1 emission inside the natural assistant turn.

### Retrieval Tools

- **DD-10** Three retrieval tools are exposed to AI under the `system-manager:` namespace, forming a `recall_toolcall_*` family:
  - `system-manager:recall_toolcall_index({ since_turn?, kind? }) → { l2: { total, by_kind, by_file_count }, l1: { total, topics }, retrieval: { raw, digest } }`. Returns the same content shape as the post-compaction manifest, on demand. No fact bodies, no hashes, no path enumeration.
  - `system-manager:recall_toolcall_raw({ kind?, path?, hash?, turn_range?, include_body? }) → { found, toolCallID?, toolName?, args_summary?, file_path?, hash?, mtime?, message_ref?, age_turns?, body? }`. `found: false` is a normal return; never throws on miss. See DD-21 for `include_body` semantics.
  - `system-manager:recall_toolcall_digest({ topic?, entry_id?, evidence_path? }) → { entries: Entry[], omitted: { entry_id, reason }[] }`. Stale entries are omitted with explicit reason.
- **DD-11** All three tools have system-prompt usage examples in their tool descriptions, and each description points to its sibling tools. Without examples AI tends to skip them; instruction-following is unreliable for "novel" tool patterns absent demonstrations. Cross-references in descriptions help AI move from `_index` (discover) → `_raw` / `_digest` (drill in) naturally.
- **DD-21** `recall_toolcall_raw` accepts an optional `include_body: boolean` flag (default `false`).
  - `false` (default) returns pointer-only metadata at the cheap `~80–150 token` cost.
  - `true` causes the server to fetch the original `ToolPart.output` from `Session.messages` storage and inline it into the response. **No payload is duplicated into L2** — the body is loaded on demand from the source-of-truth message store. This preserves INV-2 while resolving the simulation-discovered gap that AI cannot otherwise follow a pointer back to message contents.
  - Body size is naturally bounded by the original `ToolPart` payload; no further truncation is performed in MVP.
- **DD-22** Cache awareness is exposed through three layered surfaces, each with a distinct purpose. They are non-overlapping in cost and coverage:
  - **Tool list (system prompt, always-on)**: tool definitions for `recall_toolcall_index` / `_raw` / `_digest` are part of the standard tool list. Marginal cost = 0 (tool list is paid anyway). Communicates "these tools exist" at every turn.
  - **Post-compaction manifest (one-shot per compaction)**: `WorkingCacheProvider` renders the Phase B manifest into the compaction summary addendum. ~110 tokens, fired once per compaction event. Communicates "current concrete state" at the highest-value catch-up moment.
  - **`recall_toolcall_index` (on-demand)**: AI may invoke at any time to refresh awareness mid-session. ~130 tokens per call. Used when post-compaction manifest is no longer salient (deep into a long turn) or when a long session has not yet hit compaction.
  - Turn-start auto-injection is explicitly rejected: linear-growth cost vs. infrequent need fails the ROI test.

### Failure Discipline

- **DD-12** Cache read is fail-closed. Invalid schema, stale required evidence, missing project scope, or over-budget rendering omits the entry and emits observability; it does not inject partial fallback prose.
- **DD-13** L2 indexing failure surfaces explicitly via debug checkpoint and metric. Indexing must not be wrapped in a silent try/catch — a failed index is observable, not invisible.
- **DD-14** When AI emits a malformed `cache-digest` fenced block, the parser fails the entry write and surfaces an explicit error in the next turn so AI can correct format. No silent drop.

### Lineage and Lifecycle

- **DD-15** Working Cache is an append-only digest ledger. Consecutive toolcall chains such as read → modify may record multiple entries; later entries can reference earlier ones through `derivedFrom` / `supersedes`, and retrieval prefers the latest non-stale modifying entry while keeping prior entries available for traceability.
- **DD-16** Cache expiration is a separate policy layer. MVP records timestamps, operation kind, and invalidation hints; automatic TTL/compaction/deletion strategy is deferred until after read/write recovery behavior is proven.

### Deferred (Out of MVP)

- **DD-17** Memory Graph integration is a promotion/retrieval layer, deferred until L1/L2 behaviour is validated. `/memory` would store canonical cross-session entities/relations only when explicitly promoted from a stable L1 entry. Not in MVP.
- **DD-18** Subagent → parent cache promotion is deferred. Subagents currently write into their own session scope; their cache dies with their session. A follow-up plan will design the promotion protocol after MVP observation.
- **DD-19** Repo-scoped and domain-scoped entries remain in the schema (current `working-cache.ts` already supports them) but MVP only exercises `kind: "session"`. Cross-session validation tests are out of scope.
- **DD-20** MCP local environment normalisation (previously DD-9 / DD-10 in earlier revision) is unrelated to L1/L2 design and is tracked separately; it remains a blocking precondition for memory-graph promotion if and when that follow-up activates.

## Core Data Model

### WorkingCacheEntry (L1)

- **Name**: `WorkingCacheEntry`
- **Represents**: one AI-authored reusable exploration digest for a session/repo/domain scope.
- **Input**: exploration purpose, searched/read files, operation kind, facts, evidence refs, invalidation triggers, lineage links, unresolved questions.
- **Output**: a structured digest record retrievable via `recall_digest`.
- **Not**: raw tool output, formal architecture truth, or permission to edit files without re-reading evidence.
- **Complete when**: schema-valid, has at least one fact, at least one evidence ref, and a session scope.

### EvidenceRef

- **Name**: `EvidenceRef`
- **Represents**: a concrete source backing a cached fact.
- **Input**: file path, optional line range, observed hash/mtime, evidence kind.
- **Output**: validation signal for stale checks and rendered citation.
- **Not**: a guarantee that the cited source still means the same thing after code changes.
- **Complete when**: path is absolute or repo-relative, kind is declared, and at least one freshness signal exists.

### InvalidationTrigger

- **Name**: `InvalidationTrigger`
- **Represents**: condition that makes an entry unsafe to inject.
- **Input**: path pattern, exact evidence hash mismatch, max age, spec state mismatch, or explicit manual invalidation.
- **Output**: `valid | stale | unknown` decision for entry selection.
- **Not**: fallback rescue; unknown must be treated as non-injectable for automatic recovery.
- **Complete when**: the trigger is machine-checkable or explicitly marked manual-review-only.

### LedgerEntry (L2, derived)

- **Name**: `LedgerEntry`
- **Represents**: one indexed toolcall in the session's message storage.
- **Input**: derived from `ToolPart` — `toolCallID`, `toolName`, `args_summary`, optional `file_path`, optional `output_hash`, optional `mtime`, `turn`, `message_ref`.
- **Output**: a pointer record returned by `recall_toolcall`.
- **Not**: a copy of raw tool output, not a digest, not a freshness oracle for non-file evidence.
- **Complete when**: `toolCallID` and `message_ref` resolve to an existing `ToolPart` in storage.

## Lifecycle

1. **Explore**: agent uses normal search/read/task tools.
2. **Auto-index (L2)**: tool-invoker post-hook records a `LedgerEntry` referencing the just-completed toolcall.
3. **Prompt nudge**: if exploration-sequence depth crossed threshold, last tool result carries a postscript inviting digest emission.
4. **Digest (L1)**: agent optionally emits a `cache-digest` fenced block in its assistant turn.
5. **Validate**: turn-end parser checks fenced-block format and `Entry` schema.
6. **Store (L1)**: validated entry is written under session namespace via `WorkingCache.record()`.
7. **Link**: entries may point to prior entries with `derivedFrom` / `supersedes`.
8. **Manifest at catch-up**: post-compaction provider emits Phase B manifest (count + kind + topics), no contents.
9. **On-demand retrieve**: agent calls `system-manager:recall_toolcall_index` to refresh awareness, then drills into `system-manager:recall_toolcall_raw` (with optional `include_body: true`) or `system-manager:recall_toolcall_digest` when a specific need arises during action.
10. **Verify before modify**: any Edit/Write derived from a cache hit re-checks evidence freshness or re-reads the file directly.
11. **Promote (deferred)**: stable long-term facts are manually moved into `specs/architecture.md` or feature specs; `/memory` promotion deferred to a follow-up plan.
12. **Expire**: stale/old entries are omitted or marked invalid; automatic expiration policy is deferred.

## Read / Write Boundaries

- **L1 write boundary**: `WorkingCache.record()` is invoked by the turn-end parser only. No tool-side automatic L1 writes; no other code path may bypass the parser.
- **L1 read boundary**: `system-manager:recall_toolcall_digest` (live turn), `system-manager:recall_toolcall_index` (count + topic listing), and `WorkingCacheProvider` (post-compaction manifest) are the only consumers in MVP.
- **L2 write boundary**: tool-invoker post-hook is the sole writer. No agent-callable surface mutates the ledger.
- **L2 read boundary**: `system-manager:recall_toolcall_raw` (live turn), `system-manager:recall_toolcall_index` (count + kind aggregation), and `WorkingCacheProvider` (manifest counts) are the only consumers.
- **Storage boundary**: existing `Storage.read/write` provides L1 persistence; L2 derives from `Session.messages`. `WorkingCache` owns L1 keys/schema; L2 owns its index keys and stays read-mostly.
- **Evidence boundary**: file freshness checks use repo file metadata/hash when available and fail closed when unavailable. `tool-result` and `subagent-result` evidence kinds must carry `max-age-ms` or capture timestamp; the previous unconditional `return true` freshness path is replaced.

## Catch-up Manifest Format

The Phase B manifest emitted at post-compaction looks like:

```
Working Cache available this session:
- L2 ledger: 12 toolcall results indexed across 8 files (3 reads, 4 greps, 5 edits)
  Use `recall_toolcall` to query by file path or hash.
- L1 digest: 3 entries (topics: working-cache-design, mcp-launch-env, post-compaction-flow)
  Use `recall_digest` to fetch by topic or entry_id.

Drill in only when a specific need arises. Modifying actions still require fresh evidence verification.
```

Token budget: ≤120 tokens. Counts and topic labels only. Never fact bodies, never hashes, never paths beyond a single example.

## Risks

- **Digest hallucination** (L1): mitigated by requiring evidence refs in `cache-digest` blocks and rejecting blocks without them; spot-check during validation.
- **Stale cache injection**: mitigated by fail-closed validation on every retrieval path.
- **Manifest bloat**: mitigated by fixed Phase B token budget; counts and topic labels stay bounded.
- **Confusing cache with docs**: mitigated by explicit advisory framing in manifest and `recall_*` responses, plus deferred memory promotion.
- **Behavioural failure of L1**: explicit risk acceptance — L1 emission rate is observed during validation and may require iterative prompt tuning. L2 stands alone if L1 underperforms.
- **L2 indexing latency**: mitigated by storing only pointers (no payload copy) and computing hash lazily where possible.

## Critical Files

- `packages/opencode/src/session/working-cache.ts` — L1 schema, store, and selection (already implemented; MVP work refines manifest render and adds L2 query).
- `packages/opencode/src/session/post-compaction.ts` — `WorkingCacheProvider` switches to manifest form.
- `packages/opencode/src/session/tool-invoker.ts` — adds L2 post-hook and exploration-sequence depth tracking, exploration-class tool classification, postscript injection.
- `packages/opencode/src/tool/tool.ts` — `kind: "exploration" | "modify" | "other"` metadata field.
- `packages/opencode/src/tool/system-manager/recall_toolcall_index.ts` — new tool surface (manifest on demand).
- `packages/opencode/src/tool/system-manager/recall_toolcall_raw.ts` — new tool surface (L2 pointer + optional body via `include_body`).
- `packages/opencode/src/tool/system-manager/recall_toolcall_digest.ts` — new tool surface (L1 digest retrieval).
- `packages/opencode/src/session/message-v2.ts` — turn-end fenced-block parser hook.
- `packages/opencode/src/session/shared-context.ts` — boundary check (no overlap with L1/L2).
- `packages/opencode/src/session/compaction.ts` — no behavioural change; only the provider it calls moves to manifest form.
- `packages/opencode/src/storage/storage.ts` — unchanged; existing JSON namespace serves L1 persistence.
