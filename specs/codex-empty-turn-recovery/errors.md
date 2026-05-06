# Errors: codex-empty-turn-recovery

This spec deliberately **does not raise exceptions** for empty-turn conditions (Decision D-1: empty turn is never a hard blocker). The "errors" catalogued here are operator-visible breadcrumbs, log-channel signals, and structured warnings — never thrown exceptions that propagate out of the codex provider.

## Error Catalogue

### CET-001 — Log emission to JSONL failed

| Field | Value |
|---|---|
| Code | `CET-001` |
| Message (operator-visible) | `[CODEX-EMPTY-TURN] log emission failed: <ENOSPC \| EACCES \| EBADF \| ...>` |
| Where | `console.error` from [empty-turn-log.ts](../../packages/opencode-codex-provider/src/empty-turn-log.ts) |
| When | Append to `<XDG_STATE_HOME>/opencode/codex/empty-turns.jsonl` throws |
| Recovery | Swallowed; classifier proceeds with recovery action as if log succeeded (per spec.md `Forensic evidence preservation` § Scenario 3) |
| Operator action | Investigate disk space / permissions on XDG state path; the empty-turn that triggered this is now lost from the JSONL evidence trail (the bus event mirror, if subscribed, may still have it) |
| Severity | Medium — degrades evidence preservation but does NOT block CMS |

### CET-002 — Bus publish on `codex.emptyTurn` failed

| Field | Value |
|---|---|
| Code | `CET-002` |
| Message | (none — silent per DD-2; bus is non-load-bearing) |
| Where | [empty-turn-log.ts](../../packages/opencode-codex-provider/src/empty-turn-log.ts) bus publish path |
| When | `Bus.publish("codex.emptyTurn", ...)` throws or the bus is uninitialized |
| Recovery | Silently ignored. JSONL append (the load-bearing path) is independent and runs first |
| Operator action | None — bus is convenience; absence of bus events with JSONL entries present is expected during early process startup or in environments where Bus isn't wired |
| Severity | Low — by design |

### CET-003 — Classifier returned unrecognized recovery action

| Field | Value |
|---|---|
| Code | `CET-003` |
| Message | `[CODEX-EMPTY-TURN] classifier returned unrecognized recoveryAction "<value>"; falling back to pass-through-to-runloop-nudge` |
| Where | `log.warn` from sse.ts flush block OR transport-ws.ts onclose handler (whichever invoked classifier) |
| When | Defensive guard: if classifier somehow returns an action outside the four-value enum (impossible if enum-checked at compile time, but defensive at runtime in case of refactor regression) |
| Recovery | Force `recoveryAction = "pass-through-to-runloop-nudge"`; emit log entry with original (invalid) value preserved in `streamStateSnapshot` for post-hoc audit |
| Operator action | Code regression — file a bug citing the log entry. Should never occur in well-formed code |
| Severity | Medium — masks a code bug but maintains the no-hard-error invariant |

### CET-004 — WS retry attempted but second attempt also empty (soft-fail)

| Field | Value |
|---|---|
| Code | `CET-004` |
| Message | (no console output; encoded in log entry) |
| Where | Log entry's `retryAttempted: true, retryAlsoEmpty: true, previousLogSequence: <N>` fields |
| When | `recoveryAction === "retry-once-then-soft-fail"` selected on first attempt; retry executed; second attempt also produced empty turn |
| Recovery | Soft-fail: emit finish part with classification metadata, runloop nudge fires per D-4. No third retry per DD-7 |
| Operator action | If a sustained cluster of these appears (≥ 5% of `ws_truncation` cause family), backend may be broadly degraded. Trigger SG-5 review per handoff.md |
| Severity | Low individual / Medium clustered — expected occasionally; sustained pattern indicates upstream issue |

### CET-005 — `unclassified` cause family observed

| Field | Value |
|---|---|
| Code | `CET-005` |
| Message | (no console output; encoded in log entry) |
| Where | Log entry's `causeFamily: "unclassified"` |
| When | Empty turn detected but no defined predicate matched |
| Recovery | `pass-through-to-runloop-nudge` with full `streamStateSnapshot` captured for forensic triage (per spec.md `Cause-family classification covers every empty turn` § Scenario 7) |
| Operator action | Aggregate `unclassified` log entries weekly. If a sustained pattern emerges, propose a new cause-family enum value via `extend` mode revision (per spec.md `Cause-family enum is finite and append-only`) |
| Severity | Low individual / Medium clustered — `unclassified` is the spec's residue bucket and IS expected to be non-empty initially |

### CET-006 — Server reported `output: []` with reasoning params (D-3 audit signal)

| Field | Value |
|---|---|
| Code | `CET-006` |
| Message | (no console output; encoded in log entry) |
| Where | Log entry's `causeFamily: "server_empty_output_with_reasoning", suspectParams: ["reasoning.effort", ...]` |
| When | Codex backend returned `response.completed { output: [] }` AND request body had `reasoning.effort` or `include: ["reasoning.encrypted_content"]` |
| Recovery | `pass-through-to-runloop-nudge` |
| Operator action | This is the explicit D-3 audit signal. When the cluster reaches the threshold (≥ 5% per spec.md `Audit-before-omit` Requirement), trigger `extend` mode revision to add codex-subscription parameter omission. Do NOT pre-emptively strip the params — D-3 mandates audit first |
| Severity | Variable — informational at low rate, action-required at threshold |

## Excluded categories

The following error categories are **deliberately not in this catalogue** because they are not in scope for this spec:

- AI SDK `controller.error()` calls — never invoked from the empty-turn pipeline. Any code change that adds a `controller.error()` call from this surface violates D-1 and SG-2
- Thrown `Error` instances from sse.ts flush or transport-ws.ts onclose — never. The classifier always returns a recovery action; the call site always proceeds
- HTTP-status-code-style error codes — not applicable; this surface produces JSONL log entries, not HTTP responses
- Codex backend error messages — captured verbatim in `serverErrorMessage` log field for `server_failed` / `server_incomplete` causes, but not catalogued here as separate codes (codex defines them, not us)
