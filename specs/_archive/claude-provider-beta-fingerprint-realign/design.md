# Design: claude-provider-beta-fingerprint-realign

## Context

`@opencode-ai/provider-claude` is opencode's wire-fingerprint mimicry layer for the Anthropic API. It exists because the official `claude-code` CLI is treated by Anthropic's backend as a first-party client and gets capabilities (e.g. subscription auth, oauth-scoped prompt caching, context-1m beta) that third-party `@ai-sdk/anthropic` calls do not. To stay first-party-shaped, every byte of the outgoing request — User-Agent, attribution salt, billing header, identity strings, beta flag list — must match what `claude-code` itself sends.

The package was bootstrapped from `claude-code@2.1.92`'s minified `cli.js`. Static constants were correctly extracted. The dynamic beta-flag assembler, however, was simplified into a `MINIMUM_BETAS + conditional pushes` pattern that does not reproduce upstream's actual decision tree. A grep against `refs/claude-code-npm/cli.js` (now pinned at v2.1.112, the last upstream JS-source release before native-binary distribution at v2.1.113) found the canonical assembler at function `ZR1`, which uses **per-flag condition pushes** with a specific order. Five concrete divergences (enumerated in proposal.md §Why) result.

This plan rewrites `assembleBetas()` to mirror `ZR1` structurally. It does not extend wire-level behavior to flags currently outside opencode's path (`structured-outputs-2025-12-15`, `web-search-2025-03-05`) but reserves their positions in source for future work.

## Goals / Non-Goals

### Goals

- Byte-equivalence of `anthropic-beta` header for any (model × auth × provider × env) opencode actually exercises
- Source-code structural parity with upstream `ZR1` so the next bump is a mechanical re-grep, not a redesign
- Per-flag traceability via inline comments referencing cli.js minified variable names (`// upstream: i7()`)
- Matrix unit-test coverage that catches future drift on the next upstream change
- Removal of the misleading `MINIMUM_BETAS` export

### Non-Goals

- Activating `structured-outputs-2025-12-15` (requires a `tengu_*` feature-flag plumbing not present in opencode)
- Activating `web-search-2025-03-05` (vertex/foundry-only; opencode does not route through these gateways)
- Generalized provider abstraction for future Bedrock/Vertex support — only enough enum surface to model the conditional today
- Bumping `refs/claude-code-npm/` past v2.1.112 (impossible — v2.1.113+ is native binary)
- Touching the message/system-block conversion layer (already audited clean)
- Fixing the unrelated `providerOptions.thinking` camelCase passthrough or the cache-TTL=1h gap (separate plans, see proposal.md §OUT)

## Decisions

- **DD-1** — Drop `MINIMUM_BETAS` constant entirely; do not even keep it as `@deprecated`. **Why:** the concept is wrong (no upstream "always-send" set exists), and keeping it tempts future contributors to add new flags there. Internal package, no external consumer; breaking change is acceptable.
- **DD-2** — Reverse-engineer upstream predicates as named TypeScript helpers, one per minified function: `isHaikuModel(modelId)`, `supports1MContext(modelId)`, `supportsThinking(modelId)`, `modelSupportsContextManagement(modelId)`. Each helper carries a `// upstream: <minifiedName>` comment plus the cli.js offset. **Why:** future bumps need to re-verify each predicate independently; a monolithic giant if/else hides drift.
- **DD-3** — Add three new fields to `AssembleBetasOptions`: `provider: "firstParty" | "bedrock" | "vertex" | "foundry"` (default `"firstParty"`), `showThinkingSummaries: boolean` (default `false`), `disableExperimentalBetas: boolean` (default reads `process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`). **Why:** these are the three condition variables the upstream ZR1 reads that we currently don't model. Defaults chosen to preserve current opencode behavior except where the bug fix demands a change.
- **DD-4** — `provider.ts` keeps a hardcoded `provider: "firstParty"` for now. **Why:** opencode only routes through Anthropic direct; threading the value end-to-end is wasted effort until Bedrock/Vertex support is real. The `AssembleBetasOptions` field exists so unit tests can exercise non-firstParty branches.
- **DD-5** — `redact-thinking-2026-02-12` is a new exported constant; the corresponding push site is gated by `isOAuth && supportsThinking(modelId) && !DISABLE_INTERLEAVED_THINKING && !showThinkingSummaries`. **Why:** matches upstream `Y && ggq(q) && !I7() && v7().showThinkingSummaries !== !0` literally.
- **DD-6** — Reserved slots for `structured-outputs-2025-12-15` and `web-search-2025-03-05` are documented as `// RESERVED:` comments at the correct push positions, not as commented-out code. **Why:** commented-out `K.push(...)` lines are brittle and tempt accidental enablement; comments-only force a deliberate edit when the day comes.
- **DD-7** — Push order is enforced by the structural arrangement of the function body, not by a post-hoc sort. **Why:** sort-after introduces the risk of subtle ordering bugs when a future flag's condition overlaps; structural ordering matches upstream and is easier to read.
- **DD-8** — Matrix unit tests live in `packages/provider-claude/test/protocol.test.ts` (new file) and consume `specs/_archive/claude-provider-beta-fingerprint-realign/test-vectors.json` as fixture. **Why:** spec carries authoritative input/output pairs; tests are the runtime check that source still produces them.
- **DD-9** — `prompt-caching-scope-2026-01-05` condition resolution: do the grep verification of `ja()` during the `designed → planned` transition (it is a one-line check). If equivalent, keep `isOAuth`. If divergent, reopen Requirement 6 as an addendum. **Why:** uncertainty here is small enough to defer slightly; resolving it now would block this plan unnecessarily.
- **DD-10** — `protocol-datasheet.md` is updated as part of this plan (in `tasks.md` Phase 4). **Why:** the datasheet is the human-readable counterpart to the source code; keeping them in sync is a project-wide rule (AGENTS.md §Template/Runtime sync).

