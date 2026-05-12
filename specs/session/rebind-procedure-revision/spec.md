# Spec: session/rebind-procedure-revision

## Purpose

Establish a uniform continuation procedure across every event that breaks or affects chain identity in opencode, so the AI is always told when its server-side reasoning chain reset and is given the affordances (commitment digest, recall) needed to recover behaviour without re-doing committed actions.

## Requirements

### Requirement: Continuation classifier dispatches every chain-affecting event

`Continuation.run(event)` MUST be the single entry point for handling any `ContinuationEvent`. The classifier MUST return a `ContinuationDecision` based on `(event.kind, providerClass)` per the canonical matrix in design.md. Every existing `invalidateContinuationFamily` call site MUST be rewired to dispatch through `Continuation.run`; direct calls to `invalidateContinuationFamily` are removed except inside the executor itself.

#### Scenario: Account switch on codex session

- **GIVEN** session `S` with `providerId="codex"`, previous account `A1`, current account `A2`
- **WHEN** `Continuation.run({ kind: "account_switch", sessionID: S, previousAccountId: A1, accountId: A2, providerId: "codex" })` is invoked
- **THEN** the classifier returns `{ breaksChain: true, capturesDigest: true, recomputesChainStable: true, injectsChainInit: true, injectsAmnesia: false, bumpsRebindEpoch: true }`
- **AND** `captureDigest(S)` runs before `invalidateContinuationFamily(S)`
- **AND** `markPendingInjection(S, { chainInit: true, digest, reason: "account_switch" })` writes the pending marker
- **AND** `RebindEpoch.bumpEpoch({ sessionID: S, trigger: "account_switch" })` fires
- **AND** `session.rebind` event payload includes `chainBreakClass: "SS-break"`
- **AND** `chain.init.injected` runtime event is appended with `digestEntryCount` and `bodyCharCount`

#### Scenario: Account switch on anthropic session (SL provider)

- **GIVEN** session `S` with `providerId="anthropic"`, previous account `A1`, current account `A2`
- **WHEN** `Continuation.run({ kind: "account_switch", sessionID: S, previousAccountId: A1, accountId: A2, providerId: "anthropic" })` is invoked
- **THEN** the classifier returns `{ breaksChain: false, capturesDigest: false, recomputesChainStable: false, injectsChainInit: false, injectsAmnesia: false, bumpsRebindEpoch: true }`
- **AND** `invalidateContinuationFamily` is NOT called (no chain to break)
- **AND** no chain-init notice is injected
- **AND** `RebindEpoch.bumpEpoch` still fires (for capability layer refresh)
- **AND** `session.rebind` payload includes `chainBreakClass: "SL-noop"`

#### Scenario: User /clear suppresses chain-init notice

