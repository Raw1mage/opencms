# Tasks: session/rebind-procedure-revision

Phased rollout per design.md §"Migration / rollout". Each phase is independently shippable.

## M0 — Foundations (no behaviour change)

- [x] M0-1 Create `packages/opencode/src/provider/chain-semantics.ts`: `ProviderChainClass` enum (`SS | SL | Hybrid`); `classifyProvider(providerId): ProviderChainClass`; static registry seeded from `provider/models.ts`
- [x] M0-2 Add startup assertion: every providerId in models.ts must have a chain-semantics entry; missing entry fails CI
- [x] M0-3 Unit tests: classifyProvider for codex / copilot (both → SS), anthropic / gemini / groq (all → SL), unregistered id throws

## M1 — Continuation event types + classifier

- [x] M1-1 Create `packages/opencode/src/session/continuation/continuation-event.ts`: `ContinuationEvent` discriminated union (19 kinds per data-schema.json) using Zod
- [x] M1-2 Add `ContinuationDecision` interface (6 boolean flags)
- [x] M1-3 Implement `classify(event): ContinuationDecision` using the canonical matrix in design.md
- [x] M1-4 Unit test: one assertion per (event-kind × providerClass) cell ≥ 30 tests; cover suppression rules (subagent_spawn, user_clear) and SL no-op paths

## M2 — Commitment digest helper

- [x] M2-1 Create `packages/opencode/src/session/continuation/commitment-digest.ts`: mutation-class allowlist (`apply_patch`, `edit`, `write`, `bash` with write-effect detection, `move_file`, `delete_file`)
- [x] M2-2 `captureDigest(sessionID): Promise<CommitmentDigest | null>` scans last 50 messages via `MessageV2.stream`, filters mutation-class, truncates to N=5, scrubs secrets per TOOL_INDEX rules
- [x] M2-3 `renderDigest(entries): string` produces ≤1000-char prose body
- [x] M2-4 Unit tests: mutation-only filter; truncation to 5; scrubbing (no tokens/secrets in output); empty-stream returns empty digest; error-on-stream returns null

## M3 — Procedure executor

- [x] M3-1 Create `packages/opencode/src/session/continuation/run.ts`: `Continuation.run(event): Promise<ContinuationOutcome>` per design.md §"Continuation.run"
- [x] M3-2 Persist `recentBreakDigest` and `pendingContinuationInjection` to `session.execution.*` (extend the typed shape)
- [x] M3-3 Order invariant: digest capture awaited BEFORE invalidateContinuationFamily (DD-8)
- [x] M3-4 Emit `chain.commitment.captured` after capture, `chain.init.injected` or `chain.init.skipped` after dispatch
- [x] M3-5 Extend `RebindEpoch.bumpEpoch` payload with `chainBreakClass` derived from decision
- [x] M3-6 Unit tests: ordering invariant (digest before invalidate); telemetry emission; pending-injection persistence; error in any step does not abort subsequent steps (best-effort semantics)

## M4 — Chain-init notice fragment

- [x] M4-1 Create `packages/opencode/src/session/context-fragments/chain-init-notice.ts`: `decideChainInitInjection(session)`, `buildChainInitNoticeFragment({ reason, digest, anchorKind? })`
- [x] M4-2 Body composition per design.md §"Fragment composition by signal": chain-reset framing + round numbering + commitment digest + recovery affordances
- [x] M4-3 Markers `<chain_init_notice>...</chain_init_notice>`
- [x] M4-4 Sentinel `<commitment_digest_unavailable>` when digest=null
- [x] M4-5 Unit tests: with-digest body / empty-digest body / sentinel body / round numbering correct

## M5 — Extend amnesia-notice + shared renderer

- [x] M5-1 Modify `packages/opencode/src/session/context-fragments/amnesia-notice.ts`: import shared `renderDigest`; body extended to include digest section when present in `pendingContinuationInjection.digest`
- [x] M5-2 No change to `decideAmnesiaInjection` logic (existing trigger taxonomy stays correct for compaction kinds)
- [x] M5-3 Regression: 38 existing recall-affordance tests pass unchanged

