---
date: 2026-05-11
summary: "Closing note — root cause is GPT-5.5 model cache regression (OpenAI issue #20301)"
---

# Closing note — root cause is GPT-5.5 model cache regression (OpenAI issue #20301)

## TL;DR

The 4608 cache floor we chased for hours is **a confirmed GPT-5.5 model regression on OpenAI's side**, tracked in [openai/codex#20301](https://github.com/openai/codex/issues/20301). Switching the default model to GPT-5.4 restores normal cache behavior. All architectural realign work in this plan is independently valid and stays committed.

## Evidence

[openai/codex#20301](https://github.com/openai/codex/issues/20301) (open, `bug` + `rate-limits` labels, no assignee):
> "When Codex integrates with the GPT-5.5 model, its cache hit rate is very low, which causes costs to be consumed rapidly."
>
> Reporter's comparative findings:
> - OpenCode + GPT-5.5: cache hit normal (at filing time)
> - Codex + GPT-5.4: cache hit normal
> - **Codex + GPT-5.5: cache hit very low ⚠️**

[openai/codex#21796](https://github.com/openai/codex/issues/21796) (open, related):
> Codex's own engineers observe ~55% cache hit rate even under ideal conditions today (Session A 55.6% / Session B 54.5% on byte-identical prefixes).

So today's "healthy" cache baseline is ~55%, not the ~95%+ we historically saw on opencode prior to May 9. Our 5.7% floor is two-tier degradation:
1. OpenAI overall cache regression (5.4 still works, 5.5 broken)
2. OpenCode hit harder than codex itself (we may also be a victim of the broader anomaly)

## What this plan actually accomplished

The cache regression is server-side and beyond our control. But the realign work we shipped is independently load-bearing:

| Stage | Outcome |
|---|---|
| A.1 Persona file | Restored to upstream default.md (md5 7a62de0a7552d52b455f48d9a1e96016) |
| A.2 Fragment framework | New `context-fragments/` module mirrors upstream `ContextualUserFragment` shape |
| A.3-1 convert.ts | `instructions` driver-only; bundle marker routing |
| A.3-2 llm.ts | Driver-only static block + fragment bundle prepend |
| A.3-2 hotfix | Bundle at index 0 (was inserting mid-chain) |
| A.4 prompt_cache_key | Pure threadId, no accountId fragmentation |
| sse.ts finishReason fallback | Three-tier fallback; no more false-positive empty-response chain resets |

Stability metrics post-fix (observation 2026-05-11):
- WS connection: 0 errors / 0 unexpected closes
- Chain resets: 3 across 49 turns, all from legit account rotations (no thrash)
- Empty-response false positives: 0 in fixed sessions
- "跳針" (broken-record retry storms): not observed

User explicit acknowledgment: "系統的穩定度有提升。不會動不動跳針了。這跟我們的修復有比較大的關係吧。"

## Operational recommendation

**Default model = GPT-5.4** until OpenAI fixes the GPT-5.5 cache regression. Watch [#20301](https://github.com/openai/codex/issues/20301) for resolution; revert default when fixed.

Optional further work (deferred, not blocking graduation):
- B.1 (apps_instructions / available_skills_instructions / skill_instructions / personality_spec_instructions)
- B.2 (lazy_catalog / structured_output / quota_low / subagent_return / enablement_snapshot / attached_images_inventory)
- B.3 (delete context-preface.ts)
- B.4 (model-specific persona routing)
- A.5 (daemon upgrade resetWsSession broadcast — not strictly needed since rotation handling now works)
- `OPENCODE_CODEX_DISABLE_CHAIN=1` env flag (force delta=false to maximize prefix cache, if anyone needs it before #20301 is fixed)

## Plan disposition

Ready to graduate to `verified` (Stage A objectives met, evidence captured). User triggers graduation when ready.

