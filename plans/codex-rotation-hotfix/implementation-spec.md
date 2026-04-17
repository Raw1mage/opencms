# Implementation Spec

## Goal

- Ship a rotation hotfix covering (1) proactive codex 5H cockpit detection, (2) codex-aware rotation candidate filtering, (3) hard-coded codex-family-only fallback when the current vector is codex, (4) belt-and-suspenders error-message classification, plus observability and tests. All changes backend-only.

## Scope

### IN

- Extend cockpit strategy (rate-limit-judge.ts line ~543) so codex family flows through `getOpenAIQuota` same as openai. No new endpoint, no new strategy enum — reuse existing.
- Extend candidate `isQuotaLimited` in rotation3d.ts (lines ~596-605) to codex family.
- Add codex-family-only gate in `buildFallbackCandidates` when `currentVector.providerId` resolves to codex family — drop non-codex candidates before scoring.
- Raise `CodexFamilyExhausted` (NamedError) when `findFallback` returns null under the codex-only path; `handleRateLimitFallback` converts this into the session error path.
- Extend `backoff.ts::parseRateLimitReason` with codex 5H / response-time-window / usage-limit pattern matches.
- log.info on every new decision branch (cockpit codex, skip exhausted codex, reject non-codex candidate, codex-family-exhausted).
- Unit tests: cockpit codex positive, candidate quota filter, codex-only fallback null, 5H pattern classification.
- docs/events/event_2026-04-18_codex_rotation_hotfix.md.

### OUT

- Changing openai cockpit or scoring — those already work.
- Adding a config flag for same-provider-only (user rejected Option B).
- Changing the quota endpoint, token refresh, or account storage.
- Webapp / TUI protocol changes — footer already polls `/api/v2/account/quota` via the 10s poller shipped earlier today.
- Unifying openai / codex families or aliasing accounts across them.
- tweaks.cfg infrastructure (separate future concern).

## Assumptions

- codex subscription OAuth tokens (already in `accounts.json` under family=codex) work for `GET https://chatgpt.com/backend-api/wham/usage` — verified indirectly by the openai family using the same endpoint with identical bearer format. Build agent MUST smoke-check this by running an auth-equipped test or reading the `quota/openai.ts::fetchOpenAIQuotaOnce` path and confirming there is no openai-specific parameter; if any codex-token rejection happens, STOP and re-plan with a codex-specific endpoint.
- `Account.resolveFamily` or the module's provider-family helper correctly maps `codex-subscription-*` account ids to family `"codex"`. Build agent MUST verify before relying on it; the codebase has been known to use multiple alias helpers (`Account.parseFamily`, `Account.resolveProvider`).
- The `{ hourlyRemaining, weeklyRemaining }` shape returned by `getOpenAIQuota` is universal across openai and codex-subscription accounts (i.e. codex does not return a different JSON structure). Build agent MUST add one integration smoke test to confirm.
- `handleRateLimitFallback` callers tolerate a distinct `CodexFamilyExhausted` error; the existing generic-null-fallback path in `session/processor.ts:580-591` can accept the new error without further changes to the processor. Build agent MUST audit the preflight error-surface path and extend it minimally if needed.

## Stop Gates

- **Pre-coding audit mandatory.** Before any edit: confirm `Account.resolveFamily` behavior for codex-subscription-* ids; confirm wham/usage endpoint accepts codex tokens; confirm the `CodexFamilyExhausted` error can be surfaced without rewriting processor preflight. If any assumption is wrong, stop and re-plan.
- **No cross-family side effects.** The cockpit extension adds codex; it MUST NOT change behavior for openai / google-api / gemini-cli / anthropic / other families. Grep every `providerId === "openai"` check in rate-limit-judge.ts and account/quota/ to confirm none is being silently broadened.
- **No scope creep into tweaks.cfg / config flag.** The codex-only gate is hard-coded per DD-5. If the build agent feels tempted to add a `sameProviderOnly` config, STOP — that is explicitly out of scope.
- **Regression gate.** `bun test packages/opencode/test/account/` + `bun test packages/opencode/test/provider/` must match or beat pre-hotfix main baseline (5 pre-existing failures unchanged). Any new failure blocks commit.
- **Log line budget.** Every new decision branch emits exactly one log line per decision, not per candidate. Do not spray log.info for every rejected candidate in a 6-account pool.

