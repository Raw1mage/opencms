# Spec: claude-provider-beta-fingerprint-realign

## Purpose

Bring `assembleBetas()` in `@opencode-ai/provider-claude` to behavioral parity with the upstream `claude-code@2.1.112` `ZR1` function, so that `anthropic-beta` header values produced by opencode are byte-equivalent to those produced by the official CLI for any (model × auth × provider × env) combination relevant to opencode.

## Requirements

### Requirement: Haiku exemption from `claude-code-20250219`

When the model id contains `"haiku"`, the assembler MUST NOT include `claude-code-20250219` in the output. For all non-haiku Anthropic models, the flag MUST be present (subject to the other conditions below — currently none gate it for non-haiku models).

#### Scenario: opus model gets claude-code beta

- **GIVEN** model id `claude-opus-4-7`
- **AND** OAuth auth = false
- **WHEN** `assembleBetas()` is called
- **THEN** the output array contains `claude-code-20250219`

#### Scenario: haiku model omits claude-code beta

- **GIVEN** model id `claude-haiku-4-5-20251001`
- **AND** OAuth auth = false
- **WHEN** `assembleBetas()` is called
- **THEN** the output array does NOT contain `claude-code-20250219`

### Requirement: `context-management-2025-06-27` is conditional, not minimum

The flag MUST be sent only when ALL three conditions hold: provider is `firstParty`, env `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is not truthy, and the model satisfies the upstream model-condition predicate (`iO_(q)` in cli.js — must be reverse-engineered into a stable `modelSupportsContextManagement()` helper). Other branches in upstream (`USE_API_CONTEXT_MANAGEMENT && false`) are dead code and may be ignored.

#### Scenario: firstParty + supported model + no env override

- **GIVEN** provider = `firstParty`
- **AND** `disableExperimentalBetas` = false
- **AND** model supports context management (per upstream predicate)
- **WHEN** `assembleBetas()` is called
- **THEN** the output array contains `context-management-2025-06-27`

#### Scenario: env override disables context management

- **GIVEN** provider = `firstParty`
- **AND** `disableExperimentalBetas` = true
- **WHEN** `assembleBetas()` is called
- **THEN** the output array does NOT contain `context-management-2025-06-27`

#### Scenario: non-firstParty provider omits context management

- **GIVEN** provider = `bedrock`
- **AND** all other conditions favorable
- **WHEN** `assembleBetas()` is called
- **THEN** the output array does NOT contain `context-management-2025-06-27`

### Requirement: `redact-thinking-2026-02-12` conditional push

The flag MUST be sent when ALL conditions hold: `isFirstPartyish(provider)`, `!disableExperimentalBetas`, model supports thinking, env `DISABLE_INTERLEAVED_THINKING` is not truthy, **isInteractive=true**, and `showThinkingSummaries` is not `true`.

> ~~Original (v1, SUPERSEDED 2026-05-03 — gated on isOAuth, omitted isInteractive and disableExperimentalBetas)~~. Rewritten after `ja()` and `I7()` recovered from cli.js at offsets 3481451 and 38983 respectively.

#### Scenario: firstParty + thinking model + interactive + no summaries

- **GIVEN** provider = `firstParty`
- **AND** `disableExperimentalBetas` = false
- **AND** model id `claude-opus-4-7` (thinking-capable)
- **AND** `isInteractive` = true
- **AND** `showThinkingSummaries` = false
- **WHEN** `assembleBetas()` is called
- **THEN** the output array contains `redact-thinking-2026-02-12`

#### Scenario: non-interactive (typical opencode daemon) suppresses redact-thinking

- **GIVEN** provider = `firstParty`, model `claude-opus-4-7`, all other conditions favorable
- **AND** `isInteractive` = false
- **WHEN** `assembleBetas()` is called
- **THEN** the output array does NOT contain `redact-thinking-2026-02-12`

#### Scenario: showThinkingSummaries=true suppresses redact-thinking

- **GIVEN** all favorable conditions
- **AND** `showThinkingSummaries` = true
- **WHEN** `assembleBetas()` is called
- **THEN** the output array does NOT contain `redact-thinking-2026-02-12`

#### Scenario: non-firstPartyish provider suppresses redact-thinking

- **GIVEN** provider = `bedrock` (not in firstPartyish set)
- **AND** all other conditions favorable
- **WHEN** `assembleBetas()` is called
- **THEN** the output array does NOT contain `redact-thinking-2026-02-12`

### Requirement: Push order matches upstream `ZR1` exactly

The output array MUST preserve the upstream push order so that the resulting comma-joined header string is byte-identical when the same conditions are met:

```
1. claude-code-20250219              if !isHaiku
2. oauth-2025-04-20                  if isOAuth
3. context-1m-2025-08-07             if supports1M(model)
4. interleaved-thinking-2025-05-14   if supportsThinking(model) && !disableInterleavedThinking
5. redact-thinking-2026-02-12        if isFirstPartyish(provider) && !disableExperimentalBetas
                                        && supportsThinking(model) && !disableInterleavedThinking
                                        && isInteractive && !showThinkingSummaries
6. context-management-2025-06-27     if provider==="firstParty" && !disableExperimentalBetas
                                        && modelSupportsContextManagement(model, provider)