- **GIVEN** any session `S`
- **WHEN** `Continuation.run({ kind: "user_clear", sessionID: S })` is invoked
- **THEN** the classifier returns `{ breaksChain: true, capturesDigest: false, injectsChainInit: false, injectsAmnesia: false, bumpsRebindEpoch: true }`
- **AND** chain is invalidated for SS providers (so the new chain starts fresh as user intended)
- **AND** no chain-init notice is injected (DD-9: don't second-guess user-aware reset)
- **AND** `chain.init.skipped` runtime event fires with `reason: "user_clear"`

### Requirement: Commitment digest captured before invalidation

When `decision.capturesDigest === true`, `captureDigest(sessionID)` MUST run AND complete (or fail with sentinel) BEFORE `invalidateContinuationFamily` is invoked. Digest entries MUST be limited to mutation-class tools per DD-2.

#### Scenario: Digest captures last 5 apply_patch + bash-with-write calls

- **GIVEN** session `S` has 50 messages; last 8 mutation-class tool calls visible (3× apply_patch, 2× bash-with-write, 2× read, 1× edit)
- **AND** `Continuation.run({ kind: "account_switch", sessionID: S, ... })` dispatches with `decision.capturesDigest=true`
- **WHEN** `captureDigest(S)` runs
- **THEN** the returned digest contains exactly 5 entries, in chronological order: edit + 2× bash-with-write + 3× apply_patch trimmed to the most recent 5
- **AND** `read` tool calls are excluded (DD-2: mutation-class only)
- **AND** each entry's `args_brief` is ≤ 80 chars and `output_summary` is ≤ 60 chars (truncated with ellipsis)
- **AND** total digest body is ≤ 1000 chars
- **AND** the digest is persisted to `session.execution.recentBreakDigest` synchronously
- **AND** only after the persist resolves does `invalidateContinuationFamily(S)` get called (DD-8 ordering invariant)

#### Scenario: Digest capture failure yields sentinel

- **GIVEN** session `S` where `MessageV2.stream` throws an I/O error at capture time
- **WHEN** `captureDigest(S)` is called
- **THEN** the error is caught and the function returns `null`
- **AND** `Continuation.run` proceeds with invalidation regardless (does not abort the procedure)
- **AND** the subsequent chain-init notice body includes the sentinel marker `<commitment_digest_unavailable>` instead of digest entries

### Requirement: Chain-init notice fragment injection

When `markPendingInjection` has set `chainInit: true` for the session, the next outbound prompt build MUST render `chain_init_notice` as a user-role fragment with `<chain_init_notice>...</chain_init_notice>` markers, then clear the pending marker.

#### Scenario: Chain-init notice contains commitment digest

- **GIVEN** session `S` has `pendingContinuationInjection = { chainInit: true, digest: [3 entries], reason: "account_switch", ts: T }`
- **WHEN** the prompt builder runs for the next outbound
- **THEN** the prompt contains a user-role fragment opened with `<chain_init_notice>`
- **AND** the body names the reason ("account_switch")
- **AND** the body contains a "Recent committed actions" section listing the 3 digest entries
- **AND** the body mentions the `recall(tool_call_id)` affordance
- **AND** the closing marker `</chain_init_notice>` is present
- **AND** after dispatch, `pendingContinuationInjection` is cleared (once-after-chain-break policy)

#### Scenario: Subagent spawn skips injection

- **GIVEN** a parent session creates a child subagent via `Continuation.run({ kind: "subagent_spawn", ... })`
- **WHEN** the subagent's first prompt is built
- **THEN** no `chain_init_notice` fragment is present (DD-9: subagent has no prior chain to mourn)
- **AND** a `chain.init.skipped` event was emitted at run-time with `reason: "subagent_spawn"`

### Requirement: Fragment cache policy split

The fragment registry MUST recognise four policy values: `always_on`, `conversation_stable`, `chain_stable` (NEW), `once_after_chain_break` (NEW). The `session_stable` enum value is removed; every existing consumer MUST be explicitly reclassified.

#### Scenario: bundle_user retags chain_stable

- **GIVEN** the fragment registry post-migration
- **THEN** `bundle_user` (containing `agents_md`, `amnesia_notice`, `environment_context`) is tagged `chain_stable`
- **AND** when `RebindEpoch.bumpEpoch` fires with `chainBreakClass != "preserved"`, the next prompt build recomputes `bundle_user` even if the conversation is otherwise unchanged
- **AND** static system block (`system_block_0`) is tagged `conversation_stable`
- **AND** static system block does NOT recompute on rebind epoch bump (unchanged)

#### Scenario: Unannotated fragment raises error

- **GIVEN** a hypothetical new fragment added without an explicit policy annotation
- **WHEN** the fragment registry is loaded at startup
- **THEN** startup fails with an explicit error naming the unannotated fragment (DD-7: no silent default)

### Requirement: Telemetry surface

`Continuation.run` MUST emit telemetry per design.md §"Telemetry contract". Every `invalidateContinuationFamily` invocation has a matching `chain.init.*` event in the same session's runtime-event journal within 100ms.

#### Scenario: chain.init.injected event payload

- **GIVEN** `Continuation.run({ kind: "empty_response_recovery", sessionID: S, emptyRoundCount: 1 })` runs against a codex session
- **WHEN** the procedure completes
- **THEN** one `chain.init.injected` event is appended with payload `{ sessionID: S, eventKind: "empty_response_recovery", digestEntryCount: <N>, bodyCharCount: <M>, reason: "empty_response_recovery" }`
- **AND** the `session.rebind` event payload (already existing) gains `chainBreakClass: "SS-break"`

### Requirement: Backward compatibility for in-flight sessions

The migration MUST NOT break sessions that exist before the rollout. The procedure MUST function correctly when `session.execution.recentBreakDigest` and `session.execution.pendingContinuationInjection` are undefined on legacy session records.

#### Scenario: Legacy session encounters first chain break post-deploy

- **GIVEN** session `S` was created before the rollout; `session.execution` lacks the new fields
- **WHEN** `Continuation.run` is called for the first time on `S`
- **THEN** undefined fields are treated as empty (no digest, no pending injection)
- **AND** the procedure executes normally from that point forward
- **AND** the next chain break captures digest correctly because `session.execution.recentBreakDigest` is initialised during capture

## Acceptance Checks

A1. Every existing call to `invalidateContinuationFamily` in `packages/opencode/src/session/` has been removed; the only remaining direct call is inside `continuation/run.ts`. Verified by grep regression test.

A2. The classifier matrix in design.md is realised in `continuation-event.ts` with one unit test per filled cell. Test count ≥ 30. All passing.

A3. `chain_init_notice` fragment renders for at least one happy-path scenario per must-break event kind (account_switch, account_rotate, provider_switch, model_switch_*, session_resume_after_daemon_restart, empty_response_recovery, backend_failure_forced_resend). Verified by golden-file fragment body tests.

A4. `amnesia_notice` fragment body, when invoked with a non-empty digest, includes the commitment-digest section. When invoked without digest, the existing body shape is preserved (regression). All 38 existing recall-affordance tests continue to pass.

A5. Subagent spawn and user-clear paths emit `chain.init.skipped` with the correct `reason`; no `chain_init_notice` fragment is rendered for those sessions. Verified by integration test.

A6. Provider chain-semantics registry contains an explicit entry for every providerId that appears in `provider/models.ts`; missing classification fails CI. Verified by static-analysis test.

A7. Fragment registry has no entries with policy `session_stable`; every fragment is explicitly tagged with one of {`always_on`, `conversation_stable`, `chain_stable`, `once_after_chain_break`, `session_stable_until_next_anchor`}. Verified by registry-loading test.

A8. `session.rebind` event payload in production telemetry includes `chainBreakClass` for ≥ 99% of emissions within 24 hours of rollout. Verified by telemetry dashboard.

A9. End-to-end regression: replaying the inputs from session `ses_1e56ed3f9ffebv4AaWOlcPLz20` against the new procedure does NOT reproduce the 11-round read-loop. Verified by recorded-session fixture test.

A10. Cache miss telemetry on chain reset does not exceed 15k tokens per reset on `bundle_user` (the chain_stable retag). Verified by token-accounting test on representative sessions.

## Out-of-band requirements (referenced from design.md)

- DD-1 — sibling fragments, not unified
- DD-2 — mutation-class tools only
- DD-3 — provider-format-agnostic notice body
- DD-4 — same-family model switch defaults to break
- DD-5 — backend-failure forced re-send classified as break + init
- DD-6 — copilot is SS class
- DD-7 — no silent default in policy classification
- DD-8 — digest captured before invalidation
- DD-9 — subagent + user-clear suppress notice
- DD-10 — empty-response recovery: keep invalidation + add notice
- DD-11 — provider class registry uses static typing
- DD-12 — capability-layer refresh suppresses chain-init, future capability-changed-notice
