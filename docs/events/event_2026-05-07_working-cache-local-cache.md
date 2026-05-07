# Event — Working Cache / Local Cache Plan

## Requirement

User identified a context-management gap: expensive toolcall exploration is digested by the AI but usually remains in ephemeral context. Compaction anchors preserve conversation continuity, not the full reusable exploration map. Need a local Working Cache that persists AI-extracted digest with evidence refs and invalidation.

## Scope

IN:

- Working Cache plan under `plans/20260507_working-cache-local-cache/`.
- Initial architecture and data model design.
- File-change invalidation strategy.
- Compaction/prompt integration boundaries.

OUT:

- Code implementation in this planning turn.
- Raw tool output archive.
- Replacing formal architecture/spec docs.

## Evidence / Checkpoints

- Baseline: current compaction anchor is message-stream SSOT and limited summary, not full tool exploration cache (`specs/architecture.md:173`).
- Boundary: centralized tool execution exists at `packages/opencode/src/session/tool-invoker.ts:47`.
- Boundary: tool result contract is `{ title, metadata, output, attachments }` in `packages/opencode/src/tool/tool.ts:47`.
- Boundary: current `SharedContext` is coarse and budgeted (`packages/opencode/src/session/shared-context.ts:17`).
- Boundary: post-compaction provider framework already exists (`packages/opencode/src/session/post-compaction.ts:27`).
- Boundary: compaction recovery slices from the most recent message-stream anchor (`packages/opencode/src/session/prompt.ts:579`).
- Boundary: tool parts persist completed inputs/outputs as `MessageV2.ToolPart` (`packages/opencode/src/session/message-v2.ts:502`).
- Boundary: storage has generic JSON read/write APIs suitable for a session/repo cache namespace (`packages/opencode/src/storage/storage.ts:667`, `packages/opencode/src/storage/storage.ts:793`).
- Boundary: compaction currently appends `PostCompaction` follow-ups into anchor text and synthetic continue messages (`packages/opencode/src/session/compaction.ts:556`).

## Key Decisions

- Working Cache stores digest, not raw output.
- Entries are advisory and evidence-backed.
- Stale required evidence causes fail-closed omission.
- Post-compaction provider is the natural recovery injection point.
- MVP should start as explicit digest recording, not automatic summarization after every toolcall, to avoid hallucinated or low-value cache writes.
- User clarified that read -> modify chains should retain the modified-version memory as the preferred recovery fact, while still allowing逐筆 ledger records for traceability.
- Cache expiration is deferred as a dedicated later policy; MVP should retain timestamps/lineage/invalidation hooks without prematurely deleting evidence.

## XDG Backup

- Created whitelist snapshot: `/home/pkcs12/.config/opencode.bak-20260507-1238-working-cache/`
- This is a pre-plan snapshot for manual restore only.

## Remaining

- MVP implementation slice completed explicit digest recording, post-compaction recovery, tests, and architecture sync.
- User interrupted with a scope extension: `/memory` is also broken and should be integrated into this plan for refactor.
- Phase 3 will first reproduce the `/memory` failure and map component boundaries before any repair.

## Phase Summary — 1 Planning and Architecture Alignment

- **Done**: 1.1, 1.2, 1.3, 1.4.
- **Key decisions**: DD-1 explicit digest recording first; DD-2 existing `Storage` namespace first; DD-3 fail-closed cache reads; DD-4 `PostCompaction.Provider` as first consumer.
- **Validation**: JSON syntax passed for `idef0.json`, `grafcet.json`, `data-schema.json`, `c4.json`, `sequence.json`, and `test-vectors.json`; IDEF0↔GRAFCET module refs and C4/sequence traceability have no missing references.
- **Drift**: no code changes in Phase 1.
- **Remaining**: implement MVP storage/schema, explicit write path, post-compaction read path, tests, and architecture sync.

## Phase Summary — 2 MVP Implementation Slice

- **Done**: 2.1, 2.2, 2.3, 2.4.
- **Key decisions**: Keep MVP recording explicit; persist entries in the existing Storage namespace; restore only valid session-scoped digests via `PostCompaction`; preserve read→modify lineage with `derivedFrom` / `supersedes`; defer destructive expiration.
- **Validation**:
  - `bun test packages/opencode/test/session/working-cache.test.ts` — passed (5 tests).
  - `bun x eslint packages/opencode/src/session/working-cache.ts packages/opencode/src/session/post-compaction.ts packages/opencode/test/session/working-cache.test.ts` — passed.
  - Prior subagent check: `bun --filter opencode typecheck` failed on unrelated pre-existing repo-wide type errors; no Working Cache files were listed.
