# Tasks — compaction_recall-affordance

## M1 — L2: Recall capability (foundation)

- [ ] M1-1: Extend `Memory.Hybrid` in [packages/opencode/src/session/memory.ts](packages/opencode/src/session/memory.ts) with `recallByCallId(sessionID: string, callID: string): Promise<MessageV2.ToolPart | null>`. Sibling to `recallMessage`. Scan implementation: `Session.messages` → walk msgs → walk parts → first match on `ToolPart.callID`. Document idempotence (INV-4) and lookup semantics inline.
- [ ] M1-2: Create [packages/opencode/src/tool/recall.ts](packages/opencode/src/tool/recall.ts) defining `RecallTool` via `Tool.define`. Parameters: zod object `{ tool_call_id: z.string().min(1) }` with thorough description. Execute body: call `recallByCallId`, branch on null vs found, build `RecallOutput` per data-schema.json. Telemetry: log via `Log.create({ service: "tool.recall" })`.
- [ ] M1-3: Register `RecallTool` in [packages/opencode/src/tool/registry.ts](packages/opencode/src/tool/registry.ts#L147) adjacent to `RereadAttachmentTool` (both are voucher-style recovery tools).
- [ ] M1-4: Add unit tests at `packages/opencode/src/tool/recall.test.ts` covering all `L2_RecallTool` and `L2_recallByCallId_helper` cases in test-vectors.json. Cases must include found/not-found/redundant/empty-string/zod-validation.
- [ ] M1-5: Add a `recall.txt` description-only file at `packages/opencode/src/tool/recall.txt` if other tools use that pattern; otherwise inline the description in `recall.ts`. (Check existing convention: `bash.txt`, `read.txt` etc. are loaded separately.)

## M2 — L1: TOOL_INDEX emission

- [ ] M2-1: Modify `buildUserPayload` in [packages/opencode/src/session/compaction.ts:3120](packages/opencode/src/session/compaction.ts#L3120). After the existing `Produce the new anchor body now.` instruction, append: "After the prose narrative, emit a fenced ## TOOL_INDEX section. Columns: tool_call_id, tool_name, args_brief (≤80 chars), status, output_chars. Include every tool call seen in JOURNAL; preserve tool_call_id values verbatim."
- [ ] M2-2: Implement `validateToolIndex(body: string): { found: boolean; entryCount: number; indexBytes: number }` helper in `compaction.ts` (or new `tool-index.ts` submodule). Tolerant regex: matches `## TOOL_INDEX` followed by markdown table; counts non-header rows. See `L1_validateToolIndex` test vectors for tolerance cases.
- [ ] M2-3: Hook validator into `defaultWriteAnchor` ([compaction.ts:2581](packages/opencode/src/session/compaction.ts#L2581)) after `sanitized = sanitizeAnchorToString(...)`. Publish `compaction.tool_index.{emitted,missing}` on Bus.
- [ ] M2-4: Pre-build a synthetic TOOL_INDEX from `journalUnpinned` and inject it as **example** in the prompt (not a hard inject — the LLM still produces the body). This nudges the LLM toward consistent formatting. Trim args_brief to 80 chars per data-schema.json.
- [ ] M2-5: Honour INV-6 size ceiling: if computed index would exceed `targetTokens * 0.1` (10% of anchor budget), truncate older entries and emit `truncated_count` field.
- [ ] M2-6: Unit tests in `compaction.tool-index.test.ts` covering `L1_buildUserPayload_tool_index_instruction` and `L1_validateToolIndex` vectors.

## M3 — L3: Rebind-aware system note

- [ ] M3-1: Identify the prompt-block assembly site in [packages/opencode/src/session/prompt.ts](packages/opencode/src/session/prompt.ts). Likely just before the `bus.llm.prompt.telemetry` publish near `prompt.bundle.assembled`. Read the most-recent anchor metadata (via `Memory.Hybrid.getAnchorMessage`).
- [ ] M3-2: Implement the kind check: if `anchorMessage.kind === "narrative"` (where is `kind` stored? — investigate MessageV2.Assistant or compaction metadata at write time), inject `system_block_amnesia_notice`. If `kind` is not currently persisted on the anchor message, add it during the M2 anchor-write path.
- [ ] M3-3: Implement block injection: extend the prompt-build block list with `{ key: 'system_block_amnesia_notice', name: 'Amnesia / Recall Notice', chars, tokens, injected: true, policy: 'session_stable_until_next_anchor' }`. Block content per spec.md L3 section.
- [ ] M3-4: Publish `prompt.amnesia_notice.injected` telemetry on every injection.
- [ ] M3-5: Unit tests at `packages/opencode/src/session/prompt.amnesia-notice.test.ts` covering `L3_amnesia_notice_injection` vectors. Must include: narrative present → injected; hybrid_llm present → not injected; no anchor → not injected; narrative superseded by hybrid_llm → not injected.

## M4 — Integration + smoke

- [ ] M4-1: End-to-end vitest at `packages/opencode/src/session/recall-affordance.integration.test.ts` per `integration_end_to_end` in test-vectors.json. Uses real Session API + in-memory storage.
- [ ] M4-2: Run `bun typecheck` (or equivalent) at repo root; resolve type errors.
- [ ] M4-3: Run targeted vitest suite: `bun test packages/opencode/src/tool/recall.test.ts packages/opencode/src/session/compaction.tool-index.test.ts packages/opencode/src/session/prompt.amnesia-notice.test.ts packages/opencode/src/session/recall-affordance.integration.test.ts`.

## M5 — Beta workflow + handoff

- [ ] M5-1: Code lives in `~/projects/opencode-beta` worktree on a `beta/compaction-recall-affordance` branch.
- [ ] M5-2: Spec artifacts (this folder under `/plans/compaction_recall-affordance/`) live on the **main repo** `main` branch per MEMORY commit-split rule. Do NOT bundle docs with code commits.
- [ ] M5-3: Commit code in beta worktree; commit docs in main repo. Cross-reference the beta commit hash in the main repo's spec README.
- [ ] M5-4: Fetchback per MEMORY "Fetch-back Inside Main Repo (NOT Worktree)" rule: from main repo, merge beta branch when ready. Narrow-commit any working-tree blocks instead of auto-stash.
- [ ] M5-5: STOP before daemon restart. Surface diff summary; wait for user consent per MEMORY restart-consent rule.

## Notes for AI executing M1–M3

- Always read the existing file before editing to align with house style.
- `Tool.define` takes (id, definition); check `packages/opencode/src/tool/tool.ts:54-71` for `Info` shape.
- Path aliases: `@/session`, `@/util/log`, `@/config/tweaks`, etc. — see `tsconfig.json`.
- Existing telemetry log instances: use `Log.create({ service: "..." })` pattern from `bash.ts` or `reread-attachment.ts`.
- For TOOL_INDEX inside the LLM prompt: be explicit. LLMs tend to omit structured sections unless the instruction is unambiguous. Include a 2-row inline example in the prompt instruction.
- Anchor `kind` field: verify where this lands in the persisted anchor message. If MessageV2.Assistant doesn't have a `kind` field today, the M3 work needs a schema extension (and migration consideration for existing anchors).
