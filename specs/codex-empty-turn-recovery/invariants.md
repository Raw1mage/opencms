# Invariants: codex-empty-turn-recovery

Cross-cut guarantees that hold across multiple components, states, and lifecycle phases. Unlike per-Requirement contracts in `spec.md` (which scope to one scenario), invariants must hold **for every input, every code path, every refactor**. They are the load-bearing properties of this spec — if any invariant breaks, the spec's Decisions are violated even if individual Requirements still pass.

Each invariant is structured: **Statement / Why / Enforcement / Violation detection**. The Enforcement section names the concrete code, config, schema, or test artifact responsible. The Violation detection section names how a regression would be caught.

Format note: invariant IDs are `INV-NN`; ordering is by category, not chronology. New invariants append; existing ones never get renumbered (mirrors the cause-family enum's append-only rule).

---

## Category A — Non-blocking recovery (anchors Decision D-1)

### INV-01 — Empty turn never throws an exception out of the codex provider

**Statement**: For every assistant turn that lands as effectively empty (no text-delta or tool-call emitted), no exception, error, or rejected promise propagates from `packages/opencode-codex-provider/` to the AI SDK runloop. The provider always returns a well-formed `LanguageModelV2StreamPart` finish part.

**Why**: Decision D-1 mandates max fault tolerance. CMS must continue working. An exception escaping the provider would stall the runloop, which is the very behavior this spec exists to eliminate.

**Enforcement**:
- [spec.md](spec.md) Requirement `Hard-error is never emitted for empty turns` § Scenarios 1-2
- [handoff.md](handoff.md) Stop Gate SG-10 (no third retry, ever)
- [errors.md](errors.md) Excluded categories section (no `controller.error()`, no thrown `Error` from this surface)
- [test-vectors.json](test-vectors.json) `TV-INVARIANT-no-hard-error-ever` — invariant test that runs all 11 acceptance vectors and asserts zero exceptions
- Recovery-action enum in [data-schema.json](data-schema.json) excludes `hard-error` by enumeration

**Violation detection**:
- Unit test `TV-INVARIANT-no-hard-error-ever` fails if any vector throws
- Code review must reject any new `throw`, `controller.error()`, or `Promise.reject()` originating in the empty-turn pipeline (handoff.md SG-2 caps scope to Critical Files; SG-10 caps recovery cap)
- Smoke test acceptance check A6: 24h soak with classifier active; any exception escape fails A6

---

### INV-02 — Recovery action vocabulary is closed and excludes `hard-error`

**Statement**: The set of permissible recovery actions is exactly `{retry-once-then-soft-fail, synthesize-from-deltas, pass-through-to-runloop-nudge, log-and-continue}`. No code path may produce, accept, or document any other value, and `hard-error` is permanently excluded.

**Why**: Reinforces INV-01 at the type level. Even if a future contributor wanted to add a new action, they cannot quietly introduce `hard-error` because it would fail schema validation at the log layer.

**Enforcement**:
- [data-schema.json](data-schema.json) `recoveryAction.enum` array
- [design.md](design.md) DD-10
- [spec.md](spec.md) Requirement `Recovery action enum is finite and excludes hard-error` § Scenario 1
- Errors catalogue [errors.md](errors.md) CET-003 — defensive guard handles unrecognized action by forcing `pass-through-to-runloop-nudge`

**Violation detection**:
- Schema validation rejects log entries containing unknown enum values
- CET-003 console.error breadcrumb fires at runtime if classifier ever returns an unknown action — visible in opencode runtime logs
- Adding a new action requires `extend` mode revision touching both `data-schema.json` and `design.md`; reviewer catches `hard-error` if anyone tries to slip it in

---

### INV-03 — Runloop "?" nudge stays broad; classifier outcomes never narrow it

**Statement**: The runloop empty-response guard fires the `?` nudge under exactly the same trigger conditions before and after this spec's implementation. Classifier metadata may be **attached** to the synthetic message; it must never be **read** to suppress, gate, or narrow the nudge dispatch.

**Why**: Decision D-4 explicitly overrode the earlier proposal to narrow nudge scope, on grounds that nudge IS the fault-tolerance mechanism. Narrowing it under any pretext would partially undo D-1.

**Enforcement**:
- [proposal.md](proposal.md) Decision D-4 (with the "overrides earlier proposal suggestion" annotation preserved)
- [spec.md](spec.md) Requirement `Runloop nudge remains broad` § Scenario 1
- [design.md](design.md) DD-11 (`emptyTurnClassification` is a metadata attachment, not a control input)
- [c4.json](c4.json) C7 description ("UNCHANGED in scope (D-4 keeps it broad)")

**Violation detection**:
- Test `TV-A7-nudge-receives-classification-metadata` asserts nudge fires AND carries metadata
- Acceptance check A7 in spec.md
- Code review on any change to `packages/opencode/src/session/` that touches the empty-response guard must verify trigger conditions are not narrowed; cite this invariant

---

## Category B — Evidence preservation (anchors Decision D-2)

### INV-04 — Every classified empty turn produces a JSONL log entry attempt

**Statement**: For every empty turn classified by `classifyEmptyTurn()`, exactly one append to `<XDG_STATE_HOME>/opencode/codex/empty-turns.jsonl` is **attempted** before the recovery action is dispatched. This holds regardless of cause family, recovery action, or whether the entry is `unclassified`.

**Why**: D-2 makes evidence preservation the load-bearing path. Recovery is subordinate to logging. If any cause-family branch could skip the log attempt, the audit signal (M5 in observability.md, SG-7 in handoff.md) becomes unreliable.

**Enforcement**:
- [spec.md](spec.md) Requirement `Forensic evidence preservation` § Scenarios 1-2
- [design.md](design.md) DD-12 Phase 1 (logging ships first, classification second, retry third — explicitly because logging is the load-bearing path)
- [tasks.md](tasks.md) §1 (Phase 1 ship gate cannot pass without log emission working in every empty-turn path)
- [sequence.json](sequence.json) flows P1, P2 — log emission step always precedes recovery dispatch step

**Violation detection**:
- Test `TV-A4-log-failure-resilience` proves the attempt happens even when the underlying write fails
- Test `TV-A3-successful-turn-no-empty-log` proves the inverse — non-empty turns do NOT attempt
- Schema-drift test (Phase 2 task 2.9) ensures log schema stays compatible with attempts from every cause-family branch

---

### INV-05 — Log emission failure never blocks recovery

**Statement**: When `appendEmptyTurnLog()` fails (disk full, permission denied, file handle exhausted, bus throws, etc.), the failure is swallowed: a single `console.error` breadcrumb (CET-001) is emitted, and the calling code path proceeds with the recovery action exactly as if logging had succeeded.

**Why**: Composition of D-1 and D-2. Logging is the load-bearing evidence path, but D-1 mandates non-blocking. So the only safe failure mode is: log attempt → swallow → continue. This is the exact same shape as INV-01 applied to the logger.

**Enforcement**:
- [spec.md](spec.md) Requirement `Forensic evidence preservation` § Scenario 3
- [errors.md](errors.md) CET-001 (severity Medium — degrades evidence but does NOT block)
- [tasks.md](tasks.md) task 1.3 (explicit log-failure resilience implementation)
- [sequence.json](sequence.json) flow P4 (resilience scenario)

**Violation detection**:
- Test `TV-A4-log-failure-resilience` simulates ENOSPC and asserts no exception, recovery proceeds
- Acceptance check A4

---

### INV-06 — JSONL is load-bearing; bus is convenience

**Statement**: The `<XDG_STATE_HOME>/opencode/codex/empty-turns.jsonl` file is the authoritative evidence record. The `Bus.publish("codex.emptyTurn", ...)` event mirrors the same payload but is non-load-bearing: subscribers may be absent, may drop messages, or may not exist at all. **No code, test, dashboard, or operator process may treat the bus as authoritative**.

**Why**: D-2 specifies evidence preservation as a durable property. Bus events are volatile (no consumer → message lost). Treating bus as authoritative would create silent gaps when the subscriber is down or unwired.

**Enforcement**:
- [design.md](design.md) DD-2 (explicit "load-bearing JSONL" + "non-load-bearing bus" labels)
- [observability.md](observability.md) opening overview, Bus event table, Log file table — both label the layers explicitly
- [errors.md](errors.md) CET-002 (bus failure is severity Low — by design)
- [c4.json](c4.json) C8 description ("load-bearing evidence path"), C9 description ("non-load-bearing convenience")

**Violation detection**:
- Code review on any new bus subscriber must confirm it does not assume guaranteed delivery; if it needs guaranteed delivery, it must also tail the JSONL
- Documentation review: any operator runbook that says "watch the bus event" must also say "or tail the JSONL" — JSONL is the source of truth

---

### INV-07 — Log entry shape is schema-valid for every emission

**Statement**: Every line written to `empty-turns.jsonl` validates against `data-schema.json` (`schemaVersion: 1`). No malformed entries, no missing required fields, no enum drift between code and schema.

**Why**: Forensic value of the log depends on every entry being machine-parseable. A single malformed line breaks downstream metrics derivation (M1-M7) and audit queries.

**Enforcement**:
- [data-schema.json](data-schema.json) JSON Schema with `additionalProperties: false` and explicit `required` arrays
- [tasks.md](tasks.md) task 2.9 (schema-drift unit test asserting code enum matches schema enum)
- [observability.md](observability.md) operator quick-check command using `jq -e` to assert validity

**Violation detection**:
- Phase 2 task 2.9 schema-drift test fails on any code/schema mismatch
- Operator periodic `jq -e '.causeFamily'` over the file surfaces malformed lines as parse errors
- CI runs the schema-drift test on every change

---

## Category C — Retry safety (anchors DD-7 + SG-10)

### INV-08 — Retry count is hard-capped at 1 attempt

**Statement**: Across the entire codex provider package, no code path may dispatch a retry of an empty-turn-classified WS request more than once. `state.retryCount` is initialized to 0, incremented to 1 on the single allowed retry, and a value ≥ 1 is the absorbing barrier — no further retry, ever, regardless of context, cause family, or "this one would obviously succeed" reasoning.

**Why**: Risk R3 (retry doubles load on degraded backend). Without a hard cap, a degraded codex backend would face N×amplified bad traffic, making the symptom worse for everyone.

**Enforcement**:
- [design.md](design.md) DD-7 ("caps firmly at 1 (no exponential, no second retry)")
- [handoff.md](handoff.md) SG-10 ("DD-7 cap is non-negotiable")
- [tasks.md](tasks.md) task 3.3 ("cap firmly at 1 (no exponential, no second retry)")
- [grafcet.json](grafcet.json) Step 4's outgoing condition `recoveryAction == retry-once-then-soft-fail AND retryAttempted == false` — `retryAttempted == false` is the gate that prevents a second retry

**Violation detection**:
- Test `TV-A1-ws-truncation-retry-also-empty` proves second attempt selects `pass-through-to-runloop-nudge`, not retry
- Code review on any change to retry dispatch must verify the `retryCount === 0` gate is intact
- SG-10 stop gate trips if any executor proposes "just one more retry"

---

### INV-09 — Retry is invisible to the SSE consumer

**Statement**: When retry-once-then-soft-fail dispatches a retry, the SSE pipeline (and downstream AI SDK) sees only the second attempt's frames as a normal stream. The first attempt's partial frames are not replayed, not concatenated, and not surfaced. The retry happens entirely at the WS transport layer.

**Why**: Mixing first-attempt fragments with second-attempt content would corrupt downstream parsing. Per DD-7, retry semantics are: re-execute the same body, replace the bad attempt entirely. Not splice.

**Enforcement**:
- [design.md](design.md) DD-7 ("Retry happens transparently to the SSE layer — the SSE pipeline sees only the second attempt's frames")
- [c4.json](c4.json) C6 (retry-dispatcher) is inside CT1 (codex provider), specifically at WS layer; not at SSE layer
- [sequence.json](sequence.json) flow P1 messages MSG10-MSG12 (attempt 2 starts a fresh frame stream)

**Violation detection**:
- Test `TV-A1-ws-truncation-retry-also-empty` asserts second attempt's `responseId` differs from first; mixed frames would surface as `responseId` collision
- Integration test would catch text-delta accumulation across attempts (counter not reset → false positive on `emittedTextDeltas > 0` check)

---

## Category D — Classifier correctness

### INV-10 — Any turn with content emitted is never classified as empty

**Statement**: When `state.emittedTextDeltas > 0 OR state.emittedToolCalls.size > 0` at flush time, the classifier MUST NOT be invoked, no log entry MUST be emitted, no `emptyTurnClassification` providerMetadata MUST be attached.

**Why**: Risk R2 (false positive on real-but-truncated responses). A turn that produced any output to the user is not empty by definition; tagging it as `ws_truncation` and retrying would produce duplicate user-visible output and waste codex quota.

**Enforcement**:
- [spec.md](spec.md) Requirement `Cause-family classification covers every empty turn` § Scenario 4 (deltas observed → MUST NOT classify as empty)
- [design.md](design.md) Risk R2 mitigation
- [grafcet.json](grafcet.json) Step 1's outgoing divergence: condition for empty path explicitly requires `emittedTextDeltas == 0 AND emittedToolCalls == 0`
- [tasks.md](tasks.md) task 1.4 (counter increment on every delta event)

**Violation detection**:
- Test `TV-A3-successful-turn-no-empty-log` proves successful streams emit no log
- Acceptance check A3
- Operator-side: M1 metric should never spike on healthy codex traffic; if it does, R2 false-positive likely

---

### INV-11 — `suspectParams` truthfully reflects request body

**Statement**: When `causeFamily === "server_empty_output_with_reasoning"`, the `suspectParams` array contains exactly the parameter names that were actually present in the request body (a subset of `["reasoning.effort", "include.reasoning.encrypted_content"]`). Never empty for this cause family, never contains parameters that weren't sent.

**Why**: D-3 audit decision relies on suspectParams to identify which parameter to omit when the cluster reaches threshold. False positives here would trigger an unnecessary `extend` mode revision; false negatives would let the actual culprit hide.

**Enforcement**:
- [spec.md](spec.md) Requirement `Audit-before-omit for OpenHands B/C parameters` § Scenario 1
- [design.md](design.md) DD-9 row for `server_empty_output_with_reasoning` (selection condition explicitly references the same params)
- [tasks.md](tasks.md) task 2.3 (predicate populates suspectParams with matched param names)
- [observability.md](observability.md) M5 + M7 metrics use suspectParams as the audit signal

**Violation detection**:
- Test `TV-A2-server-empty-output-with-reasoning` asserts suspectParams contains both `reasoning.effort` and `include.reasoning.encrypted_content` when both were sent
- Test `TV-A5-unclassified` asserts suspectParams is empty when neither was sent (proves no false positives)

---

### INV-12 — Classifier is a pure function

**Statement**: `classifyEmptyTurn(snapshot)` performs no I/O, depends on no global state beyond the immutable enum constants, and returns the same output for the same input. All side effects (log emission, retry dispatch, finish-part construction) happen at the call site, not inside the classifier.

**Why**: Pure-function discipline (DD-1) makes the classifier unit-testable in isolation, makes its behavior reproducible from log entries (replay capability), and prevents future contributors from sneaking observability or retry logic inside the classifier where it would be hidden from review.

**Enforcement**:
- [design.md](design.md) DD-1 (pure function explicitly named, located in its own file)
- [c4.json](c4.json) C4 description ("pure function")
- [tasks.md](tasks.md) task 1.6 (creates classifier as pure function)
- Test convention: `empty-turn-classifier.test.ts` runs without any mock setup beyond constructing the snapshot input

**Violation detection**:
- Adding any I/O import (`fs`, `Bus`, `Log`, etc.) inside `empty-turn-classifier.ts` is caught at code review (cite this invariant)
- Determinism test: run the same vector 100 times, assert identical output

---

## Category E — Schema and enum stability

### INV-13 — `causeFamily` enum is append-only

**Statement**: Once a cause-family value is added to the enum and shipped to production, it MUST NOT be removed, renamed, or have its semantics changed. New values may only be appended via `extend` mode revision with a corresponding `schemaVersion` bump in `data-schema.json`.

**Why**: Existing production logs reference these values. Removing one breaks all downstream tooling that filters by cause family. Renaming creates ambiguity in time-series analysis. Repurposing a value silently corrupts historical data.

**Enforcement**:
- [spec.md](spec.md) Requirement `Cause-family enum is finite and append-only` § Scenario 1
- [data-schema.json](data-schema.json) `causeFamily.enum` array (schema version 1)
- [design.md](design.md) DD-9 (table is single source of truth; changes go through extend mode)
- [tasks.md](tasks.md) task 2.9 (schema-drift test enforces code↔schema alignment)

**Violation detection**:
- Schema-drift test catches any code-side enum change that isn't reflected in data-schema.json
- Removing a value from `data-schema.json` would invalidate historical log entries on next replay; reviewer catches via diff

---

### INV-14 — `recoveryAction` enum is closed (no append without explicit revision)

**Statement**: The recovery-action enum has exactly four values: `retry-once-then-soft-fail`, `synthesize-from-deltas`, `pass-through-to-runloop-nudge`, `log-and-continue`. Adding a fifth value requires an explicit `extend` mode revision touching `design.md` (DD-10) and `data-schema.json` simultaneously, and the new value MUST satisfy INV-01 (no-throw) and INV-04 (log-attempt-first).

**Why**: Expanding the action vocabulary is the highest-risk change to this spec because it's where future contributors might try to introduce blocking behavior. Forcing an explicit revision creates a review checkpoint.

**Enforcement**:
- [spec.md](spec.md) Requirement `Recovery action enum is finite and excludes hard-error` § Scenario 1
- [data-schema.json](data-schema.json) `recoveryAction.enum`
- [design.md](design.md) DD-10
- INV-01 + INV-04 referenced as preconditions in any future extend revision

**Violation detection**:
- Schema validation rejects unknown values
- Code review surfaces enum changes; reviewer must verify the new action satisfies INV-01 and INV-04 before approving

---

### INV-15 — Schema version monotonically increases

**Statement**: `data-schema.json` `schemaVersion` field starts at 1 and only ever increases. A given JSONL file may contain entries from multiple schema versions (operators may upgrade mid-rotation); readers must check the field per-line and apply version-appropriate parsing.

**Why**: Forward-compatibility for log readers. Operators rotating logs across opencode upgrades must be able to parse entries from older schemas. Decreasing or recycling version numbers breaks this.

**Enforcement**:
- [data-schema.json](data-schema.json) `schemaVersion: const 1` (literal const at v1; bump requires explicit edit)
- Future extend revisions changing the schema MUST bump `schemaVersion` and document the diff in design.md

**Violation detection**:
- Reviewer catches any schema edit that doesn't bump the version
- Operator-side: parsing tools should warn on unknown schema versions, never silently truncate

---

## Category F — Provider boundary discipline

### INV-16 — All classification logic stays inside `packages/opencode-codex-provider/`

**Statement**: The opencode runloop, session manager, and AI SDK adapter MUST NOT contain any code that knows about cause family values, recovery action values, or empty-turn-specific behavior beyond reading `providerMetadata.openai.emptyTurnClassification` as opaque metadata to attach to the synthetic nudge message.

**Why**: `feedback_provider_boundary.md` — provider-specific logic stays inside the provider. If runloop code starts switching on cause family, the abstraction leaks and adding future providers becomes harder. Keeps the codex provider a self-contained explanation of codex behavior.

**Enforcement**:
- [proposal.md](proposal.md) Constraint section (cites `feedback_provider_boundary.md`)
- [design.md](design.md) Goals section ("Implementation is contained inside `packages/opencode-codex-provider/`; runloop changes are minimal (metadata pass-through only)")
- [c4.json](c4.json) Component C7 (runloop guard) marked UNCHANGED in scope
- [handoff.md](handoff.md) Stop Gate SG-2 (any change touching files outside Critical Files list is scope creep)

**Violation detection**:
- Code review: any new file under `packages/opencode/src/session/` that imports from `packages/opencode-codex-provider/` for cause-family logic violates this; surface via SG-2
- A grep for `causeFamily` outside the provider package should match only the runloop's metadata-attachment site, not any decision-making code

---

### INV-17 — Account-rotation amplifies but does not cause empty turns

**Statement**: Account rotation (multiple codex accounts handling turns within one session, as observed in `ses_204499...` with 11 accounts) is treated as an **amplifier** of empty-turn probability, not as a cause family. The classifier MUST NOT introduce an `account_rotation` cause family or use `accountId` as a discriminator. Account-rotation policy changes are tracked separately (proposal Risks).

**Why**: Conflating an amplifier with a cause would (a) create false attribution in logs, and (b) tempt the classifier into special-casing account behavior, violating INV-16. The right tool to evaluate rotation effects is metric M6 (`accountId` distribution in logs), not a cause family.

**Enforcement**:
- [proposal.md](proposal.md) "External References" table notes account rotation is an amplifier; Scope OUT explicitly excludes account rotation policy
- [design.md](design.md) Risk R6 (out-of-scope; logged for cross-correlation only)
- [observability.md](observability.md) M6 metric (accountId distribution) as the analysis tool
- [data-schema.json](data-schema.json) `accountId` is a logged field, not an enum-discriminated cause input

**Violation detection**:
- Adding `accountId` to the classifier predicate is caught at code review
- Adding an `account_rotation` value to the cause-family enum requires explicit extend revision; reviewer cites this invariant

---

## Invariant maintenance

When extending this spec via `amend` / `revise` / `extend` / `refactor` modes:

1. **Re-read this file first**. Every invariant survives intact unless the revision explicitly proposes to change it.
2. **Cite the invariant ID** in the revision's design.md Decisions section if any invariant is loosened, tightened, or replaced. Use the inline-delta marker convention from plan-builder §6.
3. **Never silently retire an invariant**. If a Decision supersedes one, mark the invariant `[SUPERSEDED by DD-N, YYYY-MM-DD]` rather than deleting it.
4. **New invariants append**. New ID, new section, append-only — same rule as the cause-family enum.

A revision that breaks an invariant without acknowledgment is automatically a candidate for `refactor` mode (architecture-level change), not `amend`.
