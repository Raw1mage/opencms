# Event 2026-05-03: prompt-cache-and-compaction-hardening Phase A landed

Spec: [`specs/prompt-cache-and-compaction-hardening/`](../../specs/prompt-cache-and-compaction-hardening/)
Lifecycle: `implementing` → `verified`
Beta worktree: `/home/pkcs12/projects/opencode-worktrees/prompt-cache-hardening` (retained for Phase B)
Beta branch: `beta/prompt-cache-hardening` (retained for Phase B)
Merge commits on main:

- `000e5aeea` — specs package (14 files)
- `002e77b26` — `merge --no-ff beta/prompt-cache-hardening` (5 implementation commits, 13 src files, +1147/-6)
- `abcd06ffc` — Phase A wiring test for DD-9

## What landed

5 design decisions, all additive, zero schema change. Phase B (system block static/preface split + 4-breakpoint allocator) is NOT in this drop and remains gated behind separate user approval per [tasks.md §8](../../specs/prompt-cache-and-compaction-hardening/tasks.md).

### DD-6 — Anchor sanitizer ([anchor-sanitizer.ts](../../packages/opencode/src/session/anchor-sanitizer.ts))

Wraps every compaction anchor body in `<prior_context source="{kind}">…</prior_context>` and softens imperative-leading lines (`You must…`, `Always…`, `Rules:`, etc.) with a `Note from prior context: ` prefix. Pure string transform, byte-deterministic. Wired into `defaultWriteAnchor` (compaction.ts ~L1827) for narrative / replay-tail / low-cost-server kinds; `tryLlmAgent` performs equivalent sanitization on each generated text part inline.

Why: prior compaction left raw imperative LLM-summary text in history. The next turn's LLM weights recent conversation heavily, so those imperatives competed with L7 SYSTEM.md authority.

### DD-7 — Idle compaction clean-tail gate ([idle-compaction-gate.ts](../../packages/opencode/src/session/idle-compaction-gate.ts))

`checkCleanTail(messages, windowSize=2)` scans the trailing 2 messages for tool parts whose `state.status` is `pending` or `running`. If any are found, `idleCompaction` emits `compaction.idle.deferred` and early-returns. Adapted to opencode's single-`ToolPart`-with-state-machine model (not Anthropic-style `tool_use`+`tool_result`).

Why: writing an anchor mid tool-use truncates the persisted stream in a way the next provider call rejects (Anthropic strict pairing).

### DD-8 — CapabilityLayer cross-account hard-fail ([capability-layer.ts](../../packages/opencode/src/session/capability-layer.ts))

`CapabilityLayer.get(sessionID, epoch, requestedAccountId?)` now refuses to return a fallback entry whose `accountId` differs from the caller's. Throws `CrossAccountRebindError(from, to, failures)` instead. Same-account fallback (transient loader failure) keeps the existing WARN + degraded behavior. `prompt.ts` runloop catches `instanceof CrossAccountRebindError` and re-throws after structured logging; other errors stay non-fatal.

Why: AGENTS.md §1 prohibits silent fallback. Pre-fix, a cross-account rebind failure would silently use the previous account's BIOS (driver / AGENTS.md / enablement) bound to the new account's auth — a correctness violation, not a tolerable degraded mode.

### DD-9 — Skill auto-pin + anchor binding ([skill-layer-registry.ts](../../packages/opencode/src/session/skill-layer-registry.ts))

After every anchor write, `annotateAnchorWithSkillState`:

1. scans the sanitized body for known skill names via `scanReferences` (word-boundary regex)
2. calls `pinForAnchor(anchorId)` for each match → entry's `pinnedByAnchors: Set<string>` adds `anchorId`
3. when a new anchor supersedes the previous one, `unpinByAnchor(prevAnchorId)` removes that anchorId; entry only fully unpins when the set is empty

Why: skills referenced inside the compacted span used to lose their on-disk reference and get idle-decayed. Now they survive until the next anchor supersedes the one that pinned them.

### DD-10 — Cache-miss diagnostic ([cache-miss-diagnostic.ts](../../packages/opencode/src/session/cache-miss-diagnostic.ts))

Per session, rolling sha256 window of size 3 over `system.join("\n")`, recorded in `llm.ts` immediately after assembly + plugin transform (line 611). `shouldCacheAwareCompact` consults `diagnoseCacheMiss` after its existing predicates pass; classifies into `system-prefix-churn` (hashes vary → no compaction) / `conversation-growth` (hashes equal + tail > 40K → compact) / `neither`. In-memory, cleared via `Bus.subscribe(session.deleted)`.

Why: AGENTS.md edits, account switches, and model swaps all invalidate prompt cache without conversation growing. Pre-fix, cache-aware compaction would fire for these and waste a compaction round on a non-conversation problem.

## Validation gate ([tasks.md §6 + §7](../../specs/prompt-cache-and-compaction-hardening/tasks.md))