- **Drift**: `plan-sync` warned about pre-existing `packages/ui/src/hooks/create-auto-scroll.tsx` diff not referenced by this plan; treated as unrelated to Working Cache slice.
- **Architecture Sync**: Updated `specs/architecture.md` Compaction Subsystem section with Working Cache MVP boundary, Storage-backed digest ledger, post-compaction provider, and non-goals.
- **Remaining**: Optional future phases for automatic digest capture, repo/domain scope recovery, expiration policy, and richer observability.

## Debug Checkpoints — Phase 3 Memory Integration Refactor

### Baseline

- User reported: `/memory` is broken and should be integrated into this Working Cache plan.
- Initial hypothesis space: MCP memory tool routing, memory app/server availability, graph CRUD schema/transport, or missing Working Cache ↔ memory promotion/recovery contract.

### Instrumentation Plan

- Boundary 1: Runtime capability layer exposes `memory_*` tools.
- Boundary 2: MCP memory CRUD calls succeed or fail with concrete error payloads.
- Boundary 3: Repo code path that registers/loads MCP apps and exposes deferred tools.
- Boundary 4: Working Cache design contract for optional GraphRAG promotion/retrieval.

### Execution

- Started with read-only repo search and plan/event update; no repair attempted before failure evidence.
- `memory_read_graph` and `memory_search_nodes` returned empty graph successfully, proving tool exposure/transport is partially alive.
- `memory_create_entities` failed with `ENOENT` for `/home/pkcs12/projects/opencode/node_modules/.bun/@modelcontextprotocol+server-memory@2026.1.26/node_modules/@modelcontextprotocol/server-memory/dist/$HOME/.local/share/opencode/memory/memory.jsonl`.
- Config evidence: `/home/pkcs12/.config/opencode/opencode.json` set `MEMORY_FILE_PATH` to literal `$HOME/.local/share/opencode/memory/memory.jsonl`.
- Code evidence: `packages/opencode/src/config/config.ts` only recognized commands containing `@modelcontextprotocol/server-memory`, missing installed `/usr/local/share/opencode/mcp/server-memory/dist/index.js` path.
- Code evidence: `packages/opencode/src/mcp/index.ts` passed `mcp.environment` directly to `StdioClientTransport` and directory preparation without `$HOME` expansion.

### Root Cause

- Memory MCP was launched with a literal `$HOME` storage path because the runtime did not normalize the installed memory server command shape and did not expand shell-style environment values before process launch.
- The server-memory package interpreted the relative `$HOME/...` path from its dist working directory, so write calls failed with `ENOENT` while read/search appeared as an empty graph.

### Validation

- `bun x eslint packages/opencode/src/config/config.ts packages/opencode/src/mcp/index.ts` — passed.
- `bun --filter opencode typecheck` — still fails on unrelated repo-wide existing errors; new `Env.home` error from the first patch attempt was resolved.
- Controlled restart via `system-manager_restart_self`, then absolute XDG `MEMORY_FILE_PATH` reload confirmed.
- `memory_create_entities` succeeded for `WorkingCacheMemoryDiagnostic`.
- `memory_search_nodes` found `WorkingCacheMemoryDiagnostic`.
- `memory_delete_entities` deleted `WorkingCacheMemoryDiagnostic` successfully.
- `/memory` CRUD boundary restored; diagnostic entity removed after validation.

## Phase Summary — 3 Memory Integration Refactor

- **Done**: 3.1, 3.2, 3.3, 3.4.
- **Key decisions**: `/memory` is a GraphRAG promotion/retrieval layer, not the Working Cache primary store; MCP local env paths must be expanded before launch; memory server command detection must include installed `server-memory/dist/index.js` path.
- **Validation**:
  - `memory_create_entities` / `memory_search_nodes` / `memory_delete_entities` — passed after restart and path fix.
  - `bun x eslint packages/opencode/src/config/config.ts packages/opencode/src/mcp/index.ts packages/opencode/src/session/working-cache.ts packages/opencode/src/session/post-compaction.ts packages/opencode/test/session/working-cache.test.ts` — passed.
  - `bun test packages/opencode/test/session/working-cache.test.ts` — passed (5 tests).
  - `bun --filter opencode typecheck` — still fails on unrelated repo-wide existing errors; see earlier validation notes.
- **Architecture Sync**: Updated `specs/architecture.md` with Memory Graph MCP boundary and Working Cache relationship.
- **Remaining**: No required Phase 3 work remains; future work may add explicit Working Cache → memory promotion tooling.

## Phase Summary — Plan Revision (2026-05-07, second pass)

User opened a design conversation after L1 baseline shipped, asking whether the
existing single-tier digest design was sufficient. Conversation walked the two
parallel waste streams (raw toolcall output evaporation at compaction vs.
AI-synthesised digest dilution in conversation prose) and converged on a
two-tier architecture.

