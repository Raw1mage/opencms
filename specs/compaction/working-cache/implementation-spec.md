# Implementation Spec — Working Cache / Local Cache

## Goal

Add a per-session two-tier Working Cache:

- **L1 (digest)**: AI-authored, evidence-backed, structured fact entries persisted under `WorkingCache.Entry` schema and emitted via `cache-digest` fenced blocks in assistant messages.
- **L2 (raw ledger)**: derived index over `Session.messages` storage exposing existing toolcall results to the AI without duplicating raw payload.

Both tiers are reachable on demand via three sibling tools under the `system-manager:` namespace — `recall_toolcall_index` (manifest), `recall_toolcall_raw` (L2), and `recall_toolcall_digest` (L1). Post-compaction surfaces a Phase B awareness manifest only — counts, kinds, topic labels — under a 120-token budget.

## Target Behaviour

### L2 Behaviour (engineering)

1. Every read-class tool call (Read, Grep, Glob, exploration-class Bash) produces an `LedgerEntry` derived from the resulting `ToolPart`, with no payload duplication.
2. `system-manager:recall_toolcall_raw({ kind?, path?, hash?, turn_range?, include_body? })` returns pointer records from the ledger, or `{ found: false }` for misses (never thrown errors). With `include_body: true`, the server fetches `ToolPart.output` from `Session.messages` storage and inlines it; no payload is duplicated into L2.
3. `system-manager:recall_toolcall_index({ since_turn?, kind? })` returns the same content shape as the post-compaction manifest, on demand. AI uses this to refresh awareness mid-session.
4. Post-compaction `WorkingCacheProvider` renders a Phase B manifest (counts + kinds + topic labels + retrieval tool names) under 120 tokens, regardless of cache size.
5. `tool-result` and `subagent-result` evidence kinds require an explicit freshness signal — the previous unconditional fail-open is removed.

### L1 Behaviour (behavioural)

1. After a contiguous exploration sequence (depth ≥ threshold, default 3), the most recent tool result carries a postscript inviting `cache-digest` block emission.
2. AI optionally emits a ` ```cache-digest ... ``` ` fenced block in its assistant turn; turn-end parser validates and writes it through `WorkingCache.record()`.
3. `system-manager:recall_toolcall_digest({ topic?, entry_id?, evidence_path? })` returns matching entries with stale ones explicitly omitted.
4. System-prompt copy describes when to emit (and when not to) with one canonical example.

## Non-Goals

- No raw output duplication into L2.
- No automatic L1 emission inside tool hooks (digest is AI behaviour, not storage hook).
- No automatic architecture-doc rewrite without agent review.
- No silent fallback when cache load, parsing, or indexing fails.
- No subagent → parent promotion.
- No memory-graph integration in MVP.

## File-Level Changes

| File | Change |
| ---- | ------ |
| `packages/opencode/src/tool/tool.ts` | Add `Tool.Kind = "exploration" \| "modify" \| "other"` and `Tool.kind(toolID)` lookup; static registry covers all native tools (no per-file edits) |
| `packages/mcp/system-manager/src/index.ts` | Register the 3 sibling tools (`recall_toolcall_index`, `_raw`, `_digest`) in ListToolsRequestSchema and dispatch them in CallToolRequestSchema. system-manager is an external MCP server package, not opencode-native (corrects an earlier draft that placed the tools under `packages/opencode/src/tool/system-manager/` — that path does not exist) |
| `packages/mcp/system-manager/src/system-manager-http.ts` | Add `workingCacheIndexViaApi`, `workingCacheRawViaApi`, `workingCacheDigestViaApi` HTTP client methods following the existing `readSessionMessagesViaApi` pattern |
| `packages/opencode/src/server/routes/working-cache.ts` | New Hono route file exposing `GET /working-cache/{index\|raw\|digest}/:sessionID` for the MCP server to call back into. Read-only, per-session, follows the existing `describeRoute + validator + resolver` OpenAPI pattern |
| `packages/opencode/src/server/app.ts` | Register `WorkingCacheRoutes()` under `/working-cache` |
| `packages/opencode/src/session/tool-invoker.ts` | Add exploration-sequence depth counter; add tool-invoker post-hook for L2 ledger derivation trigger; add postscript injection on the last tool result of an exploration sequence |
| `packages/opencode/src/session/working-cache.ts` | Add `LedgerEntry` schema + derivation function over `Session.messages`; fix freshness fail-open for `tool-result` / `subagent-result` evidence kinds (line 299); add manifest render helper |
| `packages/opencode/src/session/post-compaction.ts` | Replace `WorkingCacheProvider.gather` body with manifest-form render (counts + kinds + topics + tool names) |
| `packages/opencode/src/session/message-v2.ts` | Add turn-end hook that scans assistant message for `cache-digest` fenced blocks and routes to parser |
| `packages/opencode/src/config/config.ts` | Add tweakable `working_cache.exploration_threshold` (default 3) |

## Validation Plan

See `validation-plan.md`. Gates split:

- **L2 engineering gate**: unit + integration; pure correctness; ships independently.
- **L1 behavioural gate**: unit + integration + observed emission rate / format compliance / evidence discipline / no-false-positives. Iterates prompt copy until thresholds met. Failure does not block L2.

Architecture sync recorded in `docs/events/event_2026-05-07_working-cache-local-cache.md` after each slice ships.