## Risks / Trade-offs

- **R-1** — `modelSupportsContextManagement(modelId)` predicate semantics are not fully recovered yet. Upstream `iO_(q)` is minified and may itself depend on multiple model attributes. **Mitigation:** during designed→planned, grep `iO_` callers and walk the call graph; if the predicate is non-trivial, document its full logic in a `// upstream: iO_` block. If it depends on data we do not have (e.g. a model registry attribute), fall back to a model-id allow-list and flag in design.md as a known limitation.
- **R-2** — Removing `MINIMUM_BETAS` from `protocol.ts` exports could break downstream code we did not grep for. **Mitigation:** before commit, grep the entire opencode tree for `MINIMUM_BETAS` and confirm zero hits. If non-zero, refactor those call sites first.
- **R-3** — Order parity matters only if Anthropic server-side does string-equality fingerprinting of the comma-joined header. We have no proof either way. **Mitigation:** treat order parity as defense-in-depth, not as the primary correctness goal; the primary goal is the per-flag conditional logic.
- **R-4** — `redact-thinking-2026-02-12` being absent from current opencode requests has not caused observable problems, suggesting Anthropic's server tolerates its omission. Adding it could change response shape (thinking content might now arrive redacted). **Mitigation:** verify in a manual test session that adding the flag does not break thinking-content rendering downstream.
- **R-5** — `disableExperimentalBetas` defaulting to reading `process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` introduces an implicit env coupling to library code. **Mitigation:** keep the env read at the call site (provider.ts), not inside `assembleBetas()`. The library function takes the resolved boolean.
- **R-6** — Test matrix size could explode (4 models × 2 auths × 4 providers × 2 env × 2 summaries × 2 thinking-disabled = 256 cases). **Mitigation:** prune to a representative sample (~20 cases) covering each conditional branch's ON/OFF cross-product, not the full Cartesian product. Document pruning rationale in test-vectors.json header.

## Research Outcomes (resolutions for DD-9 and R-1)

Greps performed against `refs/claude-code-npm/cli.js` between `designed` promotion and `planned` drafting; recovered four upstream predicates that gate the assembler.

- **`ja()` definition (offset 3481451):**
  `(provider === "firstParty" || provider === "anthropicAws" || provider === "foundry") && !DISABLE_EXPERIMENTAL_BETAS`. **Not equivalent to `isOAuth`.** This resolves DD-9 with a divergent finding: spec.md Requirement 6 must be replaced.
- **`iO_(q)` definition (offset 3480483):** modelId normalized; if provider=`foundry` → true ; else if `$Q(provider)` (i.e. provider ∈ {firstParty, anthropicAws, foundry, mantle}) → `!modelId.includes("claude-3-")` ; else → `contains(opus-4) || contains(sonnet-4) || contains(haiku-4)`. Resolves R-1.
- **`I7()` definition (offset 38983):** `!B8.isInteractive`. True when running in non-interactive mode (SDK, `-p`, headless). The redact-thinking gate's `!I7()` therefore means **interactive mode required**.
- **`$Q(provider)` definition (offset 2317694):** provider ∈ {firstParty, anthropicAws, foundry, **mantle**}. Adds a fourth provider `mantle` not in our current enum.

### Decisions added from research

