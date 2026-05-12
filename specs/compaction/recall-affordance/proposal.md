# Proposal: compaction_recall-affordance

## Why

When opencode's runtime falls into the `rebind → narrative compaction` path (triggered by rate-limit rotation, daemon restart, or paralysis self-heal), all pre-anchor tool-call results collapse into the narrative anchor body — an unaddressable prose summary. The AI then cannot tell which results are stubs vs. live, has no `recall` tool to retrieve original content, and loops re-deriving conclusions it already had (production-observed as "失智跳針").

Production incident 2026-05-12 (session `ses_1e8cbd779ffezUjDVUZXBvwkqy`, debug.log evidence): 18 compactions over ~3 hours all `observed=rebind`, AI never called recall once during 10-minute looping, narrative anchor body bloated to 581,372 chars before forced overflow compaction at observedTokens=297K (> 272K context limit). Causal chain traced in event log `specs/compaction/user-msg-replay-unification/events/event_2026-05-11_production-incident-29-min-predicate-silence-gap-5.md`.

Audit showed three breakages:
1. `Memory.Hybrid.recallMessage` exists in code but is never called and has no AI-facing tool wrapper — dead API.
2. The documented `OverrideParser` auto-recall in `prompt.ts` does not exist (`grep -rln "OverrideParser"` → empty).
3. Narrative anchor body produced by `buildUserPayload` instructs LLM to write prose, never to retain `tool_call_id` index → recall is unaddressable even if a tool existed.

## Original Requirement Wording (Baseline)

> "我高度懷疑AI不知道toolcall result只剩空殼index，所以跳針。
> 是不是在非server-side compaction的情境，或rebind觸發narrative compaction的情境下，
> 我們必須設法告訴AI去使用recall來找回記憶？"
> — operator, 2026-05-12 chat

## Requirement Revision History

- 2026-05-12: initial draft. Three-layer fix (L1 TOOL_INDEX + L2 recall tool + L3 rebind notice) accepted as scope.

## Effective Requirement Description

1. **L1 — Addressable anchor body**: narrative compaction must produce an explicit `## TOOL_INDEX` section listing every pre-anchor tool call as `(tool_call_id, tool_name, args_brief, status, output_chars)`. The LLM is instructed to preserve these ids verbatim and reference them in the narrative body.
2. **L2 — AI-callable recall tool**: a new `recall` tool in the build agent's catalog accepts `tool_call_id: string` and returns the original tool output (or a typed error if the id is unknown / already in journal). Backed by `Memory.Hybrid.recallMessage` extended for tool_call_id lookup.
3. **L3 — Self-aware amnesia notice**: when narrative compaction completes with `observed=rebind` (or in any non-server-side path), the next prompt injects a system note that (a) states tool history is narrative-compacted, (b) lists the TOOL_INDEX is the authoritative source, (c) instructs the model to call `recall(tool_call_id)` before acting on assumed tool outputs.

## Scope

### IN
- `packages/opencode/src/session/compaction.ts` — buildUserPayload + anchor-write path TOOL_INDEX emission.
- `packages/opencode/src/session/memory.ts` — extend `recallMessage` for tool_call_id lookup (currently msg_id only).
- `packages/opencode/src/tool/recall.ts` (new) — AI-facing tool definition + handler.
- `packages/opencode/src/tool/index.ts` (or equivalent registry) — register recall in build-agent tool catalog.
- `packages/opencode/src/session/prompt.ts` — post-rebind/post-narrative system-note injection.
- Tests: vitest unit + integration for each layer.

### OUT
- Predicate-gap threshold tuning (Bug A from incident report) — deferred to `/plans/compaction_predicate-and-bloat/`.
- Narrative anchor body size cap (Bug C from incident report) — deferred to same follow-up plan.
- Rebind-path's discard of post-anchor reasoning journal (Bug B partial) — addressed by recall affordance subsuming the recovery channel; structural fix deferred.
- Server-side compaction (codex kind 4) changes — server-side path already preserves chain via `previous_response_id`; recall affordance is the narrative-path complement.

## Non-Goals

- Replacing narrative compaction with something else.
- Storing tool outputs in a separate store; recall reads from the existing on-disk message stream.
- Auto-recall (model-bypassing) heuristics — recall is explicit, AI-invoked. Auto-recall was the OverrideParser plan; this proposal instead exposes the capability as a first-class tool and trusts the model.

## Constraints

- **No daemon restart in scope of build**: per MEMORY restart-consent rule, user reviews diff before approving daemon reload.
- **beta-workflow**: implementation runs in `~/projects/opencode-beta` worktree; fetchback to main repo per MEMORY rule.
- **Provider-agnostic**: must not break codex server-side path or anthropic / openai providers; new system note only injected when narrative compaction is the active mechanism.
- **No new persistence**: recall reads from existing `Session.messages()` stream — same storage that drives `Memory.Hybrid.recallMessage`.

## What Changes

- New AI tool `recall` (≤80 LOC tool def + handler).
- `buildUserPayload` prompt template gains TOOL_INDEX instruction + post-processing validator.
- `recallMessage` gains tool_call_id signature overload.
- `prompt.ts` injects post-rebind system note when the most recent anchor has `kind=narrative`.

## Capabilities

### New Capabilities
- **recall(tool_call_id)**: AI can retrieve any prior tool output by id, regardless of compaction state.
- **TOOL_INDEX in anchor**: every narrative compaction emits a structured addressable index alongside the prose summary.
- **Amnesia self-awareness**: AI is told when its tool history is compacted, removing the silent failure mode.

### Modified Capabilities
- **Narrative compaction**: now produces structured + prose hybrid output, not pure prose.
- **Rebind handoff**: now followed by a self-aware system note when narrative is the recovery mechanism.

## Impact

- **Code**: ~5 files touched, ~300 LOC added (tool def + prompt template + memory extension + system-note injection + tests).
- **Prompt size**: TOOL_INDEX adds ~30–80 bytes per pre-anchor tool call (id + name + args_brief + status + chars). For a 1400-round session, ~50–100K chars of index — but anchor body is already 581K, so net change is +10–20% size, in exchange for addressable recovery.
- **Tool catalog**: build agent gains `recall`. Token cost per turn = one tool description entry.
- **Operators**: no UI change; `recall` calls show in conversation transcript like any other tool.
- **Specs**: extends `compaction/user-msg-replay-unification` invariants (rebind no longer silently drops recoverable state); new plan owns the recall mechanism end-to-end.
