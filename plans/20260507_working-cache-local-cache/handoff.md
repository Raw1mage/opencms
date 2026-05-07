# Handoff — Working Cache / Local Cache

## Execution Contract

- Plan is in **planning mode for L2 + L1 MVP slices**. The L1 baseline (`working-cache.ts` + initial `WorkingCacheProvider`) was merged earlier; this revision retargets the next implementation slice.
- L2 (raw ledger / manifest / `recall_toolcall`) and L1 (digest behavioural slice / `recall_digest`) are **independently shippable**. Ship L2 first if L1 behavioural iteration takes longer than expected.
- Preserve the distinction between cache, formal docs, and source-code truth.
- Any implementation must be fail-fast when cache data is missing, invalid, or stale.
- L2 must not duplicate raw output. The session message storage is the source of truth; L2 stores pointers only.

## Scope Boundaries

**IN scope (MVP):**

- Tool kind metadata (`exploration | modify | other`)
- L2 ledger derivation + `recall_toolcall` tool
- Manifest-form `WorkingCacheProvider` for post-compaction Phase B
- Freshness fix for `tool-result` / `subagent-result` evidence kinds
- Exploration-sequence depth tracking + postscript injection
- `cache-digest` fenced-block parser as turn-end hook
- `recall_digest` tool
- System-prompt copy describing emission etiquette
- Architecture sync after each shipped slice

**OUT of MVP scope (deferred, do not implement):**

- Subagent → parent cache promotion
- Memory-graph integration / cross-session retention
- MCP local environment normalisation refactor (unrelated to L1/L2)
- Repo-scoped and domain-scoped entries (schema retains support, no exercise)
- Automatic TTL / deletion policy
- Within-turn dedup at tool dispatch

## Required Reads

- `specs/architecture.md`
- `docs/events/event_2026-05-07_working-cache-local-cache.md`
- `packages/opencode/src/session/working-cache.ts` (existing L1 baseline)
- `packages/opencode/src/session/post-compaction.ts` (provider to be retargeted to manifest form)
- `packages/opencode/src/session/tool-invoker.ts` (target for depth counter + postscript injection + L2 hook integration point)
- `packages/opencode/src/tool/tool.ts` (target for `kind` metadata + new `recall_*` tools)
- `packages/opencode/src/session/message-v2.ts` (target for turn-end fenced-block parser hook)
- Session compaction and post-compaction code paths
- Tool invocation/result code paths

## Stop Gates

- Stop and re-confer if implementation would require L2 to write a payload copy. L2 is index-only.
- Stop if design would introduce a silent fallback path — every cache miss / parse failure / index failure must be observable.
- Stop if L1 behavioural prompt copy starts requesting fact emission on every turn (must remain conditional on exploration-sequence depth).
- Stop if a deferred item from §6 of `tasks.md` starts to creep into MVP scope.
- Stop if the manifest grows beyond its 120-token budget — re-design the manifest, do not raise the budget.

## Execution-Ready Checklist

- [x] Existing architecture evidence read
- [x] Data model documented (L1 `Entry` + L2 `LedgerEntry`)
- [x] IDEF0/GRAFCET/C4/sequence artifacts drafted (initial revision; refresh after L2/L1 ship)
- [x] Validation plan mapped to tests, split into L2 engineering and L1 behavioural gates
- [ ] Tool kind metadata defined and applied
- [ ] L2 ledger derivation implemented
- [ ] Manifest-form provider replaces full-table render
- [ ] L1 behavioural slice implemented
- [ ] Architecture sync recorded after each slice ships

## Independence Reminder

If L1 behavioural gate cannot be met within reasonable iteration cycles, L2 alone constitutes a valid MVP outcome. Do not block L2 shipping on L1 emission tuning.
