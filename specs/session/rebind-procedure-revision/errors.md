# Errors: session/rebind-procedure-revision

Failure modes the revised procedure MUST handle, plus error contracts the new code introduces. All errors follow the AGENTS.md §1 no-silent-fallback rule — every recoverable failure path emits a structured event with explicit reason.

## Error Catalogue

| Code | Source | Severity | Surfaced as |
|---|---|---|---|
| F-1 | `captureDigest` throws (MessageV2.stream I/O failure) | info | log + `chain.commitment.failed` event + sentinel `<commitment_digest_unavailable>` in fragment body |
| F-2 | `invalidateContinuationFamily` throws (codex-provider package error) | warn | log + `chain.invalidate.failed` event; procedure continues (degraded but not aborted) |
| F-3 | `RebindEpoch.bumpEpoch` rate-limited | warn | existing `session.rebind_storm` anomaly event; this plan does not change behaviour |
| F-4 | `markPendingInjection` storage write fails | warn | log + `chain.init.persist.failed` event; next outbound omits notice (degraded) |
| F-5 | Fragment registry encounters unannotated fragment at startup | fatal | startup error; daemon refuses to boot (DD-7) |
| F-6 | Provider missing chain-semantics classification | fatal | startup error; daemon refuses to boot (DD-11) |
| F-7 | classifier receives unknown event kind | fatal | type-system enforced; if escaped at runtime, throw `UnknownContinuationEventError` |
| F-8 | Cross-phase rollout — old runtime hits new pendingInjection field | info | undefined field treated as empty; no event |

## Failure modes handled

### F-1: captureDigest throws

- **Source**: MessageV2.stream I/O error, malformed message record, sqlite read failure during digest scan.
- **Handling**: try/catch inside `captureDigest`; return `null`; log `log.info("commitment digest capture failed (using sentinel)", { sessionID, error })`. The procedure executor continues with `digest=null`. Subsequent fragment builder uses sentinel marker `<commitment_digest_unavailable>` in body. AGENTS.md §1 satisfied by emitting `chain.commitment.failed` runtime event.
- **Test**: TV-9.

### F-2: invalidateContinuationFamily throws

- **Source**: codex-provider package internal error, disk write failure on per-shard storage.
- **Handling**: try/catch in `Continuation.run` step 3; on throw, log warn + emit `chain.invalidate.failed` event with the error message. The procedure DOES NOT abort — pendingInjection mark, epoch bump, and telemetry steps still execute. The next outbound will attempt to send `previous_response_id` (which may then be rejected by codex server, which is the existing E12 backend-failure path, which routes back through `Continuation.run`).
- **Test**: M3-6 negative variant.

### F-3: RebindEpoch.bumpEpoch rate-limited

- **Source**: existing rate-limit on bumpEpoch (10 bumps per 60s per session).
- **Handling**: unchanged from current behaviour. `Continuation.run` checks outcome.status; if `"rate_limited"`, log warn but continue (telemetry only — invalidation already happened). The session.rebind_storm anomaly event fires as before.
- **Test**: existing rebind-epoch rate-limit tests cover this.

### F-4: markPendingInjection storage write fails

- **Source**: sqlite write failure on session.execution persistence.
- **Handling**: try/catch; log + emit `chain.init.persist.failed` event. Best-effort: the next outbound will not have the marker, so no notice gets injected. Degraded but not catastrophic — the AI may跳針 but the system stays alive.
- **Test**: M3-6 negative variant.

### F-5: Fragment registry encounters unannotated fragment at startup

- **Source**: a developer adds a new fragment without explicit policy classification.
- **Handling**: registry loader iterates all registered fragments; for any missing `policy` field, throw `FragmentPolicyMissingError(fragmentId)`. Daemon refuses to boot. CI catches this at PR time. (DD-7 no silent default.)
- **Test**: M10-A7 / M6-6.

### F-6: Provider missing chain-semantics classification

- **Source**: a developer registers a new provider in `provider/models.ts` without an entry in `provider/chain-semantics.ts`.
- **Handling**: startup assertion (M0-2) iterates registered providers; for any without a chain-semantics entry, throw `ProviderChainSemanticsMissingError(providerId)`. Daemon refuses to boot. (DD-11 no duck-typing.)
- **Test**: M10-A6.

### F-7: classifier receives unknown event kind

- **Source**: at runtime, a code path constructs a ContinuationEvent with an unrecognised kind (caller bypassed type checks, or future event added without classifier update).
- **Handling**: classifier exhaustive switch with `assertNever` default; throws `UnknownContinuationEventError(kind)` synchronously. Procedure aborts; caller must handle. CI test M1-4 ensures classifier handles every union member.
- **Test**: M1-4 exhaustiveness assertion.

### F-8: Cross-phase rollout — old runtime hits new pendingInjection field

- **Source**: rolling deployment; legacy session record predates the schema extension (`session.execution.pendingContinuationInjection` undefined).
- **Handling**: every read of the field uses `?? null` or `?? {}` to treat undefined as empty. Procedure proceeds as if no prior break occurred for that session. After first new chain break, the field is initialised correctly.
- **Test**: Acceptance Check A (spec.md "Backward compatibility for in-flight sessions" scenario).

## Error contracts introduced

### `UnknownContinuationEventError`

```ts
class UnknownContinuationEventError extends NamedError {
  static readonly name = "UnknownContinuationEventError"
  static readonly data = z.object({
    kind: z.string(),
    sessionID: z.string().optional(),
  })
}
```

Thrown only by the classifier exhaustive default; should never escape to user-visible UI under correct typing.

### `FragmentPolicyMissingError`

```ts
class FragmentPolicyMissingError extends NamedError {
  static readonly name = "FragmentPolicyMissingError"
  static readonly data = z.object({ fragmentId: z.string() })
}
```

Startup-time only; refuses to boot daemon. Fatal.

### `ProviderChainSemanticsMissingError`

```ts
class ProviderChainSemanticsMissingError extends NamedError {
  static readonly name = "ProviderChainSemanticsMissingError"
  static readonly data = z.object({ providerId: z.string() })
}
```

Startup-time only; refuses to boot daemon. Fatal.

## What this plan does NOT introduce as error types

- No new user-facing error UI surface. The chain-init notice appears as a context fragment; if it fails to render, the AI gets a degraded prompt but the user sees nothing different.
- No new HTTP/SSE error codes. All failures stay in the runtime event journal.

## Cross-reference

- All event types listed here are normative in `data-schema.json#events`.
- All failure-mode tests are listed in `tasks.md` (M3-6, M6-6, M10-A6, M10-A7).
