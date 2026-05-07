# Spec — Working Cache / Local Cache

## Purpose

Working Cache preserves reusable AI-extracted exploration results across context-loss boundaries through two cooperating tiers — L1 digest (AI-synthesised, dense) and L2 raw ledger (mechanically indexed, ground-truth) — while retaining source code and formal docs as authority.

## Tier Definitions

- **L1 cache (digest)** — AI-authored, evidence-backed, structured fact entries. Smaller, higher signal density, populated by behavioural change (system prompt + fenced-block emission). May be lossy or wrong; must always carry pointers back to L2 / source files for verification.
- **L2 cache (raw ledger)** — Index over existing session message storage, keyed by tool / file path / hash / turn. Larger, lower signal density per entry, populated mechanically (zero new payload duplication). Authoritative within its scope.
- **Source of truth** — `Session.messages` storage (raw `ToolPart` records) and the actual repository files. L1 and L2 both derive from these; neither replaces them.

## Catch-up Phasing

The cache must respect a three-phase catch-up flow when a session resumes or a turn restarts:

- **Phase A — anchor + tail replay**: AI rebuilds conversation progress. Cache must not appear here.
- **Phase B — control acquired**: AI must gain *awareness* that L1/L2 exist (counts, kinds, topic labels) without being shown contents. Awareness reaches AI through three non-overlapping surfaces: the tool list (always present in system prompt), the post-compaction manifest (one-shot at compaction), and the `system-manager:recall_toolcall_index` tool (on demand, mid-session).
- **Phase C — on-demand retrieval**: AI calls `system-manager:recall_toolcall_index` (refresh awareness), `system-manager:recall_toolcall_raw` (L2), or `system-manager:recall_toolcall_digest` (L1) only when a specific need arises during action.

### Requirement: Catch-up Manifest at Phase B

- **GIVEN** post-compaction recovery or session resume runs
- **WHEN** the Working Cache provider renders into the recovery context
- **THEN** it emits a *manifest* listing only count, kind, and topic labels — not facts, hashes, or contents
- **AND** the manifest names the retrieval tools (`system-manager:recall_toolcall_index`, `system-manager:recall_toolcall_raw`, `system-manager:recall_toolcall_digest`) so AI knows how to drill in
- **AND** total manifest size stays under a fixed token budget regardless of cache growth

### Requirement: On-Demand Manifest Retrieval

- **GIVEN** AI needs to refresh awareness of cache state mid-session (long turn after the post-compaction manifest is no longer salient, or before any compaction has fired)
- **WHEN** it calls `system-manager:recall_toolcall_index({ since_turn? , kind? })`
- **THEN** it returns `{ l2: { total, by_kind, by_file_count }, l1: { total, topics }, retrieval: { raw, digest } }`
- **AND** the response carries no fact bodies, no hashes, no path enumeration — same content shape as the post-compaction manifest
- **AND** the response names the sibling retrieval tools so AI naturally drills downward

### Requirement: On-Demand Retrieval (L2)

- **GIVEN** AI needs a previously-seen file or toolcall result during a live turn
- **WHEN** it calls `system-manager:recall_toolcall_raw({ kind, path? , hash? , include_body? })`
- **THEN** L2 returns `{ found: true, toolCallID, hash, mtime, message_ref, age_turns, body? }` or `{ found: false }`
- **AND** by default `include_body` is `false` and the response is pointer-only
- **AND** when `include_body: true`, the server fetches the original `ToolPart.output` from `Session.messages` and inlines it; no payload is duplicated into L2
- **AND** "not found" is a normal return value, never an error

### Requirement: On-Demand Retrieval (L1)

- **GIVEN** AI needs a prior digest during a live turn
- **WHEN** it calls `system-manager:recall_toolcall_digest({ topic? , entry_id? , evidence_path? })`
- **THEN** L1 returns matching entries with their facts, evidence refs, and lineage links
- **AND** stale entries are omitted (fail closed) with their omission reason returned alongside

