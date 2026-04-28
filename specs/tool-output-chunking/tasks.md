# Tasks — context-management

> Phased execution checklist. Each `## N. Phase` is independently mergeable
> per design.md DD-13. The TodoWrite runtime ledger materialises **exactly
> one phase's `- [ ]` items at a time** (plan-builder skill §16.1).

---

## 1. Phase 1 — Layer 2 self-bounding (lowest risk, independent value)

Goal: every variable-size tool caps its own output to `ctx.outputBudget`.
Carried over from refactor-2026-04-29 prior designed-state spec.

- [x] 1.1 Add `outputBudget` field to `ctx` in `packages/opencode/src/tool/types.ts` (R-1, DD-2)
- [x] 1.2 Add 5 `tool.outputBudget.*` knobs to `packages/opencode/src/config/tweaks.ts` with defaults (DD-2)
- [x] 1.3 Document new knobs in `templates/etc/opencode/tweaks.cfg.example` (actual path: `templates/system/tweaks.cfg`)
- [x] 1.4 Implement `outputBudget` computation helper in `tool/types.ts` (formula per DD-2; actual file: `packages/opencode/src/tool/budget.ts` namespace `ToolBudget`)
- [x] 1.5 Bound `read.ts`: slice on line boundary from `offset`; trailing hint `[... truncated; call read again with offset=<N> ...]` (R-1, INV-8 byte-identity for natural-fit)
- [x] 1.6 Bound `glob.ts`: cap match list; hint suggests narrower pattern
- [x] 1.7 Bound `grep.ts`: cap match list; hint suggests narrower pattern
- [x] 1.8 Bound `bash.ts`: cap stdout/stderr by line+token; hint suggests redirect-to-file; respect `tool.outputBudget.bashOverride`
- [x] 1.9 Bound `webfetch.ts`: cap response body by token; hint includes byte-range header example
- [x] 1.10 Bound `apply_patch.ts`: bound patch summary (not patch input); hint references batch-mode
- [x] 1.11 Bound `task.ts`: bound child final assistant message; hint references `system-manager_read_subsession msgIdx_from`; respect `tool.outputBudget.taskOverride`
- [x] 1.12 Bound `system-manager_read_subsession.ts`: honour outputBudget by reducing default page size
- [x] 1.13 Add per-tool fixtures to `test-vectors.json` for TV-1, TV-2 (read byte-identity baseline + oversize slice); also added TV-21/TV-22 covering all 7 bounded tools generically
- [x] 1.14 Run `bun test` against all bounded tools with both natural-fit and oversize fixtures
- [x] 1.15 Update `specs/architecture.md` Tool Subsystem section with self-bounding contract
- [x] 1.16 Phase 1 summary: write `docs/events/event_<YYYYMMDD>_layer2-self-bounding.md`

## 2. Phase 2 — Layer 1 hybrid-llm + retire kind chain (highest risk)

Goal: replace KIND_CHAIN with single `hybrid_llm` kind; implement Phase 1
+ Phase 2 + chunk-and-merge; close G-1, G-3, G-4, G-6, G-8, G-9.

- [x] 2.1 Move `specs/tool-output-chunking/hybrid-llm-framing.md` → `packages/opencode/src/session/prompt/hybrid-llm-framing.md` (`git mv` to preserve history)
- [x] 2.2 Add 3 compaction knobs to `tweaks.cfg`: `compaction.llmTimeoutMs=30000`, `compaction.fallbackProvider`, `compaction.phase2.maxAnchorTokens=5000`, `compaction.pinnedZone.maxTokensRatio=0.30` (DD-5, DD-6, DD-9)
- [x] 2.3 Define `Anchor` / `JournalEntry` / `PinnedZoneEntry` / `ContextMarkers` / `LLMCompactRequest` / `CompactionEvent` types in `packages/opencode/src/session/memory.ts` matching `data-schema.json`
- [x] 2.4 Refactor `Memory` to expose first-class `anchor` / `journal` / `pinned_zone` accessors (read from on-disk message stream, INV-10)
- [x] 2.5 Implement `recallMessage(sessionId?, msgId)` in `memory.ts` with idempotency check (DD-7, INV-9)
- [ ] 2.6 Implement `LLM_compact` core in `compaction.ts` — single-pass mode, calls EXT-LLM with framing prompt, returns anchor body (DD-3)
- [ ] 2.7 Implement `LLM_compact` chunk-and-merge mode (sequential digest accumulation when input > LLM input budget) (DD-3 internal mode)
- [ ] 2.8 Implement output validators per `hybrid-llm-framing.md` §"Output validation" (header regex, size, strict-smaller, forbidden tokens, drop respected)
- [ ] 2.9 Implement `runHybridLlmWithRecovery` wrapper: sanity check → 1 retry with stricter framing → optional fallback provider → graceful degradation (truncate journal from oldest) (DD-6, INV-2)
- [ ] 2.10 Implement Phase 2 path: stricter framing, absorb pinned_zone, clear pinned_zone after success (DD-5, DD-9)
- [ ] 2.11 Implement Phase 2 starvation handling: raise `E_OVERFLOW_UNRECOVERABLE` if Phase 2 still overflows (no Phase 3) (DD-9, INV-6)
- [ ] 2.12 Rewrite `KIND_CHAIN` in `compaction.ts` to single entry `hybrid_llm`; delete `tryReplayTail` / `tryLowCostServer` / `tryLlmAgent` / `tryChunkedDigest` / `tryNarrative` (DD-3, DD-12)
- [ ] 2.13 Rewrite `prompt.ts::buildPrompt` to enforce 5-zone canonical order with assertion (DD-1, INV-1)
- [ ] 2.14 Implement pinned_zone materialisation: wrap each pinned tool_result as user-role envelope per DD-4 (closes G-1, INV-4)
- [ ] 2.15 Implement pinned_zone cap check forcing Phase 2 when `pinnedZoneTokens > pinnedZoneCap` (DD-5)
- [ ] 2.16 Implement migration matrix per DD-10: old narrative anchor accepted; no-anchor → cold-start; SharedContext relics ignored
- [ ] 2.17 Add fixtures TV-3..TV-7, TV-10..TV-16, TV-20 to `test-vectors.json` and write `bun test` runners
- [ ] 2.18 Cross-provider regression test (TV-13): runHybridLlm against gpt-5.x / anthropic / codex / google with the same input; verify schema-compliant outputs (DD-11, INV-5, R-11)
- [ ] 2.19 Failure injection tests (TV-10/11/12) for `E_HYBRID_LLM_FAILED` / `_TIMEOUT` / `_MALFORMED`
- [ ] 2.20 Daemon-restart test (TV-20) for INV-10
- [ ] 2.21 Cache hit-rate measurement: capture pre-merge baseline, measure post-merge at 80–90% utilisation; gate merge if regression > 5pp
- [ ] 2.22 Update `specs/architecture.md` Compaction Subsystem section (rewrite for hybrid-llm)
- [ ] 2.23 Phase 2 summary: write `docs/events/event_<YYYYMMDD>_hybrid-llm-landing.md`

