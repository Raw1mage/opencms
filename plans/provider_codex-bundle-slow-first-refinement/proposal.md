# Proposal: provider/codex-bundle-slow-first-refinement

## Why

The context layer map in `provider_codex-prompt-realign/design.md` documents that within each bundle, slow-first ordering is respected — BUT one fragment violates it:

**`opencode_agent_instructions`** (developer bundle, fragment #3) bundles two semantically different inputs into one fragment body:
- `agent.prompt` — agent-level persona overlay, static for the entire session
- `user.system` — per-turn extras (lazy tool catalog hints, JSON-schema directives, subagent return notices, quota-low wrap-up)

When `user.system` is empty (the typical case), nothing changes. But the moment ANY of those triggers fires — lazy catalog gets enabled, JSON schema mode flips, a subagent returns, quota hits the low threshold — the developer bundle hash breaks at fragment #3. Everything after that point in the linear prefix stream becomes cache-miss:

```
developer bundle [RoleIdentity][SYSTEM.md][agent.prompt + user.system_NEW]
                                                                       ↑ break here
user bundle      [AGENTS.md global][AGENTS.md project][environment_context]
                  ↑ all these bytes are AFTER the break — all cache-miss
history          [turn 1] [turn 1 asst] [turn 2] ...
                  ↑ entire history prefix — cache-miss
```

→ One `user.system` flip = ~20KB+ of prefix invalidation in addition to the small `user.system` text itself.

Fix: split `opencode_agent_instructions` into two fragments — one carrying the static `agent.prompt`, one carrying the dynamic `user.system` — and move the dynamic one to the **tail of the user bundle** (after `environment_context`). Cache invalidation for the dynamic content is then bounded to its own fragment bytes only.

## Original Requirement Wording (Baseline)

- "那就照你建議把後面可加強對齊的部份做完" (2026-05-11)

## Requirement Revision History

- 2026-05-11: initial draft. Scoped to L3 fix only; L6 EnvironmentContext split rejected (upstream byte alignment wins; see Constraints).

## Effective Requirement Description

1. Split `opencode_agent_instructions` fragment into two producers:
   - `opencode_agent_persona` (developer-role) — body = current `agent.prompt` content only
   - `opencode_user_system_addenda` (user-role) — body = current `user.system` content (empty body → fragment omitted entirely from the bundle, no wrapping markers emitted)
2. In `llm.ts` codex upstream-wire path: emit `opencode_agent_persona` at its current position (developer bundle fragment #3); emit `opencode_user_system_addenda` at the **end** of the user bundle, after `environment_context`.
3. Telemetry: prompt.bundle.assembled event must list both new fragment ids (replacing `opencode_agent_instructions`).
4. Test vector: capture two consecutive turns where one fires lazy catalog mid-session. Assert developer bundle byte-identical across both turns; user bundle differs only in trailing addenda fragment.

## Scope

### IN
- `packages/opencode/src/session/context-fragments/` — new `opencode-agent-persona.ts` and `opencode-user-system-addenda.ts` producers; deprecate / delete `opencode-agent-instructions.ts`.
- `packages/opencode/src/session/llm.ts` — codex upstream-wire path: replace single fragment build with two builds at distinct bundle positions.
- Telemetry id changes propagated to `prompt.bundle.assembled` log + `bus.llm.prompt.telemetry` event.
- Unit tests covering the empty-addenda case (fragment omitted), populated-addenda case, and the user-bundle tail position.

### OUT
- **L6 EnvironmentContext currentDate split** — rejected. The fragment shape mirrors upstream codex-cli `refs/codex/codex-rs/core/src/context/environment_context.rs` byte-for-byte (DD-2 of upstream design). Splitting `current_date` out would diverge from upstream and violate the upstream-alignment principle that the realign work established. Daily cache invalidation is accepted as the cost of byte-alignment.
- Inlining `user.system` into the user message body (chain-aware, expires-with-turn) — promising for cache but requires session/turn semantics work; out of scope. Captured as a follow-up in design.md.
- Anthropic / Google providers — those paths still go through the legacy preface T1/T2/T3 layering; this refinement is codex-only.

## Non-Goals

- Solving cache-4608 (still owned by `openai/codex#20301` on the server side).
- Restructuring developer/user bundle membership beyond moving one fragment.
- Adding new content to user.system; only changing where existing content rides.

## Constraints

- **Upstream byte alignment for the upstream-sourced fragments** (RoleIdentity, OpencodeProtocol, AGENTS.md user-instructions, EnvironmentContext) MUST remain intact. The new agent-persona and user-system-addenda fragments are OpenCode-only additions — they may have any internal shape, but they MUST NOT modify the bytes of upstream-sourced fragments.
- **Empty `user.system` → fragment fully omitted** (no startMarker / endMarker / empty body line). Otherwise typical turns would include an extra empty wrapper after environment_context and break upstream-aligned user-bundle byte shape.
- **AGENTS.md rule 1**: if fragment producer fails for any reason, surface the error; do not silently fall back to the old combined fragment.

## What Changes

- Two new fragment producers replace one; one fragment moves position.
- Telemetry fragment id list changes (adds two, removes one).
- No change to wire-level body shape outside of bundle internal content.
- No change to `instructions` field, `prompt_cache_key`, `client_metadata`, or `tools`.

## Capabilities

### New Capabilities
- Slow-first ordering invariant for `user.system` content: dynamic addenda no longer pollute static developer bundle prefix.

### Modified Capabilities
- `prompt.bundle.assembled` telemetry: fragment id list grows by one in typical turns (agent_persona always present); on turns where user.system fires, the addenda fragment id also appears in the user bundle list.

## Impact

- Affected code: `packages/opencode/src/session/context-fragments/*` (two new files, one removed), `packages/opencode/src/session/llm.ts` (codex upstream-wire branch).
- Affected runtime: codex provider only. Other providers unaffected.
- Affected cache behaviour: on turns when `user.system` fires for the first time mid-session, prefix-cache invalidation footprint shrinks from "everything after developer fragment #3" to "the final fragment of user bundle only" — recovers ~15-30KB of prefix cache (AGENTS.md global + project + environment_context = the bytes that today invalidate but no longer will).
- Affected specs: `provider_codex-prompt-realign/design.md` Context layer map — to be updated to reflect the new fragment names + position once this spec lands.