### Requirement: Record Evidence-Backed L1 Digest

- **GIVEN** an agent has completed meaningful repo exploration and wishes to preserve a reusable claim
- **WHEN** it emits a `cache-digest` fenced block in its assistant turn
- **THEN** the turn-end parser converts the block into an `Entry` with purpose, facts, evidence refs, scope, timestamps, and invalidation triggers
- **AND** raw tool output is not persisted as the digest body
- **AND** entries are append-only and may reference earlier ones via `derivedFrom` / `supersedes`

### Requirement: Auto-Index L2 Ledger

- **GIVEN** any tool call completes within a session
- **WHEN** the tool result is committed to message storage
- **THEN** the L2 index records `(toolCallID, toolName, args_summary, file_path?, hash?, mtime?, turn)` referencing the original message
- **AND** no copy of the raw output is stored — index entries are pointers
- **AND** indexing failure surfaces explicitly (no silent skip)

### Requirement: Preserve Read-Modify Lineage

- **GIVEN** a sequence of L1 entries includes a read digest followed by a modifying digest for the same evidence path
- **WHEN** retrieval renders entries
- **THEN** it prefers the newest valid modifying digest
- **AND** preserves lineage links to prior read evidence for audit and traceability

### Requirement: Fail-Closed Validation

- **GIVEN** retrieval (manifest, `recall_*`, or post-compaction render) selects entries
- **WHEN** entries are evaluated
- **THEN** only schema-valid, scoped, non-stale entries with evidence refs are returned
- **AND** stale or unknown entries are omitted with explicit reason rather than injected as fallback

### Requirement: Preserve Formal Source Authority

- **GIVEN** an L1 entry references implementation files or architecture facts
- **WHEN** an agent plans to modify code or update formal docs
- **THEN** it must re-read the referenced evidence (or call `recall_toolcall` and verify hash freshness) before writing
- **AND** stable knowledge must be promoted manually to `specs/architecture.md` or a feature spec
- **AND** L1 alone never authorises a modifying action

### Requirement: Behavioural Trigger for L1 Emission

- **GIVEN** AI has completed a contiguous exploration sequence (configurable threshold, default ≥3 read-class tool calls)
- **WHEN** the most recent tool result is rendered for the next turn
- **THEN** a tool-result postscript is appended nudging AI to emit a `cache-digest` fenced block if it formed a reusable claim
- **AND** the postscript is suppressed for non-exploration tool sequences (Edit/Write/etc.) to avoid token cost without value
- **AND** AI may legitimately decline (no claim worth caching) — failure to emit is not an error

## Acceptance Checks

### L2 — Engineering Gate

- L2 index is populated automatically by every read-class tool call (Read, Grep, Glob, Bash exploration patterns).
- `system-manager:recall_toolcall_raw` returns correct pointer for indexed entries and `{ found: false }` for unknown queries.
- `system-manager:recall_toolcall_raw` with `include_body: true` returns the original `ToolPart.output` content; with default flag returns pointer only.
- `system-manager:recall_toolcall_index` returns count + kind + topic shape identical to post-compaction manifest, on demand.
- Catch-up manifest is rendered at post-compaction with count + kind + topics, under token budget.
- Manifest does not leak raw contents or hashes.
- Fail-closed: index lookup failures surface explicitly, no silent fallback.

### L1 — Behavioural Gate

- Tool-result postscript appears after exploration sequences and only those.
- `cache-digest` fenced blocks emitted by AI parse correctly into `Entry` records.
- Digest emission rate ≥ target threshold per exploration sequence (target tunable; initial floor declared at validation).
- Spot-check: emitted facts cite real evidence refs and do not fabricate claims.
- Stale L1 entries are omitted from `system-manager:recall_toolcall_digest` and post-compaction rendering.

### Cross-Tier

- Read → modify chains prefer the latest non-stale modifying L1 entry while preserving prior lineage.
- Modifying actions (Edit, Write) still require fresh L1 evidence verification or direct re-read.
- The design adds no silent fallback path.