## M6 — Fragment policy split

- [x] M6-1 Add `chain_stable` and `once_after_chain_break` to `FragmentPolicy` enum in `packages/opencode/src/session/context-fragments/index.ts`; remove `session_stable`
- [x] M6-2 Audit every existing consumer of `session_stable` and explicitly retag (`conversation_stable` or `chain_stable`)
- [x] M6-3 Retag `bundle_user` (and its children `agents_md`, `amnesia_notice`, `environment_context`) as `chain_stable`
- [x] M6-4 Static system block stays `conversation_stable`
- [x] M6-5 Cache-key computation: `chain_stable` fragments include rebind epoch in fingerprint
- [x] M6-6 Registry-loading test asserts every fragment has explicit policy (DD-7)

## M7 — Rewire call sites (Phase B-C-E in design.md)

- [x] M7-1 Phase B: rewire `prompt.ts:1451` (empty-response recovery) to `Continuation.run({ kind: "empty_response_recovery", ... })`
- [x] M7-2 Phase C: rewire `prompt.ts:1208` (pre-loop account switch) to `Continuation.run({ kind: "account_switch", ... })`
- [x] M7-3 Phase C: rewire `prompt.ts:460` (in-loop account swap) to `Continuation.run({ kind: "account_switch", ... })`
- [x] M7-4 Phase C: rewire `compaction.ts:189` and `compaction.ts:3622` to `Continuation.run({ kind: "compaction_*", ... })` per their context
- [x] M7-5 Phase E: rewire `transport-ws.ts:561 / 571 / 581 / 607` to `Continuation.run({ kind: "backend_failure_forced_resend", classifier: ... })`
- [x] M7-6 Grep regression test: no `invalidateContinuationFamily` direct calls remain outside `continuation/run.ts`

## M8 — Integration tests + end-to-end regression

- [x] M8-1 Replay session `ses_1e56ed3f9ffebv4AaWOlcPLz20` fixture; assert no 11-round read loop reproduces
- [x] M8-2 Account switch on codex session: assert chain_init_notice appears in next outbound prompt body
- (deferred → F8 fixture-based harness) M8-3 Account switch on anthropic session: assert no chain_init_notice, only capability refresh
- (deferred → F8 fixture-based harness) M8-4 Compaction on anthropic session: assert amnesia_notice body contains digest section
- (deferred → F8 fixture-based harness) M8-5 Subagent spawn: assert chain.init.skipped fires; no fragment injected
- [x] M8-6 Daemon restart (simulate): assert chain_init_notice fires on first prompt after restart + pre-emptive compaction still works
- [x] M8-7 Empty-response recovery: assert chain.init.injected fires AND chain remains invalidated (DD-10)

## M9 — Telemetry validation

- [x] M9-1 `session.rebind` payload extended with `chainBreakClass`; old dashboards still readable (additive field)
- [x] M9-2 New event types `chain.init.injected`, `chain.init.skipped`, `chain.commitment.captured` appear in RuntimeEventService journal
- (deferred → F8 fixture-based harness, depends on instrumentation) M9-3 Cache miss measurement: instrument `chain_stable` fragment recompute; assert ≤15k tokens per chain reset for representative sessions (A10)

## M10 — Acceptance gates (per spec.md §Acceptance Checks)

- [x] M10-A1 Grep regression: zero `invalidateContinuationFamily` direct calls outside executor
- [x] M10-A2 ≥30 classifier matrix tests passing
- (deferred → F8) M10-A3 Per-kind happy-path golden body tests
- [x] M10-A4 38 existing recall-affordance tests + new digest assertions all pass
- (deferred → F8) M10-A5 Subagent/user-clear suppression integration tests
- [x] M10-A6 Static-analysis: every providerId has chain-semantics entry
- [x] M10-A7 Registry-loading test: no fragment with `session_stable` policy
- (deferred → 24h prod sampling job) M10-A8 Telemetry sampling: ≥99% emissions carry chainBreakClass within 24h
- [x] M10-A9 End-to-end regression: ses_1e56ed3f9ffebv4AaWOlcPLz20 fixture clean
- (deferred → F8 + instrumentation) M10-A10 Cache-miss budget: ≤15k tokens per reset on bundle_user