7. structured-outputs-2025-12-15     NOT EMITTED in this plan; reserved slot
8. web-search-2025-03-05             NOT EMITTED in this plan; reserved slot
9. prompt-caching-scope-2026-01-05   if isFirstPartyish(provider) && !disableExperimentalBetas
10. ... env-supplied ANTHROPIC_BETAS appended, then dedup
```

`isFirstPartyish(p)` = `p ∈ {firstParty, anthropicAws, foundry, mantle}`.
`modelSupportsContextManagement(m, p)`: `p==="foundry"` → true ; `isFirstPartyish(p)` → `!m.includes("claude-3-")` ; else → `m.includes("claude-opus-4")||m.includes("claude-sonnet-4")||m.includes("claude-haiku-4")`.

#### Scenario: opencode-typical (firstParty, opus-4-7, OAuth, NON-interactive) canonical order

- **GIVEN** model id `claude-opus-4-7`, OAuth auth = true, provider = firstParty, supports 1M, supports thinking, summaries off, no experimental disable, **isInteractive = false** (opencode runs as a daemon)
- **WHEN** `assembleBetas()` is called
- **THEN** the output array equals `["claude-code-20250219", "oauth-2025-04-20", "context-1m-2025-08-07", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05"]` (redact-thinking absent due to non-interactive)

#### Scenario: claude-code-CLI-typical (firstParty, opus-4-7, OAuth, INTERACTIVE) canonical order

- **GIVEN** all of the above PLUS `isInteractive = true`
- **WHEN** `assembleBetas()` is called
- **THEN** the output array equals `["claude-code-20250219", "oauth-2025-04-20", "context-1m-2025-08-07", "interleaved-thinking-2025-05-14", "redact-thinking-2026-02-12", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05"]`

### Requirement: `MINIMUM_BETAS` removed

The exported `MINIMUM_BETAS` constant MUST be removed. Its three members are repositioned as conditional pushes (member 1 + 3 conditional, member 2 unconditional-for-non-haiku-thinking-models). Any external consumer of `MINIMUM_BETAS` (none expected; provider package is internal) is a breaking change candidate to flag in design.md.

#### Scenario: import of MINIMUM_BETAS fails type check

- **GIVEN** the refactored `protocol.ts` is in place
- **WHEN** any file imports `MINIMUM_BETAS` from `@opencode-ai/provider-claude/protocol`
- **THEN** TypeScript reports a missing-export error

### Requirement: `prompt-caching-scope-2026-01-05` gated on `ja()`-equivalent

> ~~Original (v1, SUPERSEDED 2026-05-03 — gated on isOAuth)~~. Resolved by grep at design.md §Research Outcomes / DD-11.

The flag MUST be sent when `isFirstPartyish(provider) && !disableExperimentalBetas`. NOT gated on `isOAuth`.

#### Scenario: firstParty + experimental betas allowed

- **GIVEN** provider = `firstParty`
- **AND** `disableExperimentalBetas` = false
- **WHEN** `assembleBetas()` is called
- **THEN** the output array contains `prompt-caching-scope-2026-01-05` (regardless of `isOAuth`)

#### Scenario: experimental betas disabled by env

- **GIVEN** provider = `firstParty`
- **AND** `disableExperimentalBetas` = true
- **WHEN** `assembleBetas()` is called
- **THEN** the output array does NOT contain `prompt-caching-scope-2026-01-05`

#### Scenario: bedrock provider suppresses prompt-caching-scope

- **GIVEN** provider = `bedrock` (not in firstPartyish set)
- **WHEN** `assembleBetas()` is called
- **THEN** the output array does NOT contain `prompt-caching-scope-2026-01-05`

### Requirement: Reserved slots for `structured-outputs` and `web-search`

Even though these flags are not emitted by this plan, the assembler's source code MUST contain commented-out or `// TODO:` stubs at the correct positions in the push sequence. This preserves order parity for future expansion.

#### Scenario: source code preserves slots

- **GIVEN** the refactored `assembleBetas()` source
- **WHEN** read by a developer
- **THEN** between the `context-management` push and the `prompt-caching-scope` push, comments exist documenting `structured-outputs-2025-12-15` and `web-search-2025-03-05` as upstream-conditional flags currently unemitted, with cli.js offset references

## Acceptance Checks

- [ ] `bun test packages/provider-claude/test/protocol.test.ts` passes the full matrix in `test-vectors.json`
- [ ] `grep -c "MINIMUM_BETAS" packages/provider-claude/src/` returns 0
- [ ] `grep "redact-thinking" packages/provider-claude/src/protocol.ts` shows the constant + push site
- [ ] Manual diff of a captured `anthropic-beta` header from a live opencode request against the expected output for the same `(model, auth, provider)` triple matches byte-for-byte
- [ ] `plans/claude-provider/protocol-datasheet.md` § 9 (or rename) reflects v2.1.112 logic with cli.js offset citations
- [ ] No new dependency on `@ai-sdk/anthropic` introduced (grep returns same count as before)
- [ ] All public exports of `protocol.ts` other than `MINIMUM_BETAS` retain identical signatures (no incidental breaking change)
