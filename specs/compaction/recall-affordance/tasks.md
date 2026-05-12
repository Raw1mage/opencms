# Tasks — compaction_recall-affordance

## M1 — L2: Recall capability (foundation)

- [x] M1-1: Extend `Memory.Hybrid` in [packages/opencode/src/session/memory.ts](packages/opencode/src/session/memory.ts) with `recallByCallId(sessionID: string, callID: string): Promise<MessageV2.ToolPart | null>`. Sibling to `recallMessage`. Scan implementation: `Session.messages` → walk msgs → walk parts → first match on `ToolPart.callID`. Document idempotence (INV-4) and lookup semantics inline.
- [x] M1-2: Create [packages/opencode/src/tool/recall.ts](packages/opencode/src/tool/recall.ts) defining `RecallTool` via `Tool.define`. Parameters: zod object `{ tool_call_id: z.string().min(1) }` with thorough description. Execute body: call `recallByCallId`, branch on null vs found, build `RecallOutput` per data-schema.json. Telemetry: log via `Log.create({ service: "tool.recall" })`.
- [x] M1-3: Register `RecallTool` in [packages/opencode/src/tool/registry.ts](packages/opencode/src/tool/registry.ts#L147) adjacent to `RereadAttachmentTool` (both are voucher-style recovery tools).
- [x] M1-4: Add unit tests at `packages/opencode/src/tool/recall.test.ts` covering all `L2_RecallTool` and `L2_recallByCallId_helper` cases in test-vectors.json. Cases must include found/not-found/redundant/empty-string/zod-validation.
- [x] M1-5: Add a `recall.txt` description-only file at `packages/opencode/src/tool/recall.txt` if other tools use that pattern; otherwise inline the description in `recall.ts`. (Check existing convention: `bash.txt`, `read.txt` etc. are loaded separately.)

## M2 — L1: TOOL_INDEX emission

- [x] M2-1: Modify `buildUserPayload` in [packages/opencode/src/session/compaction.ts:3120](packages/opencode/src/session/compaction.ts#L3120). After the existing `Produce the new anchor body now.` instruction, append: "After the prose narrative, emit a fenced ## TOOL_INDEX section. Columns: tool_call_id, tool_name, args_brief (≤80 chars), status, output_chars. Include every tool call seen in JOURNAL; preserve tool_call_id values verbatim."
- [x] M2-2: Implement `validateToolIndex(body: string): { found: boolean; entryCount: number; indexBytes: number }` helper in `compaction.ts` (or new `tool-index.ts` submodule). Tolerant regex: matches `## TOOL_INDEX` followed by markdown table; counts non-header rows. See `L1_validateToolIndex` test vectors for tolerance cases.
- [x] M2-3: Hook validator into `defaultWriteAnchor` ([compaction.ts:2581](packages/opencode/src/session/compaction.ts#L2581)) after `sanitized = sanitizeAnchorToString(...)`. Publish `compaction.tool_index.{emitted,missing}` on Bus.
- [x] M2-4: Pre-build a synthetic TOOL_INDEX from `journalUnpinned` and inject it as **example** in the prompt (not a hard inject — the LLM still produces the body). This nudges the LLM toward consistent formatting. Trim args_brief to 80 chars per data-schema.json.
- [x] M2-5: Honour INV-6 size ceiling: if computed index would exceed `targetTokens * 0.1` (10% of anchor budget), truncate older entries and emit `truncated_count` field.
- [x] M2-6: Unit tests in `compaction.tool-index.test.ts` covering `L1_buildUserPayload_tool_index_instruction` and `L1_validateToolIndex` vectors.

## M3 — L3: Rebind-aware system note

- [x] M3-1: Identify the prompt-block assembly site in [packages/opencode/src/session/prompt.ts](packages/opencode/src/session/prompt.ts). Likely just before the `bus.llm.prompt.telemetry` publish near `prompt.bundle.assembled`. Read the most-recent anchor metadata (via `Memory.Hybrid.getAnchorMessage`).
- [x] M3-2: Implement the kind check: if `anchorMessage.kind === "narrative"` (where is `kind` stored? — investigate MessageV2.Assistant or compaction metadata at write time), inject `system_block_amnesia_notice`. If `kind` is not currently persisted on the anchor message, add it during the M2 anchor-write path.
- [x] M3-3: Implement block injection: extend the prompt-build block list with `{ key: 'system_block_amnesia_notice', name: 'Amnesia / Recall Notice', chars, tokens, injected: true, policy: 'session_stable_until_next_anchor' }`. Block content per spec.md L3 section.
- [x] M3-4: Publish `prompt.amnesia_notice.injected` telemetry on every injection.
- [x] M3-5: Unit tests at `packages/opencode/src/session/prompt.amnesia-notice.test.ts` covering `L3_amnesia_notice_injection` vectors. Must include: narrative present → injected; hybrid_llm present → not injected; no anchor → not injected; narrative superseded by hybrid_llm → not injected.

## M4 — Integration + smoke

- [x] M4-1: End-to-end vitest at `packages/opencode/src/session/recall-affordance.integration.test.ts` per `integration_end_to_end` in test-vectors.json. Uses real Session API + in-memory storage.
- [x] M4-2: Run `bun typecheck` (or equivalent) at repo root; resolve type errors.
- [x] M4-3: Run targeted vitest suite: `bun test packages/opencode/src/tool/recall.test.ts packages/opencode/src/session/compaction.tool-index.test.ts packages/opencode/src/session/prompt.amnesia-notice.test.ts packages/opencode/src/session/recall-affordance.integration.test.ts`.

## M5 — Beta workflow + handoff

- [x] M5-1: Code lives in `~/projects/opencode-beta` worktree on a `beta/compaction-recall-affordance` branch.
- [x] M5-2: Spec artifacts (this folder under `/plans/compaction_recall-affordance/`) live on the **main repo** `main` branch per MEMORY commit-split rule. Do NOT bundle docs with code commits.
- [x] M5-3: Commit code in beta worktree; commit docs in main repo. Cross-reference the beta commit hash in the main repo's spec README.
- [x] M5-4: Fetchback per MEMORY "Fetch-back Inside Main Repo (NOT Worktree)" rule: from main repo, merge beta branch when ready. Narrow-commit any working-tree blocks instead of auto-stash.
- [x] M5-5: STOP before daemon restart. Surface diff summary; wait for user consent per MEMORY restart-consent rule. (Honoured 4× during deployment — operator-driven restarts at each fix point.)

## Notes for AI executing M1–M3

- Always read the existing file before editing to align with house style.
- `Tool.define` takes (id, definition); check `packages/opencode/src/tool/tool.ts:54-71` for `Info` shape.
- Path aliases: `@/session`, `@/util/log`, `@/config/tweaks`, etc. — see `tsconfig.json`.
- Existing telemetry log instances: use `Log.create({ service: "..." })` pattern from `bash.ts` or `reread-attachment.ts`.
- For TOOL_INDEX inside the LLM prompt: be explicit. LLMs tend to omit structured sections unless the instruction is unambiguous. Include a 2-row inline example in the prompt instruction.
- Anchor `kind` field: verify where this lands in the persisted anchor message. If MessageV2.Assistant doesn't have a `kind` field today, the M3 work needs a schema extension (and migration consideration for existing anchors).

## Implementation deltas vs original task list

- **M1-5**: chose inline tool description in `recall.ts` (no `recall.txt`). Existing tools split when the description grows long; recall's description is ≤500 chars so inline is appropriate.
- **M3-2 (Q1 resolution)**: anchor `kind` is NOT persisted on `MessageV2.Assistant` (verified no schema field exists today). Instead read kind from `session.execution.recentEvents` ring buffer — last entry with `kind="compaction"` carries `compaction.kind`. This avoided schema migration concerns. The decision exposed a related pre-existing bug (recentEvents wiped on rotation) which produced fix `f79375ec1`.
- **M2-1/M2-4**: prompt-side instruction landed in `buildUserPayload` as planned, but the LLM-path is no longer load-bearing — `cc6d4ac06` later moved TOOL_INDEX to server-side authoritative injection in `defaultWriteAnchor`. LLM compliance is now an optional secondary signal; server always writes the correct index. This handles narrative path (which never goes through `buildUserPayload`).
- **M3-1**: amnesia notice injected as a ContextFragment (`buildAmnesiaNoticeFragment`) inside `userBundle`, not as a separate system_block. Cleaner integration with existing fragment pipeline; behaviour identical.

## Validation evidence

### Automated tests (all green at 2026-05-12)

| Layer | File | Tests |
|---|---|---|
| L2 helper | `memory.recall-by-call-id.test.ts` | 7 pass |
| L1 module | `tool-index.test.ts` + `tool-index.strip.test.ts` | 26 pass |
| L3 fragment | `context-fragments/amnesia-notice.test.ts` | 12 pass |
| **Total new** | — | **45 pass / 0 fail** |
| Regression sweep | `compaction*.test.ts` (12 files) | 110 pass / 0 fail |
| Typecheck | `bun x tsc --noEmit` | **0 errors** |

### Production telemetry (ses_1e738d1c8ffeen3y8zPoXjsQ02)

- **L1 verified** at 06:36 compaction: `compaction.tool_index.injected entryCount=216 truncatedCount=299 origBytes=328965 newBytes=276769`; validator `compaction.tool_index.emitted entryCount=200 indexBytes=30010`.
- **L3 verified** by repeated `prompt.amnesia_notice.injected anchorKind=narrative` events; `userBundle.fragmentIds` shows `amnesia_notice` injected every turn until next compaction supersedes.
- **identity-preserve verified** by 7-event `recentEvents` trace surviving 3 rotations + 4 narrative compactions (would have been wiped pre-`f79375ec1`).

### Operator verdict

> 「截至目前為止沒再遇到跳針健忘。」 — 2026-05-12 user confirmation after deployment.

The success criterion that motivated the entire plan (eliminate 跳針/失憶 in rebind+narrative compaction path) is met.

### Supplementary fixes landed alongside (separate commits, traceable on test branch)

- `ff30c96f2` `/file/stat` 404 + path fallback (SPA black-screen on missing svg)
- `5fece4522` `/file/content` 404 when file gone (no disk + no git HEAD)
- `6f22868df` `stripAllSections` — fixes dialog-tail loss on chained compactions
- `4a126754c` `recall` added to `ALWAYS_PRESENT_TOOLS` (L3 promise made deliverable)
- `f79375ec1` `nextExecutionIdentity` preserves `recentEvents` + `activeImageRefs`

Final merged into `main` at `169f9e974`.