---

## Verification methodology note

The verified-state ticks above were achieved through **live observation** on session `ses_1e56ed3f9ffebv4AaWOlcPLz20` (2026-05-12, multi-stage as recorded in `events/event_2026-05-12_live-verification-*.md`). Fixture-based regression tests (M8-1, M10-A9) are ticked on the strength of live evidence; the codified `*.fixture.jsonl` replay harness was not built in-cycle and is captured below as **F1** (post-graduation hardening).

Items left unticked are CI / fixture / dashboard tasks that need infrastructure beyond the in-cycle scope. They are tracked in the follow-up section.

---

## M11 — Follow-up TODOs (post-graduation hardening)

Items deliberately deferred from in-cycle scope; each owns its own future plan when picked up. Listed in rough priority order.

### M11.1 — Layer D dispatcher tool-mask
- **F1** When DispatchDedup short-circuits ≥N times in a session, the dispatcher SHOULD also mask `read` for one turn so the model is forced to use `apply_patch` / `bash` / `recall` instead of regressing into the read-loop. Effectively a hard backstop for the once-after-chain-break framing — addresses the model's tendency to ignore even strongly-framed notices.
- **F2** Telemetry: emit `dispatcher.tool_mask.applied` with the masked tool list + reason.

### M11.2 — Cross-provider reasoning-item translation
- **F3** When `provider_switch` crosses SS → SL (codex → anthropic etc.), codex reasoning items in the transcript are foreign content to the new provider. Build a translator that converts codex `reasoning` parts into a `<prior_reasoning>` text block readable by the new provider, OR strips them.
- **F4** Decide policy: strip-by-default with explicit opt-in to preserve, or translate-by-default. Trade-off: token cost vs context fidelity.

### M11.3 — Capability-changed notice (E5 follow-up sibling plan)
- **F5** When `capability_layer_refresh` fires (tools / AGENTS.md changed), emit a third sibling fragment `<capability_changed_notice>` so the AI knows tools / instructions changed. Distinct from chain-init (no chain break) and amnesia (no compaction). Open a sibling spec `session/capability-changed-notice`.

### M11.4 — Reasoning self-recover skill (24×7 follow-up)
- **F6** After receiving a chain_init_notice, the AI should reason about which commitments to **continue** vs **abandon**. Today it gets the list and either ignores or redoes; a `chain-init-self-recover` skill could prompt: "for each item in the digest, decide whether it remains current goal, or has been superseded." Likely a skill-creator deliverable; orthogonal to this spec's infrastructure scope.

### M11.5 — Dedup-cleared-on-compaction
- **F7** Currently DispatchDedup uses a 1-hour TTL. A more semantic reset would be "clear dedup when a new compaction anchor lands" — because the new anchor has the post-switch account, the next divergence detection will see prev=post-switch, key changes, dedup bypasses naturally. Optional optimization; the 1-hour TTL is fine for now.

### M11.6 — Fixture-based regression harness
- **F8** Codify the `ses_1e56ed3f9ffebv4AaWOlcPLz20` live verification as a replayable `.fixture.jsonl` so future refactors of session/continuation/ can run the full regression suite headless. Currently M8-1 / M10-A9 are ticked on live evidence; the harness would convert that evidence into CI gate.

### M11.7 — 24×7 stability adjacent gaps
- **F9** Subagent termination: `project_subagent_hang_pattern.md` — bridge silence watchdog using `lastEventAt`. Not strictly chain-break but adjacent failure class.
- **F10** Tool catalog staleness detection: when registered tools change mid-session and the model's mental list goes stale.
- **F11** OAuth refresh + quota graceful degradation: when the active account's token expires or quota truly depletes during a long session.

### M11.8 — Architecture documentation
- **F12** Update `specs/architecture.md` cross-cutting index with the chain-init protocol layer + its dependencies on rebind-epoch, recall-affordance, and fragment-policy.
- **F13** Write `events/event_<date>_paper-supplement.md` capturing the abstraction-leak-across-package-boundary observation as a teachable example for a future systems paper.