### Decisions Locked During Revision

- **L1 / L2 tier rename**: digest tier becomes L1 (smaller, behavioural,
  AI-authored); raw ledger tier becomes L2 (mechanical index over existing
  `Session.messages` ToolPart records, no payload duplication). Naming follows
  CPU-cache analogy: L1 first-priority, L2 fallback.
- **Catch-up phasing (DD-5/DD-6)**: AI takeover follows three phases. Phase A
  is anchor + tail replay with cache invisible; Phase B is awareness manifest
  only (counts, kinds, topic labels); Phase C is on-demand drill-in.
- **Tool family under `system-manager:` namespace (DD-10)**: three sibling
  tools rather than one composite —
  `system-manager:recall_toolcall_index`,
  `system-manager:recall_toolcall_raw`,
  `system-manager:recall_toolcall_digest`. Naming chosen to disambiguate from
  "re-execute toolcall"; `_raw` and `_digest` suffixes signal what the tool
  returns.
- **DD-21 `include_body` flag**: `recall_toolcall_raw` accepts an optional
  `include_body: boolean` flag. Default `false` returns pointer-only;
  `true` instructs the server to fetch the original `ToolPart.output` from
  `Session.messages` and inline it without duplicating into L2. Resolves the
  sandbox-discovered gap where pointer-only retrieval forced AI to fall back
  to fresh re-Read.
- **DD-22 three exposure surfaces**: cache awareness reaches AI through (1)
  the standing tool list at zero marginal cost, (2) the post-compaction
  manifest as a one-shot at the highest catch-up moment, (3) the
  `recall_toolcall_index` tool on demand mid-session. Turn-start auto-injection
  was rejected on linear-cost vs. infrequent-need ROI grounds.
- **Behavioural emission for L1 (DD-7/DD-8)**: tool-invoker tracks an
  exploration-sequence depth counter; when depth crosses a threshold (default
  3, configurable via `tweaks.cfg`), the tool result postscript invites a
  `cache-digest` fenced-block emission. A turn-end parser converts the block
  into a `WorkingCache.Entry`. No tool-side automatic L1 writes.
- **Freshness fix (DD-12 / INV-6)**: the previous unconditional
  `return true` for `tool-result` and `subagent-result` evidence kinds in
  `evidenceIsFresh` is replaced. Such entries must carry a `max-age-ms`
  invalidation trigger or capture timestamp; missing freshness signal is
  rejected fail-closed.

### Sandbox Simulation and Cost Estimate

Full session-lifecycle walkthrough produced a per-session token-saving estimate:

- L2 alone: ~5,000–20,000 tokens net saving per session experiencing compaction
  and exploration.
- L1 + L2 combined: ~17,000–63,000 tokens net saving per medium-to-long
  session, contingent on L1 emission rate ≥ 40%.
- The simulation also revealed the original "pointer-only" L2 retrieval would
  break ROI; this drove the DD-21 decision.

### Validation Gate Split

- **L2 engineering gate**: pure correctness (unit + integration) — ledger
  derivation, `recall_toolcall_*` tool shapes, manifest budget, freshness
  rejection. Ships independently.
- **L1 behavioural gate**: emission rate ≥ 40% on a synthetic exploration
  corpus, format compliance ≥ 90%, evidence-citation discipline 100%, no
  false positives. Iterates prompt copy until thresholds met. Failure does
  not block L2 shipping.

### Deferred (out of MVP)

- Subagent → parent cache promotion at task completion.
- Memory-graph integration / cross-session retention via `/memory`.
- Repo-scoped and domain-scoped entries (schema retains support, MVP only
  exercises session scope).
- Automatic TTL / deletion policy.
- Within-turn dedup at tool dispatch.

### Artefacts Updated

Plan package (`plans/20260507_working-cache-local-cache/`) — every document in
the package was revised:

- `proposal.md`, `spec.md`, `design.md`, `tasks.md`, `validation-plan.md`,
  `handoff.md`, `invariants.md`, `errors.md`, `observability.md`,
  `implementation-spec.md`.
- All six JSON artifacts regenerated: `idef0.json`, `grafcet.json`, `c4.json`,
  `sequence.json`, `data-schema.json`, `test-vectors.json`.
- SVG diagrams rendered: `diagrams/idef0.svg` (IEEE 1320.1 compliant),
  `diagrams/grafcet.svg` (IEC 60848 structure check passed).

`specs/architecture.md` received a forward-pointer block describing the
revised plan and noting that only L1 is shipped today.

### Remaining

- Implement L2 slice (tasks §3): tool kind metadata, ledger derivation,
  three `system-manager:recall_toolcall_*` tools, manifest-form
  `WorkingCacheProvider`, freshness fix.
