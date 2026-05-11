---
date: 2026-05-11
summary: "ROOT CAUSE FOUND — todowrite schema's `.default(() => todo_<Date.now()>_<random>)` mutates tools JSON every turn, breaking codex prefix cache. Build agent now caches at 98%+ with one-line fix."
---

# RCA — todowrite dynamic default poisons tools-schema cache

## TL;DR

**Cache 4608 floor on main+build sessions is caused by [`packages/opencode/src/tool/todo.ts:16-20`](packages/opencode/src/tool/todo.ts#L16-L20)**: the `LLMTodoShape.id` zod field had `.default(() => \`todo_${Date.now()...}_${Math.random()...}\`)`. When zod-to-json-schema serialises tools for the API request, it **evaluates the default function** and embeds the literal current-timestamp + random string into the `tools[]` JSON. Every turn mutates the tools schema bytes. Codex's server prefix cache treats `tools[]` as a separate cache dimension; once the dimension's bytes differ turn-over-turn, the cache breaks at the start of `input[]` — observable as `cached_tokens ≈ 4608` (driver + tools schema) regardless of conversation growth.

Fix: drop the dynamic default; generate the id inside `execute()` instead. Validated on a fresh natural-build session (full 11-tool set, AGENTS.md present, no other probes active): turn 3 cached_tokens = **23552 / 23907 = 98.5%**.

## Why subagent escaped

Subagents typically use the `coding` agent with a permission-restricted tool set that excludes `todowrite`. With todowrite absent from `tools[]`, the schema mutation never enters the wire, prefix cache stays byte-stable across turns, and cache grows healthily (we saw subagent sessions reach 40k+ cached). The "subagent caches normally, main doesn't" differential — open as Q1 in [Chapter 11 of `codex-cli-reversed-spec`](../../../plans/codex_cli-reversed-spec/chapters/11-cache-prefix-model.md) — was not Q1 (header / AGENTS.md / system field) but the absence of todowrite in the subagent's tool palette.

## Bisection trail (2026-05-11 evening)

Method: subtractive bisection from a known-working baseline (subagent shape) to a known-broken target (main+build), one binary variable at a time.

| Step | Change | toolCount | Cache result | Conclusion |
|---|---|---|---|---|
| T1 | Force `role_identity` body = "Subagent" on main | 11 | 0 → 4608 | role_identity body **not** lever |
| T2 | + force `agent_instructions` placeholder | 11 | 0 → 0 → 4608 | structural presence **not** lever |
| T3 | Open main session with `@coding` agent (confounded) | 6 | 0 → 44544 | works but two variables differ |
| Ta | T1 + load coding.txt as agent_instructions placeholder | 11 | 0 → 4608 | content size/text **not** lever |
| Tc | + force `subagentSession=true` (skip AGENTS.md, user-bundle=[env_ctx] only) | 11 | 0 → 4608 | AGENTS.md presence **not** lever |
| **Tb** | Truncate tools to 4-tool whitelist | 4 | 0 → 0 → **7680** | **tools schema IS lever** |
| Td | Tb + apply_patch (5 tools) | 5 | 0 → **9216** | apply_patch innocent |
| Te | Deny {task, todowrite, todoread, tool_loader, question} | 6 | 0 → **9216** | culprit in those 5 |
| Tf | Deny only {task, tool_loader, todowrite} | 8 | 0 → **9216** | culprit in those 3 |
| Tg | Deny only {task} | 10 | 0 → 2560 stuck | task innocent |
| Th | Deny only {tool_loader} | 10 | 0 → 4608 stuck | tool_loader innocent |
| **Ti** | **Deny only {todowrite}** | **10** | 0 → 0 → **12288** | **todowrite is the culprit** |
| Tj | Patch todo.ts + revert tools filter (T1+Ta+Tc still active) | 11 | 0 → 0 → **12800** | fix works with probes |
| **FINAL** | Revert all probes, only todo.ts patched, natural build agent | **11** | 0 → 5632 → **23552 → 23552** | **98%+ cache hit** |

## Schema autopsy

[`packages/opencode/src/tool/todo.ts:16-20`](packages/opencode/src/tool/todo.ts#L16-L20) before fix:

```ts
id: z
  .string()
  .optional()
  .default(() => `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
  .describe("Stable id for the todo (auto-generated if omitted)"),
```

When the AI SDK serialises tools to JSON Schema for the codex Responses API call:

1. `zod-to-json-schema` walks the schema tree
2. Encounters `.default(...)` and evaluates the callback to produce a literal value for the JSON schema's `default` keyword
3. The literal contains `Date.now()` (millisecond timestamp, monotonically increasing) and `Math.random()` (different every call)
4. Result: the `tools[]` array's bytes change on every single turn

Codex prefix cache (server side, audited in [Ch11 D11-2 row 8](../../../plans/codex_cli-reversed-spec/chapters/11-cache-prefix-model.md)) treats `tools[]` as an independent cache dimension. Once bytes diverge across the dimension, the entire prefix-cache lineage for that thread breaks at the boundary; the visible signal is `cached_tokens` capped at "instructions+stable-prefix-of-tools" ≈ 4608 for our setup.

This is exactly the **C9 cache hazard** the reversed-spec already documented:

> [Ch11 C9](../../../plans/codex_cli-reversed-spec/chapters/11-cache-prefix-model.md#L177): Tools list is an **independent cache dimension** ... MCP connector reconnects, skill registry rebuilds, or agent capability changes mid-session all mutate the `tools[]` JSON-Value vector → tools dimension cache breaks; backend may still cache `input[]` prefix separately. **Observable in practice: cached_input_tokens drops to the "tools-only floor"** (≈ size of static tools serialisation alone).

The reversed-spec predicted the exact symptom; the trigger turned out not to be MCP / skill churn but a self-inflicted dynamic default in our own tool schema.

## Fix

[`packages/opencode/src/tool/todo.ts`](packages/opencode/src/tool/todo.ts):

```ts
// Before
id: z
  .string()
  .optional()
  .default(() => `todo_${Date.now()...}_${Math.random()...}`)
  .describe(...)

// After
id: z
  .string()
  .optional()
  .describe(...)

// In execute():
const incoming: Todo.Info[] = params.todos.map((todo) => ({
  ...todo,
  id: todo.id ?? `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
})) as Todo.Info[]
```

Schema becomes byte-stable across turns; id auto-generation moves out of zod schema metadata into the actual execution path. Functionally equivalent for the LLM; behaviourally identical for the runtime.

## Other tools to audit

Same pattern likely exists elsewhere. Grep target:

```bash
grep -rn "\.default(\(\) =>" packages/opencode/src/tool/ packages/opencode/src/session/
```

Initial scan finds the same dynamic default in [`packages/opencode/src/session/todo.ts:44-48`](packages/opencode/src/session/todo.ts#L44-L48) (the server-side `Todo.Info` schema). That one is fine — it's used at persistence time, not exported to a tool surface.

Action item: scan all tools for `.default(()` patterns; replace with execute-time defaults.

## Lessons learned

1. **Tool schemas are wire payloads, not local code.** Anything in a zod schema that gets serialised to JSON Schema is part of the API contract and must be byte-stable across calls.
2. **Dynamic defaults in zod schemas are a stealth poisoner.** Looks like a value generator; actually gets evaluated at *schema emission* and embedded as a literal. Cache regressions from this pattern are silent — no error, no warning, just degraded cache hit rate.
3. **The reversed-spec's "tools as independent cache dimension" claim was load-bearing.** Without Ch11 C9 framing the symptom, we'd have continued to suspect content/structure variables and miss the actual lever.
4. **Subtractive bisection beats additive when the working baseline is known.** Subagent worked → start from subagent → add variables back until it breaks. Took ~10 probes to locate; an additive approach (build forward from minimal) would have taken many more.

## State

- **Root cause**: confirmed at packet level via tools count + cache trajectory across 12+ probes
- **Fix**: applied to [`packages/opencode/src/tool/todo.ts`](packages/opencode/src/tool/todo.ts)
- **Verification**: natural build agent fresh session caches at 98.5% on turn 3, 98.2% on turn 4
- **Related**: this closes Q1 of [`codex-cli-reversed-spec` Ch11](../../../plans/codex_cli-reversed-spec/chapters/11-cache-prefix-model.md). The reversed-spec author should append a Ch11 supplemental noting the empirical resolution.

## Plan disposition

`provider_codex-prompt-realign` Stage A objectives all stand (driver-only instructions, fragment bundles, prompt_cache_key alignment, content-parts shape alignment). The cache regression that motivated the deeper dive turned out to be a **separate, simpler bug** that the realign work surfaced rather than caused. Both improvements stay committed independently:

- Realign work (Stage A.1 through A.4) — architectural alignment to upstream wire shape
- This fix — schema byte-stability bug in todowrite

Plan may proceed to `verified` graduation once user reviews the final diff and runs through their own live build-session.
