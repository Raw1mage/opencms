# Design: compaction-improvements

## Context

The existing compaction subsystem is message-stream anchored: anchors are assistant summary messages, cooldown is derived from anchor time, and memory is a render-time view over the stream. This plan extends that architecture rather than adding separate persistence files.

## Goals / Non-Goals

### Goals

- Predict high-cost cache loss when context is already above 50%.
- Prefer codex server-side compaction for subscription users.
- Remove known edge-case crashes and stale-state decisions.
- Surface context budget facts to the LLM without prescribing workflow.
- Route oversized boundary content by reference.

### Non-Goals

- No new silent fallback mechanisms.
- No replacement of existing local compaction kinds.
- No UI workflow forcing LLM digestion behavior.
- No cross-session raw-content sharing.

## Decisions

- **DD-1** Keep the message stream as compaction SSOT. New state must be derived from anchors, session execution metadata, or session-scoped KV; no parallel journal file.
- **DD-2** Phase A starts with low-risk edge cleanups before new predictive triggers, so existing compaction behavior becomes safer before routing changes land.
- **DD-3** Codex-specific economics live in compaction/provider boundaries, not in generic prompt control flow.
- **DD-4** Budget surfacing uses provider-confirmed usage from the previous completed round only; no local token estimation is exposed as truth.
- **DD-5** Big content routing is fail-fast: storage or worker failure surfaces an explicit error/reference issue rather than injecting raw oversized content.
- **DD-6** Resolve all original open questions before continuing Phase C build. The decisions below supersede `proposal.md` Open Questions Q1-Q26 and are the execution contract for the remaining tasks.

### Open Question Resolution Matrix

