# Spec: Codex Rotation Hotfix

## Purpose

Make codex 5H / weekly exhaustion a first-class rotation trigger, restrict codex family fallback to codex-only accounts, and surface a clear error when no codex account has quota headroom.

## Requirements

### Requirement: Codex is a cockpit-strategy provider

The system SHALL treat codex family the same as openai for proactive quota checking. The cockpit path SHALL poll `chatgpt.com/backend-api/wham/usage` for codex accounts and compute `{ hourlyRemaining, weeklyRemaining }` from the response.

#### Scenario: codex account approaches 5H exhaustion
- **GIVEN** a session pinned to a codex subscription account with ~0 hourly remaining
- **WHEN** the next request is about to dispatch (pre-flight cockpit check path)
- **THEN** `fetchCockpitBackoff` returns a non-null backoff (≥ the 5H reset-time delta) for that account
- **AND** rotation is triggered before the stall-prone HTTP/WS call goes out

#### Scenario: codex cockpit fetch fails
- **GIVEN** the cockpit poll itself errors (network / upstream 5xx)
- **WHEN** the fetch throws
- **THEN** the cockpit path falls back to `"passive"` classification (no backoff imposed from cockpit; the request fires and any real error is caught post-hoc)
- **AND** `log.warn` records the cockpit failure (AGENTS.md 第一條 — no silent swallow)

### Requirement: Rotation candidate filter honors codex quota

The system SHALL exclude codex candidates from the rotation pool when either `hourlyRemaining` or `weeklyRemaining` is non-positive, mirroring the openai filter already present.

#### Scenario: one codex account exhausted, siblings healthy
- **GIVEN** account A (codex) is 5H-exhausted and accounts B, C (codex, same family) have headroom
- **WHEN** `buildFallbackCandidates` runs with A as `currentVector.accountId`
- **THEN** A is either `isQuotaLimited=true` (and skipped) OR excluded as `isExactCurrent`
- **AND** B and C appear in the candidate list with `isRateLimited=false`

#### Scenario: codex account weekly exhausted but hourly available
- **GIVEN** an account whose `weeklyRemaining` is at or below zero and `hourlyRemaining` still has headroom
- **WHEN** it is scored as a candidate
- **THEN** it is still flagged `isQuotaLimited=true` (weekly gate is absolute)
- **AND** excluded from the ranked candidate list

### Requirement: Codex family rotation is same-provider-only

The system SHALL refuse cross-provider fallback when `currentVector.providerId` is codex. If no codex candidate has headroom, `findFallback` returns null and `handleRateLimitFallback` surfaces a codex-specific exhaustion error to the session.

#### Scenario: all codex accounts exhausted
- **GIVEN** every codex account in `Account.listAll()` has non-positive `hourlyRemaining` OR non-positive `weeklyRemaining`
- **WHEN** rotation fires on any codex vector
- **THEN** `findFallback` returns null
- **AND** a `CodexFamilyExhausted` error (or equivalent) is raised with a message identifying the operator's next step (wait for 5H reset / switch provider manually)
- **AND** the daemon does NOT silently rotate to openai / anthropic / gemini

#### Scenario: codex has healthy siblings but another provider has abundant quota
- **GIVEN** one codex account is exhausted, two codex siblings are healthy, and an anthropic account is fully available
- **WHEN** rotation picks a fallback for the exhausted codex vector
- **THEN** it MUST choose one of the codex siblings (same-provider-only rule)
- **AND** MUST NOT choose the anthropic account

### Requirement: Error classification recognizes codex 5H shapes (belt-and-suspenders)

The system SHALL classify post-hoc error messages from codex that reference "5 hour", "response window", "usage limit", or similar 5H-specific phrases as `"QUOTA_EXHAUSTED"` in `packages/opencode/src/account/rotation/backoff.ts`, so the passive path still works if cockpit missed.

#### Scenario: codex request stalls and upstream eventually returns a 5H-specific message
- **GIVEN** the cockpit path did not trigger (either disabled or lagged) and the HTTP response arrives with a body containing "5 hour limit reached" or "response_time_window_exhausted"
- **WHEN** the backoff parser runs
- **THEN** the reason is classified `"QUOTA_EXHAUSTED"`
- **AND** rotation fires with a 5H (or reset-time-appropriate) backoff

### Requirement: All fallback paths log their decisions (AGENTS.md 第一條)

The system SHALL emit at least one `log.info` / `log.warn` line on each new branch introduced by this hotfix:

- cockpit fetched codex quota → log (account id, hourly/weekly remaining)
- codex candidate skipped due to exhausted quota → log (account id, reason)
- codex-family-only path rejected a cross-provider candidate → log (candidate provider, reason)
- codex-family-exhausted surface → log + error

#### Scenario: operator diagnoses a sudden stall
- **GIVEN** the cockpit correctly marks a codex account exhausted and rotation fires
- **WHEN** the operator greps the daemon log
- **THEN** a single sequence of lines makes the decision chain obvious: "codex cockpit: hourly 0, weekly 42" → "skip codex candidate ivon0829: isQuotaLimited" → "selecting codex candidate yeatsluo-thesmart-cc"

## Acceptance Checks

- Unit test: `fetchCockpitBackoff` returns non-null for a codex account whose mocked quota shows `hourlyRemaining=0, weeklyRemaining>0`, and the backoff duration equals the hourly reset delta.
- Unit test: `buildFallbackCandidates` input includes 3 codex accounts (one exhausted), output list has the exhausted one flagged `isQuotaLimited=true` and the other two with `isRateLimited=false`.
- Unit test: `findFallback` called with codex current vector + all codex accounts exhausted returns null; called with healthy siblings returns one of them (never a non-codex provider).
- Unit test: backoff reason parser classifies synthetic `"5 hour limit reached"` and `"response_time_window_exhausted"` messages as `"QUOTA_EXHAUSTED"`.
- Integration (manual): operator triggers a real 5H exhaust on a codex account, observes (a) cockpit marks it before stall OR (b) post-error rotates to sibling; daemon log shows the observable lines enumerated above.
- Regression: `bun test packages/opencode/test/account/` + `bun test packages/opencode/test/provider/` match or beat pre-hotfix main baseline (5 pre-existing failures unchanged).
