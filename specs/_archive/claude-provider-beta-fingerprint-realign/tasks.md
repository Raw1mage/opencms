# Tasks: claude-provider-beta-fingerprint-realign

Execution order is phase-by-phase. Each phase ends with a slice summary into `docs/events/`.

## 1. Predicate helpers + constants

- [x] 1.1 Add `redact-thinking-2026-02-12` exported constant in `protocol.ts`
- [x] 1.2 Add `MANTLE` to `ProviderRoute` enum / type union in `protocol.ts`
- [x] 1.3 Implement `isHaikuModel(modelId)` helper (lowercased substring match)
- [x] 1.4 Implement `isFirstPartyish(provider)` helper for `{firstParty, anthropicAws, foundry, mantle}`
- [x] 1.5 Implement `modelSupportsContextManagement(modelId, provider)` per DD-12 (foundry → true ; firstPartyish → !claude-3- ; else → opus-4/sonnet-4/haiku-4 contains)
- [x] 1.6 Update `supports1MContext(modelId)` to keep current prefix list; verify `claude-opus-4-7` still matches (added in 4f6039bf1)
- [x] 1.7 Each helper carries a single-line comment `// upstream: <minifiedName> (cli.js@<offset>)` per DD-2

## 2. Push ladder rewrite

- [x] 2.1 Extend `AssembleBetasOptions` with `provider`, `showThinkingSummaries`, `disableExperimentalBetas`, `isInteractive`, `disableInterleavedThinking` (DD-3, DD-13)
- [x] 2.2 Remove the `MINIMUM_BETAS` exported constant and any internal use (DD-1)
- [x] 2.3 Rewrite `assembleBetas()` body as a structurally-ordered conditional push ladder following spec.md Requirement 4
- [x] 2.4 Each push site carries `// upstream: <push order N> (cli.js ZR1@3482150)` comment
- [x] 2.5 Add `// RESERVED:` slot comments at positions 7 and 8 for structured-outputs / web-search (DD-6)
- [x] 2.6 Preserve existing dedup-final-step semantics (`Array.from(new Set(arr))`)
- [x] 2.7 Verify no other file in `packages/provider-claude/` references `MINIMUM_BETAS` (R-2)

## 3. Call-site plumbing

- [x] 3.1 Extend `BuildHeadersOptions` in `headers.ts` with the same new fields (1:1 forwarding)
- [x] 3.2 In `provider.ts` doStream, read `process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` and `process.env.DISABLE_INTERLEAVED_THINKING` once, resolve to booleans, forward
- [x] 3.3 In `provider.ts` doStream, hardcode `provider: "firstParty"` (DD-4) and `isInteractive: false` (DD-17)
- [x] 3.4 Remove any code path or fallback that would set `isOAuth: false` (DD-16); the call site always forwards `isOAuth: true` and a unit test asserts this
- [x] 3.5 Resolve `showThinkingSummaries` from `callOptions.providerOptions?.showThinkingSummaries` if present, default `false`

## 4. Tests + datasheet sync

- [x] 4.1 Create `packages/provider-claude/test/protocol.test.ts` (new file)
- [x] 4.2 Implement test that loads `specs/_archive/claude-provider-beta-fingerprint-realign/test-vectors.json` and asserts `assembleBetas(input).toEqual(expected)` per case
- [x] 4.3 Add a guardrail test asserting `provider.ts` always forwards `isOAuth: true` (DD-16) — grep-based or runtime spy
- [x] 4.4 Run `bun test packages/provider-claude/` and confirm green (32/32)
- [x] 4.5 Update `plans/claude-provider/protocol-datasheet.md` § 11 with v2.1.112 push-order ladder + cli.js offset citations
- [x] 4.6 Add a "Research outcomes" pointer in protocol-datasheet.md to `specs/_archive/claude-provider-beta-fingerprint-realign/design.md` § Research Outcomes
- [x] 4.7 Bump `protocol-datasheet.md` doc-version header to reflect v2.1.112 reference
- [x] 4.8 Manual end-to-end header diff captured via `scripts/inspect-beta-header.ts`; byte-equivalent to test-vector "opencode-default" (evidence: `docs/events/event_20260503_claude-provider-beta-realign.md` § Phase 4.8)

## 5. Verification + commit gate

- [x] 5.1 `bun test packages/provider-claude/` green (32 pass / 0 fail)
- [x] 5.2 `grep -rc "MINIMUM_BETAS" packages/provider-claude/src/` returns 0 (R-2)
- [x] 5.3 No new dependency on `@ai-sdk/anthropic` introduced (only the existing comment reference)
- [x] 5.4 `tsc --noEmit` reports no new errors (pre-existing `Set<string>` warning resolved as side-effect)
- [x] 5.5 Final commit on `beta/claude-provider-realign` (0c8b51db4)
- [x] 5.6 Promote `implementing → verified` after fetch-back validation (handled by spec closeout step)