| Step | Status | Evidence |
|---|---|---|
| 6.1 unit tests | ✅ 57/57 | `bun test` 5 files / 108 expect calls |
| 6.2 typecheck | ✅ 0 new errors in touched files | pre-existing errors in share-next.ts / codex-provider / console-function are orthogonal (verified on main pre-merge) |
| 6.3 manual smoke | ⏳ deferred | needs live session + DD-8 cross-account UI verification + telemetry log inspection |
| 6.4 phase summary | ✅ this doc |  |
| 6.5 rebase | ✅ twice clean | onto `c27a127e8` then `09b0faa72`; zero conflicts |
| 6.6 fetch-back via test branch | N/A | rebase had zero overlap with main's `incoming/*` changes; intermediate test branch added zero signal |
| 6.7 STOP for finalize | ✅ | user approval 2026-05-03 |
| 7.1 `merge --no-ff` | ✅ | merge commit `002e77b26` |
| 7.2 delete test branch | N/A | none created |
| 7.3 retain beta branch + worktree for Phase B | ✅ | both retained |

## Coverage of the 5 DDs

| DD | Unit tests | Wiring/integration | Notes |
|---|---|---|---|
| DD-6 | 23 (anchor-sanitizer.test.ts) | source inspection | end-to-end behavioral wiring test attempted but blocked by closure-scope reference to `compactWithSharedContext` inside SessionCompaction namespace; documented in [compaction.phase-a-wiring.test.ts](../../packages/opencode/src/session/compaction.phase-a-wiring.test.ts) header |
| DD-7 | 9 (idle-compaction-gate.test.ts) | source inspection | wiring is 7-line early-return, low risk |
| DD-8 | 5 (capability-layer.cross-account.test.ts) | source inspection of prompt.ts catch | `CrossAccountRebindError` re-throw path needs runloop UI verification (deferred to manual smoke) |
| DD-9 | 11 (skill-anchor-binder.test.ts) | **4 wiring tests** (compaction.phase-a-wiring.test.ts) | end-to-end through `SessionCompaction.run → defaultWriteAnchor → annotateAnchorWithSkillState → SkillLayerRegistry.pinForAnchor` |
| DD-10 | 9 (cache-miss-diagnostic.test.ts) | source inspection | hook is single-line `recordSystemBlockHash(input.sessionID, system.join("\n"))` after llm.ts assembly |

Total Phase A coverage: 57 unit tests + 4 wiring tests = **61 tests / 117 expect calls / 0 fail**. Existing 32 compaction integration tests still green (no regression).

## Cost / risk profile

- **Schema**: zero migration. Existing sessions' anchor messages remain readable; new sessions write the new wrapped form.
- **Memory**: two new in-memory maps (cache hashes per session + `pinnedByAnchors: Set<string>` per skill entry), both cleaned via `session.deleted` Bus subscription.
- **Hot path**: one sha256 per turn (system block, ~few KB → < 1ms) + one 2-message slice + status scan per `idleCompaction` invocation.
- **Visible behavior change**:
  - Compacted sessions: history rendering will show `<prior_context source="…">` wrapper; `Note from prior context: ` prefix on previously-imperative lines
  - DD-8 hard-fail: a previously-silent cross-account rebind failure now surfaces as a structured error (rare path)
  - DD-7 + DD-10 reduce false-positive compaction triggers; users observe slightly fewer compaction toasts under churning AGENTS.md / pending-tool conditions
- **Rollback**: 5 implementation commits + 1 spec commit + 1 test commit = 7 reverts. All additive except the prompt.ts catch block (in-place 1-line warn → if/else with throw), which reverts cleanly.

## What's deferred

### Manual smoke (§6.3) — pending an opportunity
- DD-8: stage a real cross-account capability-layer load failure; verify the `CrossAccountRebindError` surfaces as a clear UI red message rather than a daemon panic / retry loop.
- DD-10: open a 5-turn session; grep daemon log for `compaction.cache_miss_diagnosis` events; confirm hashes appear in rolling form.
- DD-6 end-to-end: trigger `/compact` manually; grep the persisted message stream for `<prior_context source="narrative">`.

### Phase B — gated, separate user approval required
[tasks.md §8](../../specs/prompt-cache-and-compaction-hardening/tasks.md):
- B.1–B.4: ContextPrefaceBuilder + StaticSystemBuilder + structured PreloadProvider
- B.5: transform.ts applyCaching → 4-breakpoint allocator
- B.6: new plugin hook `experimental.chat.context.transform`
- B.7: SkillLayerRegistry → ContextPrefaceBuilder seam
- B.8: docs/prompt_injection.md rewrite + new docs/prompt_dynamic_context.md
- B.9: feature flag `OPENCODE_PROMPT_PREFACE`
- B.10: 1-week dogfood + BP1/BP2/BP3 hit-rate measurement
- B.11: default-on (third stop gate)

Phase B unlocks the actual cache hit-rate gains; Phase A is the prerequisite that makes the new layout safe to introduce (sanitizer + clean-tail gate + cache-miss diagnostic + cross-account refusal all become load-bearing once the static/dynamic split goes in).

## Drift

None. plan-sync clean. `.state.json` history records both rebase syncs (2026-05-03 12:00 onto `c27a127e8`, 2026-05-03 13:00 onto `09b0faa72`) and the `verified` promotion at 2026-05-03 13:30.