| Q | Decision | Execution impact |
|---|---|---|
| Q1 cache breakpoint alignment | Anthropic hash boundary follows the last explicit `cache_control` marker when present; if the adapter cannot expose a stable marker boundary, hash the full serialized prefix. Codex hashes the full Responses prefix. | CacheStateTracker must record the boundary source (`explicit-cache-control` or `full-prefix`) for telemetry and tests. |
| Q2 `predictMiss == "unknown"` policy | Unknown is non-firing for B1. It falls through to observed cache-miss B2; no aggressive high-context fire on unknown. | Prevents fallback-like speculative compaction and keeps B1 evidence-based. |
| Q3 TTL value | Use per-provider TTL with defaults: Anthropic ephemeral 270s safety margin, Anthropic long-lived cache only when response metadata proves it, Codex 270s until provider evidence says otherwise. | Store TTL source in tracker; bad or missing config is explicit error, not silent default beyond compiled defaults. |
| Q4 B3 quota field model | Defer B3 shipping until codex `rate_limits` schema is pinned by observed provider payload tests. B3 remains inventory-listed but disabled by default. | Phase C may implement predicate shape but must not enable B3 fire without schema fixture coverage. |
| Q5 A4 stall vs autonomous silence | A4 only counts consecutive empty assistant responses that follow an actual user/self-heal prompt and have server usage evidence. It ignores silent-stop continuation states and completed autonomous phases. | Requires source classification in tests; A4 must not fire just because the agent correctly stops silently. |
| Q6 manual `/compact` gates | Manual `/compact` bypasses threshold predicates but not hard safety guards: last-user presence, no mid-assistant-turn, no child compaction loop. | Manual remains force-fire for user intent while avoiding known crash paths. |
| Q7 subscription helper location | Expose provider/auth truth through a small compaction-facing facade; codex-auth owns OAuth/subscription detection, compaction consumes a provider-neutral capability result. | Keeps codex-specific auth parsing out of `prompt.ts` and avoids global account fallback. |
| Q8 `openai` provider gate | Treat `openai` as API-key/non-subscription unless a future explicit OAuth subscription capability is added. | No Mode 1 priority for `openai` today; fail closed. |
| Q9 compaction item part type | Add a dedicated `MessageV2.CompactionItemPart` for codex server compaction output. Do not repurpose generic assistant text/tool parts. | Makes Mode 1 preservation explicit and prevents pruning by text-oriented cleanup. |
| Q10 Mode 1 injection point | Prefer codex provider request construction/interceptor boundary, not generic prompt control flow. If AI SDK cannot pass `context_management`, use the existing codex-compaction direct request shaping path. | Phase C must read provider request path before implementing; no guessed SDK field. |
| Q11 telemetry retention | Emit all fire decisions and guard blocks. Sample non-fire predicate evaluations at 10% by default, with a tweaks override. | Bounds volume while retaining evidence for rare fires and blocked states. |
| Q12 no mid-assistant-turn guard | Safe condition is `lastFinished.id === lastAssistantInStream.id` and a last user message exists before that assistant. | This exact predicate becomes trigger inventory test coverage. |
| Q13 phase ordering vs compaction-redesign phase 13 | Interleave only the independent cleanup pieces already in Phase A/B. Cooldown anchor-time unification remains blocked on compaction-redesign phase 13 verification. | Do not implement Phase C cooldown semantics beyond guards until dependency evidence is present. |
| Q14 Part 6 KV namespace/retention | Attachment refs are session-scoped and retained with session storage. Cleanup follows session deletion/compaction storage GC; no cross-session lookup. | KV keys include session namespace; missing ref is explicit tool error. |
| Q15 subagent return write timing | Parent `Task` tool writes oversized child result into the parent session namespace after child completion and before returning tool_result to parent. | Avoids dead child context writes and preserves parent-readable refs. |
| Q16 preview fallback chain | TLDR extraction first, worker preview second. If worker preview fails, return a small explicit error/reference stub with ref metadata; do not inject first-N raw chars as fallback. | Maintains fail-fast/no raw oversized content invariant. |
| Q17 5K subagent threshold | Keep 5K as initial conservative default but add telemetry before tuning; threshold is configurable via tweaks. | Phase D/E must record observed distribution before changing default. |
| Q18 image/text thresholds | Threshold after cheap normalization metadata, not after expensive LLM digest. Images may be downscaled only inside worker/query path; upload boundary still routes by estimated raw model cost. | Prevents upload path from doing hidden expensive preprocessing. |
| Q19 non-vision worker model | `vision_query` requires a vision-capable worker. If configured/session model lacks vision capability, reject with explicit capability error; no silent model fallback. | User/operator can configure small_model later; runtime does not choose another account/model. |
| Q20 AI SDK Mode 1 support | Treat SDK support as unproven until read from actual provider code. Implement through codex provider boundary only after verifying the request shape. | Blocks Mode 1 edits on source inspection, not assumptions. |
| Q21 budget block UI visibility | Budget block is LLM wire content, hidden from normal UI rendering by default; debug views may expose it as metadata. | Frontend display changes are out of Phase B unless needed to prevent user-visible noise. |
| Q22 subagent budget target | Subagent status uses the subagent session's own ctx_ratio. Shared quota pressure is telemetry/predicate input, not the budget color shown to the subagent. | Preserves session-local semantics of `<context_budget>`. |
| Q23 phase dependency order | Current tasks.md phase order is accepted: A cleanup, B budget, C trigger/codex routing, D boundary storage/tools, E telemetry/docs. No parallel phase execution. | Runtime TodoWrite must stay phase-scoped. |
| Q24 existing sessions migration | Existing sessions are forward-compatible: new tracker/KV state starts on future rounds, old stream anchors remain readable, missing tracker state yields `unknown` not B1 fire. | No migration script; no mutation of historical messages. |
| Q25 compaction-redesign rollback dependency | Strong dependency: cooldown anchor-time semantics and any anchor-from-stream assumption. Loose dependencies: budget surfacing, provider-switched fallback, rebind token refresh, trigger inventory scaffolding. | If compaction-redesign phase 13 rolls back, pause only strong-dependent tasks. |
| Q26 test strategy | Add explicit tests: Part 4 uses prompt/account-routing or a new `prompt.context-budget-surfacing.test.ts`; Part 6 uses `input-preprocessor.test.ts`, `worker-tools.test.ts`, and `kv-storage.test.ts`. | Remaining phases must not be marked complete without these focused tests or equivalent renamed files. |

## Critical Files

- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/memory.ts`
- `packages/opencode/src/session/user-message-parts.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/config/tweaks.ts`
- `packages/opencode/src/provider/codex-compaction.ts`
- `packages/opencode-codex-provider/src/provider.ts`

## Risks / Trade-offs

- Trigger changes can create loops if cooldown and continue-injection are not tested together.
- Codex Mode 1 request wiring depends on the provider request path shape.
- Big-content KV storage must not leak raw user attachments across sessions.
- Budget injection must not destabilize provider prefix cache.
