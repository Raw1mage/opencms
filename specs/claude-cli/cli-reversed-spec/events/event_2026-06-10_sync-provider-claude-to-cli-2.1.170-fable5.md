---
date: 2026-06-10
summary: "Sync provider-claude to claude-code 2.1.170 (Mythos-class launch): add Claude Fable 5 to the catalog/picker; widen mid-conversation-system gate to {opus-4-8, fable-5, mythos-5}; fable-5/mythos-5 join the 1M + 64000 tiers"
---

# Sync provider-claude to claude-code 2.1.170 (Claude Fable 5 / Mythos 5)

## Trigger

npm `@anthropic-ai/claude-code` advanced to 2.1.170 (provider was pinned 2.1.169),
shipping the Mythos-class models from the 2026-06-09 launch (Anthropic news:
"Claude Fable 5 and Claude Mythos 5"). User saw `Fable` in the official CLI picker
and asked to make the opencode `claude-cli` provider support it. Ran
`bun packages/provider-claude/scripts/sync-from-cli.ts --version 2.1.170` against the
native binary (`BUILD_TIME 2026-06-09T15:09:09Z`,
`GIT_SHA 1cda84def004ef3a8f569f8e8284a153a6b98c3a`). Two DRIFT fields surfaced
(VERSION const; `claude-mythos-5` max-output).

## Wire facts reversed from 2.1.170 binary

- Model IDs: `claude-fable-5` (public, picker short-name `fable5`), `claude-mythos-5`
  (access-restricted), `claude-mythos-preview`.
- Max-output (LMH): `K==="claude-fable-5"||K==="claude-mythos-5")$=64000,q=128000`
  — same 64000/128000 tier as opus-4-8. (The sync regex only extracts the
  `||`-tail `claude-mythos-5`; fable-5 set by hand from the same group.)
- mid-conversation-system (upstream O98): widened from opus-4-8-only to
  `if(q==="claude-fable-5"||q==="claude-mythos-5"||q==="claude-opus-4-8")return!0`
  with every other current model (incl. **opus-4-7**) enumerated → false.
- 1M context: the runtime gate `$D(H)` is purely `/\[1m\]/i.test(H)` (marker-based),
  but fable-5/mythos-5 sit in the capability allow-lists alongside opus-4-8.
- Knowledge cutoff `January 2026`; display name `Fable 5`; thinking supported.
- NOT mid-conv / NOT a separate effort knob: the `Fable 5, Opus 4.6+, Sonnet 4.6`
  group is the **effort** gate (`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`), deliberately
  not conflated with the mid-conv gate.

## What changed (code)

- `provider-claude/src/protocol.ts`: `VERSION 2.1.169 → 2.1.170`. Renamed
  `modelIsOpus48` → `modelEmitsMidConversationSystem`, backed by a
  `MID_CONVERSATION_SYSTEM_MODELS` set `{opus-4-8, fable-5, mythos-5}` (normalized).
  Added `claude-fable-5`/`claude-mythos-5` to `CONTEXT_1M_MODELS`.
- `provider-claude/src/models.ts`: `OUTPUT_LIMITS` += `claude-fable-5` and
  `claude-mythos-5` (64000/128000). `MODEL_CATALOG` += `Claude Fable 5`
  (1M, 64000, thinking). Header comment re-pinned to 2.1.170.
- `provider-claude/scripts/sync-from-cli.ts`: `PINNED_VERSION → 2.1.170`; mid-conv
  assertions now cover fable-5 + mythos-5 emit, opus-4-7 omit.
- `provider-claude/test/protocol.test.ts`: renamed gate import/assertions; added
  fable-5/mythos-5 mid-conv cases.
- `opencode/src/provider/provider.ts`: self-built `claude-cli` picker list +=
  `claude-fable-5` (context 1M, output 64000, reasoning). Comment re-pinned 2.1.170.

Re-run is `✓ ALIGNED — checked 53 fields against 2.1.170`. All 101 provider-claude
tests pass.

## Provider stance

- **Fable 5** is user-facing (catalog + picker).
- **Mythos 5** is access-restricted (Project Glasswing / Cyber Verification Program);
  it is intentionally **NOT** in the picker, but gets full wire parity in
  provider-claude's gates (mid-conv, 1M, max-output) so a credentialed user who
  selects it by id behaves byte-identically to the official CLI.

## Cross-refs

- refactor-anthropic skill §1–3
- Prior sync: `event_2026-06-09_sync-provider-claude-to-cli-2.1.169.md`
- Drift tool: `packages/provider-claude/scripts/sync-from-cli.ts`
