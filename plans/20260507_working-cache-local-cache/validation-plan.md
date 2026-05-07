# Validation Plan — Working Cache / Local Cache

## Planning Validation

- Validate IDEF0 JSON with drawmiat.
- Validate GRAFCET JSON with drawmiat.
- Check all GRAFCET `ModuleRef` values exist in IDEF0 activities.
- Check C4 component `moduleRef` values trace to IDEF0 modules.

## L2 — Engineering Gate (Raw Ledger)

L2 is mechanical and deterministic. Pass criteria are pure correctness.

### Unit

- Tool metadata: every tool in `tool.ts` carries a non-empty `kind` value.
- Ledger derivation: synthetic `Session.messages` with N read-class + M modify-class toolcalls produces N+M `LedgerEntry` records, each pointing back to its source `ToolPart` by `toolCallID`.
- Ledger derivation: zero payload duplication — entries carry only metadata, never raw output bodies.
- `recall_toolcall`: query by `path` returns matching entries; query by missing `path` returns `{ found: false }` (not an error).
- `recall_toolcall`: query by `hash` matches the file content actually indexed.
- `recall_toolcall`: `turn_range` filter narrows correctly.
- Manifest render: synthetic session with 50+ ledger entries and 10+ digest entries produces a manifest under 120 tokens.
- Manifest render: counts and topic labels match the underlying data exactly.
- Freshness: `tool-result` evidence with no `max-age-ms` or capture timestamp is rejected (not silently treated as fresh).
- Freshness: `subagent-result` evidence follows the same rule as `tool-result`.

### Integration

- Spawn a session, run a sequence of Read/Grep/Edit toolcalls, fire compaction, verify post-compaction context contains the manifest with correct counts.
- Call `recall_toolcall` after compaction; verify it resolves pointers to messages preserved in storage.
- Indexing failure path: corrupt one `ToolPart` record, verify ledger derivation surfaces explicit error rather than silently skipping.

### Pass Criteria

All unit and integration tests pass. No silent fallback path introduced. Token budget honoured for manifest. **L2 ships independently of L1.**

## L1 — Behavioural Gate (Digest)

L1 depends on AI behaviour. Pass criteria require both engineering correctness and observed emission rates.

### Unit (engineering side)

- `cache-digest` fenced-block parser accepts well-formed blocks, rejects malformed.
- Malformed block surfaces explicit error path that the next turn can see — no silent drop.
- Exploration-sequence depth counter increments on `kind: exploration` tools, resets on `kind: modify | other` tools and on non-tool turns.
- Postscript injection fires only when depth ≥ threshold; suppressed otherwise.
- `recall_digest` returns matching entries; stale entries are omitted with explicit reason.

### Integration (engineering side)

- Simulated exploration sequence triggers postscript on the last tool result.
- Assistant message containing a well-formed `cache-digest` block round-trips through parser into `WorkingCache` store.
- `recall_digest` retrieves the entry by topic / by `entry_id`.
- Read → modify chain: modifying digest is preferred over earlier read digest; lineage links preserved.

### Behavioural (observation side)

Run on a curated synthetic exploration corpus of N session traces (initial N = 10).

- **Emission rate floor**: of the exploration sequences that crossed the threshold, ≥ 40% produced a parseable `cache-digest` block. (Initial floor; tunable after first run.)
- **Format compliance rate**: ≥ 90% of emitted blocks parse without schema error.
- **Evidence-citation discipline**: spot-check 100% of emitted blocks — every fact carries at least one evidence ref pointing to a real file path or `toolCallID`. No fabricated paths.
- **No false positives**: postscript does not appear on Edit/Write-only sequences; AI does not emit blocks when no claim exists.

### Pass Criteria

Engineering unit + integration tests pass **and** behavioural observation meets all four thresholds. If behavioural fails, engineering may still ship (L2 unaffected); L1 prompt copy iterates until thresholds met.

## Cross-Tier

- Read → modify lineage: latest non-stale modifying L1 entry is preferred in retrieval; prior read entries remain accessible via lineage links.
- Modifying actions (Edit, Write): test path that uses a stale L1 entry without re-reading — expected to surface stale-evidence error or trigger re-read; never proceeds silently.
- Manifest does not leak fact bodies, hashes, or paths beyond a single illustrative example.

## Architecture Sync

- Update `specs/architecture.md` after L2 ships and again after L1 ships.
- If L1 behavioural gate fails on first run, record observed emission rate and prompt-copy iteration in the event log; do not back out L2.

## Independence Invariant

L2 and L1 are independently shippable. If L1 behavioural gate cannot be met within reasonable iteration, L2 alone is a valid MVP outcome — the catch-up manifest, `recall_toolcall`, and freshness fixes still close meaningful waste.