## 3. Phase 3 — Layer 3 context visibility

Goal: AI sees its own budget state continuously. Closes the visibility
gap that makes Layer 4-5 usable.

- [ ] 3.1 Implement `ContextStatusBuilder` in `prompt.ts` computing total/used/remaining/anchor-cover/journal-depth/pinned-tokens fields (R-5)
- [ ] 3.2 Decide DD-S2: system-role injection vs dedicated metadata channel; implement chosen mechanism
- [ ] 3.3 Write `packages/opencode/src/session/prompt/agent-budget-guideline.md` system-prompt fragment teaching AI to use visibility
- [ ] 3.4 Wire status block into every prompt-build round
- [ ] 3.5 Add fixture for visibility presence (no behaviour change required)
- [ ] 3.6 Phase 3 summary: write `docs/events/event_<YYYYMMDD>_context-visibility.md`

## 4. Phase 4 — Layer 4 voluntary summarize

Goal: AI can invoke compaction before harness gate fires. Built on
Phase 3's visibility.

- [ ] 4.1 Implement `compact_now` tool in `packages/opencode/src/tool/compact-now.ts` (DD-14)
- [ ] 4.2 Register tool with `compaction.voluntarySummarize.enabled` flag default true
- [ ] 4.3 Tool handler invokes `runHybridLlmWithRecovery` from Phase 2 (no separate code path)
- [ ] 4.4 Tool returns post-compaction status `{room_remaining_after, anchor_size, status}` (R-6)
- [ ] 4.5 Update `agent-budget-guideline.md` to teach AI when to call `compact_now`
- [ ] 4.6 Add TV-19 (voluntary summarize) test
- [ ] 4.7 Telemetry: ensure `voluntary:true` flag in CompactionEvent for tool-triggered compactions
- [ ] 4.8 Phase 4 summary: write `docs/events/event_<YYYYMMDD>_compact-now.md`

## 5. Phase 5 — Layer 5 override surface (pin / drop / recall + admin UI)

Goal: AI and humans can explicitly steer compaction. Last layer; the
nice-to-have surface for cases where automatic behaviour misses.

- [ ] 5.1 Document `message.metadata.contextMarkers` schema in `packages/opencode/src/session/message-v2.ts` (DD-15)
- [ ] 5.2 Implement `OverrideParser` in `prompt.ts` (walks recent assistant messages, extracts pin/drop/recall, applies pre-prompt-build) (DD-15)
- [ ] 5.3 Wire pin → PinnedZoneEntry append (uses existing Phase 2 materialisation from 2.14)
- [ ] 5.4 Wire drop → drop set added to `LLMCompactRequest.dropMarkers` for next compaction
- [ ] 5.5 Wire recall → uses `recallMessage` from Phase 2 (2.5)
- [ ] 5.6 Add admin-panel UI: list view of pinned_zone, drop log, recall search (minimum click-to-pin / click-to-drop / search-and-recall)
- [ ] 5.7 Add TUI keybindings for the same operations
- [ ] 5.8 Add TV-7, TV-8, TV-9 (pin envelope, recall idempotency, cross-session recall) fixtures
- [ ] 5.9 Telemetry: pin density alert in observability dashboard
- [ ] 5.10 Update `specs/architecture.md` with Override Channel section
- [ ] 5.11 Phase 5 summary: write `docs/events/event_<YYYYMMDD>_override-channel.md`

---

## Notation legend (per plan-builder §16.2)

- `- [ ]` pending
- `- [~]` in_progress (exactly one across the active phase)
- `- [x]` completed
- `- [>]` delegated to subagent (with subagent identity inline)
- `- [!]` blocked (with reason inline)
- `- [?]` needs user decision (with question inline)
- `- [-]` cancelled (strikethrough + reason; line preserved)
