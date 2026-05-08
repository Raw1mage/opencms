# Invariants — Working Cache / Local Cache

## Authority

- **INV-1** Working Cache entries (both L1 and L2) are advisory; source files and formal specs remain authoritative.
- **INV-2** L2 stores pointers only. Raw tool output lives in `Session.messages` storage and is never duplicated into L2.
- **INV-3** L1 derives from AI synthesis, not from L2. L1 may legitimately contain cross-file claims that no single L2 entry covers.

## Validation

- **INV-4** Automatic prompt injection requires at least one valid evidence ref per rendered fact group.
- **INV-5** Stale or unknown evidence freshness omits the entry instead of injecting fallback prose.
- **INV-6** `tool-result` and `subagent-result` evidence kinds must carry an explicit freshness signal (`max-age-ms` invalidation trigger or capture timestamp). Unconditional "always fresh" is forbidden.
- **INV-7** Cache rendering must include evidence refs or an explicit statement that the entry was omitted.

## Catch-up Phasing

- **INV-8** Phase A (anchor + tail replay) renders no cache content of any kind.
- **INV-9** Phase B (post-compaction manifest) emits counts, kinds, topic labels, and retrieval-tool names only. Never fact bodies, never hashes, never paths beyond a single illustrative example.
- **INV-10** Phase C retrieval (`recall_digest` / `recall_toolcall`) is the only path through which fact bodies and pointers reach the AI.

## Read-Modify Discipline

- **INV-11** Code edits still require direct read-before-write evidence, even when an L1 entry mentions the file. L1 alone never authorises a modifying action.
- **INV-12** Modifying actions consume L1 only as orientation. Verification reads back to source files (or to a fresh `recall_toolcall` followed by message-storage fetch).

## Failure Discipline

- **INV-13** No silent fallback. L2 indexing failure surfaces explicitly; L1 fenced-block parse failure surfaces explicitly; manifest over-budget omits the provider rather than truncating into prose.
- **INV-14** `recall_*` tools return `{ found: false }` (or empty results with omission reasons) on miss. Misses are never thrown errors.
- **INV-15** Post-compaction recovery must not re-establish already preserved runtime state.

## Population

- **INV-16** L2 is populated only by the tool-invoker post-hook. No agent-callable surface mutates the ledger.
- **INV-17** L1 is populated only by the turn-end fenced-block parser. No tool-side automatic L1 writes; no other code path bypasses the parser.
- **INV-18** L1 emission is conditional on exploration-sequence depth crossing the configured threshold. Postscript injection is suppressed otherwise.
