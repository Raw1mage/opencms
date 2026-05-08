# provider / claude

> Wiki entry. Source of truth = current code under
> `packages/opencode-claude-provider/src/`,
> `packages/opencode/src/provider/transform.ts` (cache breakpoint
> logic), and `packages/opencode/src/session/claude-import.ts`
> (Claude Code native takeover import).
> Replaces the legacy spec package
> `claude-provider-beta-fingerprint-realign`.

## Status

shipped (live as of 2026-05-04).

`claude-provider-beta-fingerprint-realign` is shipped: `assembleBetas`
in `@opencode-ai/claude-provider` mirrors upstream `ZR1` push order
and `MINIMUM_BETAS` is removed.

Claude Code native takeover (sidebar tab + import/delta + takeover
compaction anchor) is shipped as of 2026-05-05 — see
[claude-session-list/](./claude-session-list/) for the original plan
package and lifecycle detail.

## Current behavior

### assembleBetas mirrors upstream ZR1

`assembleBetas(options)` in
`opencode-claude-provider/src/protocol.ts:232` produces the
`anthropic-beta` header values byte-equivalently to upstream
`claude-code@2.1.112` `ZR1`. Push order:

1. `claude-code-20250219` — if `!isHaiku`
2. `oauth-2025-04-20` — if `isOAuth`
3. `context-1m-2025-08-07` — if `supports1M(model)`
4. `interleaved-thinking-2025-05-14` — if
   `supportsThinking(model) && !disableInterleavedThinking`
5. `redact-thinking-2026-02-12` — if `isFirstPartyish(provider) &&
   !disableExperimentalBetas && supportsThinking(model) &&
   !disableInterleavedThinking && isInteractive &&
   !showThinkingSummaries`. Opencode runtime always passes
   `isInteractive=false` (DD-17), so this is suppressed in the
   daemon path.
6. `context-management-2025-06-27` — if `provider==="firstParty"
   && !disableExperimentalBetas &&
   modelSupportsContextManagement(model, provider)`
7. RESERVED slot: `structured-outputs-2025-12-15` (upstream `t76`,
   not emitted)
8. RESERVED slot: `web-search-2025-03-05` (upstream `Qv1`, vertex/
   foundry only, not emitted)
9. `prompt-caching-scope-2026-01-05` — if
   `isFirstPartyish(provider) && !disableExperimentalBetas` (NOT
   gated on `isOAuth`, DD-11)
10. env-supplied `ANTHROPIC_BETAS` appended, then deduped

`MINIMUM_BETAS` constant is removed (members repositioned as
conditional pushes). `isFirstPartyish(p)` =
`p ∈ {firstParty, anthropicAws, foundry, mantle}`.
`modelSupportsContextManagement(m, p)`: foundry → true;
firstPartyish → `!m.startsWith("claude-3-")`; else → matches
opus-4 / sonnet-4 / haiku-4.

### Cache breakpoint placement

`ProviderTransform.applyCaching` (`provider/transform.ts:252`)
places ephemeral cache breakpoints. Phase B explicit breakpoints
(BP2 = T1 end, BP3 = T2 end) are walked from
`providerOptions.phaseB.breakpoint=true` markers placed by the
context preface emitter; legacy BP1 (system tail) and BP4
(conversation tail) are placed by tail-position rule. Caching is
disabled for subscription sessions and for native providers
(`@opencode-ai/claude-provider`, `@opencode-ai/codex-provider`)
because those providers manage their own cache.

### Claude Code native takeover

Claude Code native takeover is an explicit adapter boundary, not a
storage fallback. `packages/opencode/src/session/claude-import.ts`
reads project-scoped Claude JSONL transcripts from the supported
Claude Code project transcript convention or an explicit transcript
path, deterministically normalizes user/assistant text plus bounded
tool evidence, and fails fast on unsupported blocks.
`packages/opencode/src/server/routes/session.ts` exposes
`GET /session/import/claude` for project-scoped native transcript
rows and `POST /session/import/claude` for idempotent import/delta
sync. Imported takeover sessions are written only through
`Session.createNext`, `Session.updateMessage`, and
`Session.updatePart`, preserving Bus events and `MessageV2`
storage-router authority. Large takeover imports may add
deterministic assistant summary anchors plus `compaction` marker
parts into the same message stream; no Claude-specific sidecar
compaction store exists, and `MessageV2.filterCompacted` remains
the LLM-visible anchor boundary.

Provider-switch recovery in
`packages/opencode/src/session/prompt.ts` treats takeover anchors
as stale handoff material once a newer live user turn exists, and
provider-switch compaction is non-continuing (`auto:false`) so a
defensive rebind never fabricates a follow-up prompt from an
imported handoff.

The deterministic new-content indicator
(`currentLineCount`, `importedLineCount`, `hasNewContent`) drives
the sidebar green-dot affordance.

## Code anchors

Claude provider package (`packages/opencode-claude-provider/src/`):

- `protocol.ts` — `assembleBetas` at L232; per-flag constants
  L77–L86; `isFirstPartyish` L115; model predicates L124–L168.
- `headers.ts`, `convert.ts`, `provider.ts`, `auth.ts`, `sse.ts`,
  `models.ts` — supporting modules.

Cache placement:

- `packages/opencode/src/provider/transform.ts` —
  `ProviderTransform.applyCaching` L252; subscription / native
  provider opt-out L397.
- `packages/opencode/src/provider/transform.applyCaching.test.ts`
  — BP1–BP4 placement coverage.

Claude takeover import:

- `packages/opencode/src/session/claude-import.ts` —
  deterministic transcript normalizer.
- `packages/opencode/src/server/routes/session.ts` —
  `GET /session/import/claude`,
  `POST /session/import/claude` import/delta endpoint.
- `packages/opencode/src/session/prompt.ts` — provider-switch
  recovery handling for stale takeover anchors.

Registration in core registry:

- `packages/opencode/src/provider/provider.ts` —
  `CUSTOM_LOADERS["claude-cli"]`, anthropic auth plugin entry.

## Sub-packages

- [claude-session-list/](./claude-session-list/) (shipped, all
  tasks ✓ as of 2026-05-05) — Claude session list sidebar tab,
  import/delta sync, takeover compaction anchor. Task list is
  fully checked; folder is preserved as the lifecycle history
  rather than archived in place.

## Known issues

No active fix packages targeting the claude-cli / anthropic provider
at this time. New fix packages would land as a sub-package under
this folder (e.g. `provider/claude/<slug>/`).

## Notes

### Related entries

- [provider/](../README.md) — cross-provider abstraction (registry,
  family, dispatch, LMv2 envelope).
- [provider/codex/](../codex/README.md) — codex side, in case the
  comparable header / WS fingerprint is what you came for.
- [compaction/](../../compaction/README.md) — `MessageV2.filterCompacted`,
  takeover anchor boundary mechanics.
- [session/](../../session/README.md) — runloop, takeover session
  identity, sidebar Claude tab UI surface.
- [account/](../../account/README.md) — anthropic account /
  subscription handling.
