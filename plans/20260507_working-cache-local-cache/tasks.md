# Tasks — Working Cache / Local Cache

## 1. Planning and Architecture Alignment

- [x] 1.1 Establish plan package and session event skeleton
- [x] 1.2 Read existing architecture/docs for session, compaction, toolcall, and context boundaries
- [x] 1.3 Define core data model, invalidation policy, and read/write lifecycle
- [x] 1.4 Produce IDEF0, GRAFCET, C4, sequence, and validation artifacts
- [x] 1.5 Revise plan after design conversation: split into L1 (digest) + L2 (raw ledger), add catch-up phasing, defer subagent / memory / cross-scope work

## 2. L1 Foundation (already merged, kept as baseline)

- [x] 2.1 Select minimal storage location and entry schema
- [x] 2.2 Add `WorkingCache.record()` write path with schema validation and fail-closed rejection
- [x] 2.3 Add `WorkingCache.selectValid()` read path with stale-evidence omission
- [x] 2.4 Wire baseline `WorkingCacheProvider` into post-compaction
- [x] 2.5 Add unit tests for schema validation, stale evidence, lineage preference, render budget

## 3. L2 Raw Ledger (MVP — Engineering Gate)

- [ ] 3.1 Add `kind: "exploration" | "modify" | "other"` metadata field to tool definitions in `tool.ts`; classify Read, Grep, Glob, Bash (exploration patterns), Edit, Write, NotebookEdit
- [ ] 3.2 Implement L2 `LedgerEntry` schema and derived-view function over `Session.messages`
  - Pure function: `(sessionID) -> LedgerEntry[]`
  - Stores no new payload — pointers only
  - Returns explicit error on indexing failure (no silent skip)
- [ ] 3.3 Implement `system-manager:recall_toolcall_raw` tool
  - Args: `{ kind?, path?, hash?, turn_range?, include_body? }`
  - Returns: `{ found, toolCallID?, toolName?, args_summary?, file_path?, hash?, mtime?, message_ref?, age_turns?, body? }`
  - `include_body: false` (default) → pointer-only
  - `include_body: true` → server-side fetch of `ToolPart.output` from `Session.messages` inlined into response (no L2 payload duplication)
  - `{ found: false }` is a normal return
  - System-prompt usage example included in tool description; description cross-links to `recall_toolcall_index` and `recall_toolcall_digest`
- [ ] 3.4 Implement `system-manager:recall_toolcall_index` tool
  - Args: `{ since_turn?, kind? }`
  - Returns: `{ l2: { total, by_kind, by_file_count }, l1: { total, topics }, retrieval: { raw, digest } }`
  - Same content shape as post-compaction manifest, on demand
  - No fact bodies, no hashes, no path enumeration
  - Description cross-links to sibling tools
- [ ] 3.5 Replace `WorkingCacheProvider` body with Phase B manifest form
  - Counts + kinds + topic labels only
  - ≤120 token budget
  - Names retrieval tools `system-manager:recall_toolcall_index` / `system-manager:recall_toolcall_raw` / `system-manager:recall_toolcall_digest`
  - Drops the previous full-table render
- [ ] 3.6 Fix freshness fail-open for `tool-result` / `subagent-result` evidence kinds in `working-cache.ts:299` (`evidenceIsFresh`)
  - Require either `max-age-ms` invalidation trigger OR explicit capture timestamp
  - Apply same fail-closed discipline as file evidence
- [ ] 3.7 Tests
  - Unit: ledger derivation produces correct pointers for sample message stream
  - Unit: `system-manager:recall_toolcall_raw` matches by path / hash / kind / turn_range; `{ found: false }` for misses
  - Unit: `recall_toolcall_raw` with `include_body: true` returns body fetched from `Session.messages`, never duplicated into L2
  - Unit: `system-manager:recall_toolcall_index` returns identical shape to post-compaction manifest
  - Unit: manifest render stays under token budget for synthetic large session
  - Unit: `tool-result` evidence with no freshness signal is now rejected

## 4. L1 Digest Behavioural Slice (MVP — Behavioural Gate)

- [ ] 4.1 Implement exploration-sequence depth counter in `tool-invoker.ts`
  - Increment on `kind: exploration` tool calls
  - Reset on `kind: modify | other` calls or non-tool turns
  - Threshold default = 3 (configurable via `tweaks.cfg`)
- [ ] 4.2 Implement tool-result postscript injection
  - Triggered when depth ≥ threshold
  - Postscript invites `cache-digest` fenced block emission
  - Postscript is a single block of static text; no per-result customisation in MVP
- [ ] 4.3 Implement `cache-digest` fenced-block parser as turn-end hook
  - Parses ` ```cache-digest ... ``` ` blocks from assistant messages
  - Validates against `WorkingCache.Entry` schema
  - On parse/validation failure, surfaces explicit error in next turn (no silent drop)
  - On success, calls `WorkingCache.record()`
- [ ] 4.4 Implement `system-manager:recall_toolcall_digest` tool
  - Args: `{ topic?, entry_id?, evidence_path? }`
  - Returns: `{ entries: Entry[], omitted: { entry_id, reason }[] }`
  - System-prompt usage example included in tool description; description cross-links to `recall_toolcall_index` and `recall_toolcall_raw`
- [ ] 4.5 Add system-prompt copy describing cache-digest emission etiquette
  - When to emit (after exploration sequence, only if reusable claim formed)
  - When NOT to emit (no claim, modify-class actions)
  - Format example with required fields
- [ ] 4.6 Tests
  - Unit: parser accepts well-formed blocks, rejects malformed
  - Unit: malformed block surfaces explicit error path (no silent drop)
  - Integration: simulated exploration sequence triggers postscript; assistant emission round-trips through parser into store
  - Integration: `system-manager:recall_toolcall_digest` returns matching entries, omits stale with reason
  - Behavioural spot-check: digest emission rate ≥ floor on a synthetic exploration corpus (floor declared in validation-plan.md)

## 5. Architecture Sync and Event Log

- [ ] 5.1 Update `specs/architecture.md` with L1/L2 tier description and catch-up phasing once §3 + §4 land
- [ ] 5.2 Append L1/L2 implementation outcomes to `docs/events/event_2026-05-07_working-cache-local-cache.md`
- [ ] 5.3 Record validation gate results (L2 engineering / L1 behavioural) separately

## 6. Deferred (Out of MVP)

> The following are explicitly **not** in MVP scope. Re-open via a new plan revision after L1/L2 effect is observed.

- [ ] 6.1 Subagent → parent cache promotion at task completion (deferred plan)
- [ ] 6.2 Memory-graph promotion / cross-session retention via `/memory` (deferred plan)
- [ ] 6.3 MCP local environment normalisation refactor (tracked separately; precondition only if 6.2 reactivates)
- [ ] 6.4 Repo-scoped and domain-scoped entries — schema retains support; MVP exercises session scope only
- [ ] 6.5 Automatic TTL / compaction / deletion policy for L1 entries
- [ ] 6.6 Within-turn dedup at tool dispatch (block re-Read of already-read file in same turn)

## Revision Note

Tasks were restructured 2026-05-07 to split MVP into independently shippable L2 (engineering) and L1 (behavioural) slices. Previous Phase 3 "Memory Integration Refactor" entries were moved to §6 deferred; their prior completion checkmarks reflected design-time scoping work, not shipped behaviour, and are not preserved as MVP-relevant.
