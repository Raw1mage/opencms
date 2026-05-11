# Design: provider/codex-bundle-slow-first-refinement

## Context

`provider_codex-prompt-realign/design.md` "Context layer map" identified one slow-first violation: `opencode_agent_instructions` fragment bundles `agent.prompt` (static) with `user.system` (per-turn dynamic). When `user.system` flips (lazy catalog activates, JSON schema mode, subagent return notice, quota-low wrap-up), the entire prefix from fragment #3 onwards becomes cache-miss — even though `agent.prompt` itself is byte-stable.

Empirically `user.system` is empty on most turns, so the damage is intermittent. But when it does fire mid-session, ~15-30KB of cached prefix is lost (AGENTS.md global + project + environment_context + history prefix). This spec fixes the violation.

## Goals / Non-Goals

### Goals
- Split `opencode_agent_instructions` into `opencode_agent_persona` (developer bundle) + `opencode_user_system_addenda` (user bundle tail).
- Keep developer bundle byte-stable whenever `agent.prompt` is unchanged, regardless of `user.system` content.
- Bound `user.system` cache-invalidation blast radius to the addenda fragment bytes only.
- Telemetry reflects new fragment ids.

### Non-Goals
- L6 EnvironmentContext currentDate split — REJECTED. See Decisions DD-2.
- Inlining `user.system` into the user message body (chain-aware) — captured as future work in Decisions DD-3.
- Changes to non-codex providers.

## Architecture

```
BEFORE (slow-first violation)
─────────────────────────────────
developer bundle [RoleIdentity][SYSTEM.md][agent.prompt + user.system]
                                                            ↑ static / dynamic mixed
user bundle      [AGENTS.md global][AGENTS.md project][environment_context]
history          [turn 1] [turn 1 asst] ...

AFTER
─────────────────────────────────
developer bundle [RoleIdentity][SYSTEM.md][agent_persona]
                                            ↑ static only
user bundle      [AGENTS.md global][AGENTS.md project][environment_context][user_system_addenda?]
                                                                            ↑ dynamic, omitted when empty
history          [turn 1] [turn 1 asst] ...
```

When `user.system` flips:
- Developer bundle hash unchanged → cache hit on developer bundle.
- User bundle hash changes only at the very tail → cache hit on bytes up to and including `</environment_context>`.
- History prefix re-keys from the user bundle's break point, but `</environment_context>` sits at the very end of the user bundle, so the loss is limited to the addenda fragment bytes themselves.

When `user.system` stays empty (typical case):
- Both bundles byte-stable.
- Identical to today's behaviour for non-fire turns.

## Risks / Trade-offs

- **R1: Empty-addenda elision breaks user-bundle byte-shape on some turn.** Mitigation: the omission is total (no marker, no body line) so the user bundle ends with `</environment_context>` exactly as upstream codex-cli does. Verified in test vector TV-EMPTY.
- **R2: Two producers + repositioning are more moving parts than one.** Mitigation: the API surface is two simple functions mirroring the existing fragment shape; tests pin behaviour.
- **R3: Existing chain (`previous_response_id`) may break at deploy.** Mitigation: ride the same chain-reset wave as previous codex provider patches — broadcast `resetWsSession` per active codex session on rollout.
- **Trade-off: not inlining user.system into user message.** Per-turn user message inline would be cache-optimal (no bundle change at all on flip turns) but requires changing the user-message build path. Rejected for MVP; captured as DD-3 follow-up. The chosen tail-of-user-bundle position is strictly better than today and doesn't require touching message semantics.

## Critical Files

- `packages/opencode/src/session/context-fragments/opencode-agent-instructions.ts` — to be replaced.
- **NEW** `packages/opencode/src/session/context-fragments/opencode-agent-persona.ts`.
- **NEW** `packages/opencode/src/session/context-fragments/opencode-user-system-addenda.ts`.
- `packages/opencode/src/session/context-fragments/index.ts` — update exports.
- `packages/opencode/src/session/llm.ts` (lines ~1005-1054, codex upstream-wire branch) — replace single fragment build with two builds at distinct bundle positions.

## Decisions

<!-- DD entries appended via spec_record_decision -->

## Code anchors

<!-- entries appended via spec_add_code_anchor -->

## Submodule pointers

- `refs/codex` — upstream alignment reference; no submodule code change.

## Testing

- Unit `opencode-agent-persona.test.ts`: producer returns developer-role fragment with body = agent.prompt, byte-stable across calls.
- Unit `opencode-user-system-addenda.test.ts`: empty input → fragment omitted (producer returns null or assembler skips); non-empty input → user-role fragment with body = user.system joined.
- Integration: spin up codex turn with empty user.system, capture developer/user bundle hashes; spin a second turn with non-empty user.system (simulating lazy catalog), capture again. Assert developer bundle hash byte-identical; user bundle differs only in trailing fragment.
- Telemetry: assert `prompt.bundle.assembled` log lists `opencode_agent_persona` always and `opencode_user_system_addenda` conditionally.