## Critical Files

- [packages/opencode/src/account/rate-limit-judge.ts](../../packages/opencode/src/account/rate-limit-judge.ts) — cockpit gate extension for codex (Phase 1).
- [packages/opencode/src/account/rotation3d.ts](../../packages/opencode/src/account/rotation3d.ts) — buildFallbackCandidates quota filter + family-only gate (Phase 2 + 3).
- [packages/opencode/src/account/rotation/backoff.ts](../../packages/opencode/src/account/rotation/backoff.ts) — passive classification patterns (Phase 4).
- [packages/opencode/src/session/llm.ts](../../packages/opencode/src/session/llm.ts) — handleRateLimitFallback surfaces CodexFamilyExhausted (Phase 3 integration).
- [packages/opencode/src/account/quota/openai.ts](../../packages/opencode/src/account/quota/openai.ts) — consumed as-is, no edits.
- Tests: extend `packages/opencode/test/account/` with cockpit-codex + candidate-filter cases; extend `packages/opencode/test/session/` for handleRateLimitFallback null-path.
- Docs: new `docs/events/event_2026-04-18_codex_rotation_hotfix.md`.

## Structured Execution Phases

- **Phase 1 — Cockpit extension for codex** (rate-limit-judge.ts). Add provider-family awareness; route codex through existing `fetchCockpitBackoff` path; log.info on codex cockpit decision.
- **Phase 2 — Candidate quota filter for codex** (rotation3d.ts buildFallbackCandidates). Extend the existing openai-only quota check to also cover codex; add log.info when a codex candidate is skipped due to exhausted hourly / weekly.
- **Phase 3 — Codex-family-only gate** (rotation3d.ts + llm.ts). When current vector is codex, drop non-codex candidates pre-scoring. If empty pool, raise CodexFamilyExhausted from handleRateLimitFallback; log.info on the cross-provider-rejection decision.
- **Phase 4 — Passive classification belt-and-suspenders** (backoff.ts). Add codex-specific 5H / response-time-window / usage-limit patterns to parseRateLimitReason.
- **Phase 5 — Tests + docs/events + plan closeout.** Unit tests per phase. docs/events entry. tasks.md check-off. Keep commits per-phase so fetch-back diff stays readable.

## Validation

- **Phase 1**: unit test mocks `getOpenAIQuota` to return `{hourlyRemaining: 0}` for a codex account; `fetchCockpitBackoff({providerId:"codex", accountId:...})` returns non-null, with backoff ≥ 1 hour. Also: mock fetch failure — result falls through to passive, log.warn fired, no exception leaks.
- **Phase 2**: unit test constructs 3 candidate codex vectors (one exhausted), calls `buildFallbackCandidates`, asserts the exhausted one has `isQuotaLimited=true` and does not appear in the filtered output.
- **Phase 3**: unit test constructs mixed candidates (2 codex healthy, 1 anthropic healthy, currentVector=codex-exhausted). `findFallback` returns a codex candidate; assert it is never the anthropic candidate. Second test: all codex exhausted, anthropic healthy — `findFallback` returns null; `handleRateLimitFallback` surfaces CodexFamilyExhausted.
- **Phase 4**: unit test `parseRateLimitReason` returns `"QUOTA_EXHAUSTED"` for synthetic messages `"5 hour limit reached"`, `"response_time_window_exhausted"`, `"usage limit reached"`; returns previous value for non-matching messages.
- **Phase 5**: full regression suite (`test/account/`, `test/provider/`, `test/session/`) — pass-count meets or exceeds current baseline; no new failures.

## Handoff

- Build agent MUST read `implementation-spec.md` first, then `proposal.md`, `spec.md`, `design.md`, `tasks.md`, `handoff.md`, plus `specs/codex/provider-hotfix/` (sibling package) + `specs/architecture.md` (Provider Universe Authority section).
- Runtime todo MUST be materialized from `tasks.md` via `todowrite(mode=replan_adoption)` before coding.
- Build agent MUST NOT resume from discussion memory — this plan package is the execution contract.
- Every Phase is small and independent enough to land as its own commit on the beta branch. Validate at phase boundaries before moving on. Phase 3 is the highest-risk phase; do it AFTER Phase 1 + 2 land.
- At completion, compare implementation results against the four Effective Requirements in `proposal.md` and produce a validation checklist.