- **DD-11** Replace the originally-assumed "ja() ≈ isOAuth" with the real condition. Both `redact-thinking-2026-02-12` and `prompt-caching-scope-2026-01-05` are gated on `ja()`-equivalent: `isFirstPartyish && !disableExperimentalBetas`. **Why:** correct upstream fidelity. **Effect:** spec.md Requirement 6 is rewritten (see Layer-2 supersede below); data-schema.json adds no field — `provider` and `disableExperimentalBetas` already exist.
- **DD-12** `modelSupportsContextManagement(modelId, provider)` is now fully specified (R-1 closed). It takes BOTH modelId and provider; its semantics: provider=foundry → true ; provider in firstPartyish set → not-claude-3 ; else → opus-4/sonnet-4/haiku-4 substring match.
- **DD-13** Add an `isInteractive` field to `AssembleBetasOptions`, default `false` (opencode runs as a daemon, not a TTY-interactive process). The redact-thinking gate adds `&& isInteractive`. **Why:** without this, redact-thinking would be sent in opencode's server context where upstream would suppress it. **Effect:** in production this means redact-thinking will rarely fire from opencode; matrix tests still cover both branches.
- **DD-14** Add `"mantle"` to the `ProviderRoute` enum for completeness even though opencode never routes through it. **Why:** keeps the predicate `isFirstPartyish` consistent with upstream `$Q()`.
- **DD-15** Introduce a small helper `isFirstPartyish(provider)` returning true for {firstParty, anthropicAws, foundry, mantle}. Reused by `ja()`-equivalent and by `modelSupportsContextManagement`. **Why:** single source of truth for the upstream `$Q()` set.
- **DD-16 (deployment posture, opencode-specific)** opencode's authentication posture is **OAuth-only, no API-key fallback**. The `assembleBetas()` function signature still accepts `isOAuth` so the unit-test matrix can verify upstream fidelity on both branches, but `provider.ts` hardcodes `isOAuth: true` at the call site and there is no code path that produces `isOAuth: false`. **Why:** opencode is a multi-account subscription-routing layer; API-key auth would defeat its product purpose and bypass the rotation/quota stack. **Effect on this plan:** in production all opencode requests fire the `oauth-2025-04-20` flag unconditionally (subject to non-haiku check). The "isOAuth=false" rows of the test matrix are upstream-parity assertions, not deployment scenarios.
- **DD-17 (deployment posture, opencode-specific)** opencode runs as a daemon, **`isInteractive` is always `false`** at the `provider.ts` call site. `redact-thinking-2026-02-12` therefore never fires from opencode's runtime path. This is a deliberate deployment-topology divergence from claude-code CLI (which targets interactive TTYs); it is not a bug. **Why:** opencode terminates SSE streams to web/TUI clients, not to a TTY; upstream's `B8.isInteractive` semantics do not apply. **Effect:** matrix tests still cover `isInteractive=true` for upstream fidelity assertions, but production never hits that branch.

### Spec impact (Layer-2 supersede applied directly to spec.md)

- Requirement 3 (redact-thinking): condition gains `&& isInteractive`.
- Requirement 6 superseded: condition is now `isFirstPartyish(provider) && !disableExperimentalBetas`, NOT `isOAuth`. Mark old wording with `(v1, SUPERSEDED 2026-05-03)`.
- Requirement 4 push-order canonical example updated: under opencode's typical non-interactive mode, `redact-thinking-2026-02-12` is absent.

## Critical Files

- [packages/provider-claude/src/protocol.ts](packages/provider-claude/src/protocol.ts) — assembler rewrite + new constants/helpers + remove `MINIMUM_BETAS`
- [packages/provider-claude/src/headers.ts](packages/provider-claude/src/headers.ts) — `BuildHeadersOptions` plumbing for new fields
- [packages/provider-claude/src/provider.ts](packages/provider-claude/src/provider.ts) — call site providing `provider`, `showThinkingSummaries`, `disableExperimentalBetas` from env / hardcoded defaults
- [packages/provider-claude/test/protocol.test.ts](packages/provider-claude/test/protocol.test.ts) — NEW; matrix tests consuming `test-vectors.json`
- [refs/claude-code-npm/cli.js](refs/claude-code-npm/cli.js) — read-only ground truth; cite offsets in comments (function `ZR1` at offset ~3482150, beta constants at ~2439173)
- [plans/claude-provider/protocol-datasheet.md](plans/claude-provider/protocol-datasheet.md) — datasheet update for v2.1.112 logic
- [specs/_archive/claude-provider-beta-fingerprint-realign/test-vectors.json](specs/_archive/claude-provider-beta-fingerprint-realign/test-vectors.json) — matrix fixture