- Implement L1 behavioural slice (tasks §4): exploration depth counter,
  postscript injection, `cache-digest` parser, system-prompt copy.
- Re-run architecture sync after each slice ships.

## Phase Summary — Beta Implementation (2026-05-07, third pass)

User invoked `/beta-workflow` to execute §3 (L2 engineering gate) and §4 (L1
behavioural slice) on a separate beta worktree. All implementation lives on
branch `working-cache-l1` in `~/projects/opencode-beta`; main repo carries
only docs (this file, plans/, future architecture sync).

### Authority SSOT for this run

- `mainRepo` = `/home/pkcs12/projects/opencode` (carries main branch + plan
  package + this event log).
- `baseBranch` = `main`.
- `implementationRepo` / `implementationWorktree` =
  `/home/pkcs12/projects/opencode-beta` (permanent beta workspace).
- `implementationBranch` = `working-cache-l1` (forked from the two reverted
  code commits 88973d86b + 17a963f83 that originally bypassed beta — see
  earlier section).
- `docsWriteRepo` = `mainRepo` (single-repo project).

### Implementation commits on `working-cache-l1`

1. **252dd1bbd** `feat(working-cache): tool kind metadata, L2 ledger derivation,
   freshness fix`
   - Phase A foundations: `Tool.Kind` registry, `LedgerEntry` schema,
     `deriveLedger`, `buildManifest`, `selectLedger`, `selectDigest`,
     `nonReplayableEvidenceIsFresh`, fail-closed validation upgrade.
2. **f0244869a** `feat(working-cache): L1 capture (postscript + parser) and
   manifest provider`
   - Phase B capture loop: exploration depth counter,
     `explorationPostscript`, `parseDigestBlocks`, llm.ts onFinish hook
     wiring, `tool-invoker.ts` postscript injection, manifest-form
     `WorkingCacheProvider` (replaces full-table render).
3. **33d373a5a** `feat(working-cache): wire system-manager:recall_toolcall_*
   tool family + system-prompt copy`
   - Phase C retrieval surface: new `packages/opencode/src/server/routes/
     working-cache.ts` (3 GET endpoints), 3 client methods in
     `system-manager-http.ts`, 3 tool registrations + dispatch in
     `packages/mcp/system-manager/src/index.ts`, emission etiquette section
     in `prompt/codex.txt`.
4. **(this commit on main)** Plan path correction + tasks.md checkbox
   sync + this event-log section.

### Architecture surprise resolved

The plan's `implementation-spec.md` originally placed the three retrieval
tools under `packages/opencode/src/tool/system-manager/` — a path that does
not exist. The actual location is `packages/mcp/system-manager/` which is
an external MCP server package. The implementation crosses MCP boundary
(stdio → HTTP → opencode HTTP server → working-cache module). Marginal cost
vs native tool: ~60 lines + two extra hops. Plan path corrected in this
commit.

### Test status (beta branch)

- `bun test packages/opencode/test/session/working-cache.test.ts` — **16/16
  pass** covering: schema validation, scope check, lineage preference,
  manifest provider, deriveLedger pointer-only contract, selectLedger
  filtering, manifest token budget, parseDigestBlocks (well-formed +
  malformed + missing-fields), depth counter state machine,
  explorationPostscript threshold, freshness rejection +acceptance,
  Tool.kind classification.
- `bun test packages/mcp/system-manager/src/system-manager-session.test.ts`
  — **5/5 pass** (no regressions from the new tool dispatch cases).

### Deferred / explicitly out of scope

Per plan §6:
- Subagent → parent cache promotion (deferred plan).
- Memory-graph promotion / cross-session retention.
- Repo-scoped + domain-scoped entries (schema retains support, MVP
  exercises session scope only).
- Automatic TTL / deletion policy.
- Within-turn dedup at tool dispatch.

Cross-provider system-prompt copy: only `prompt/codex.txt` carries the
emission etiquette section in this slice. Claude / Anthropic / Gemini /
Trinity drivers will still see the recall tools in their tool list but
without the dedicated "when to emit" guidance. Follow-up will copy the
section into the other driver prompts after observing real-session
emission behaviour.

L1 behavioural validation gate: the engineering pieces (parser, postscript,
depth counter, tool registrations) are tested; the **behavioural emission
rate ≥ 40%** target requires real-session corpus and is deferred to
post-deploy observation per validation-plan.md.

### Next step

Fetch-back via `/beta-workflow` §7.1: from `mainRepo` create
`test/working-cache-l1`, merge `working-cache-l1` in, resolve the expected
"deleted vs modified" conflicts on `working-cache.ts`, `post-compaction.ts`,
`config.ts`, `mcp/index.ts` (main reverted these in 9da99f83f; beta has the
re-applied + extended versions), validate, then finalize merge to `main`.
Approval-gated.
