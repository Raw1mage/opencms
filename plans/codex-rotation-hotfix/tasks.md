# Tasks

## 1. Phase 1 — Cockpit extension for codex

- [ ] 1.1 audit `rate-limit-judge.ts` strategy classification + `fetchCockpitBackoff` gate; confirm `providerId === "openai"` at line 543 is the only gate needing change.
- [ ] 1.2 audit Account.resolveFamily / parseFamily behavior for codex-subscription-* ids — confirm the right helper name.
- [ ] 1.3 integrate codex into cockpit path: change the gate to accept openai OR codex family; route through existing `getOpenAIQuota` (no new endpoint).
- [ ] 1.4 emit log.info on cockpit codex decision (account id, hourly / weekly remaining, backoff decision).
- [ ] 1.5 validate: unit test mocks quota to `hourlyRemaining: 0, weeklyRemaining: 42` for a codex account; fetchCockpitBackoff returns non-null with backoff ≥ hourly reset delta.
- [ ] 1.6 validate: mocked fetch failure falls through to passive; log.warn fires; no thrown exception.

## 2. Phase 2 — Candidate quota filter for codex

- [ ] 2.1 audit `rotation3d.ts::buildFallbackCandidates` around line 596-605 to confirm the shape of the openai-only quota filter.
- [ ] 2.2 extend `isQuotaLimited` to include codex family: accounts with hourlyRemaining or weeklyRemaining `<= 0` get marked.
- [ ] 2.3 emit log.info when a codex candidate is marked isQuotaLimited (account id, which window exhausted).
- [ ] 2.4 validate: unit test with 3 codex candidate vectors (one exhausted) — only the healthy two survive the filter.

## 3. Phase 3 — Codex-family-only fallback gate

- [ ] 3.1 audit callers of `findFallback` / `buildFallbackCandidates` + the handleRateLimitFallback surface in `llm.ts`.
- [ ] 3.2 inside buildFallbackCandidates: when `currentVector.providerId` resolves to codex family, drop candidates whose family is not codex BEFORE scoring.
- [ ] 3.3 integrate new `CodexFamilyExhausted` NamedError in the right module (likely `rate-limit-judge.ts` or `rotation3d.ts` export).
- [ ] 3.4 handleRateLimitFallback: when null returned AND the current vector was codex AND all same-family candidates were exhausted → throw CodexFamilyExhausted so the session surface shows a codex-specific message.
- [ ] 3.5 emit log.info when a non-codex candidate is rejected due to codex-family-only rule.
- [ ] 3.6 audit preflight error-surface in `session/processor.ts` (~line 580-591) — confirm it tolerates the new error or extend minimally.
- [ ] 3.7 validate: mixed-candidate test (2 codex healthy, 1 anthropic healthy, currentVector=codex-exhausted) — findFallback returns codex, never anthropic.
- [ ] 3.8 validate: all-codex-exhausted test — findFallback returns null; handleRateLimitFallback raises CodexFamilyExhausted.

## 4. Phase 4 — Passive classification belt-and-suspenders

- [ ] 4.1 audit `rotation/backoff.ts::parseRateLimitReason` existing message patterns.
- [ ] 4.2 integrate codex-specific patterns (5-hour window, response_time_window, usage limit reached / exceeded) mapped to `"QUOTA_EXHAUSTED"`.
- [ ] 4.3 validate: unit test parses synthetic codex 5H messages and asserts classification.

## 5. Phase 5 — Tests + docs + closeout

- [ ] 5.1 run full regression: `bun test packages/opencode/test/account/`, `packages/opencode/test/provider/`, `packages/opencode/test/session/`. Match or beat main baseline (5 pre-existing failures unchanged).
- [ ] 5.2 write `docs/events/event_2026-04-18_codex_rotation_hotfix.md` describing all four phases + phase-level test counts.
- [ ] 5.3 sync `specs/architecture.md` Provider Universe Authority section with a one-paragraph note on the codex-family-only rotation rule.
- [ ] 5.4 commit per phase on beta/codex-rotation-hotfix.
- [ ] 5.5 fetch-back + merge per beta-workflow after operator approval.

## 6. Retrospective

- [ ] 6.1 append `docs/events/` final status after merge.
- [ ] 6.2 compare implementation vs `proposal.md` Effective Requirement Description (4 items).
- [ ] 6.3 produce validation checklist: requirement coverage, gaps, deferred, evidence.
