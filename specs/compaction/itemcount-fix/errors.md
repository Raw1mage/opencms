# Errors

## Error Catalogue

Phase 1 introduces no user-facing errors (transformer is internal to prompt assembly). Internal failure modes are surfaced as logs and a defensive throw for the layer purity guard.

## Errors

### E-01: PHASE1_TRANSFORM_LAYER_PURITY_VIOLATION
- **Layer**: prompt assembly (transformer formatter)
- **Cause**: A trace marker text being formatted contains a key from `LayerPurityForbiddenKeys` (data-schema.json) — e.g. `previous_response_id`, `accountId`, `wsSessionId`
- **Trigger**: Defensive assertion at `formatTraceMarker` time (DD-7)
- **Recovery**: Throw — prompt assembly aborts. Caller falls through to existing error path (logged at session level). This is an architectural invariant violation; should never happen unless code regresses.
- **Operator action**: Treat as bug. Search recent commits for places that wrote connection-state into trace markers. File issue.

### E-02: PHASE1_FALLBACK_TO_RAW (warning, not error)
- **Layer**: prompt assembly
- **Cause**: Transformed message count < `compaction.fallbackThreshold` (default 5)
- **Trigger**: Safety net check after transform completes (DD-4)
- **Recovery**: Use raw (un-transformed) messages and proceed. Logged at warn level: `phase1-transform: fallback to raw, threshold=N, got=M`.
- **Operator action**: If warn rate is high (>1%), investigate session shape — may need threshold tuning, OR may indicate sessions that legitimately can't be transformed.

### E-03: PHASE1_WORKING_CACHE_REFERENCE_MISSING (warning, not error)
- **Layer**: transformer
- **Cause**: Tool result lacks WorkingCache entry at transform time, AND lazy-write also failed
- **Trigger**: WorkingCache lookup returns no reference and write fails
- **Recovery**: Trace marker emitted without cache reference (degraded form: `[turn N] tool_a(args)` without `→ WC042`). Log warn `phase1-transform: cache miss, sessionID=..., toolCallId=..., turnIndex=...`.
- **Operator action**: Investigate WorkingCache indexing policy — frequent occurrence indicates tool completion hook isn't covering some tool path.

### E-04: PHASE1_UNSAFE_BOUNDARY (existing, behaviour unchanged)
- **Layer**: prompt assembly
- **Cause**: First post-anchor message is an assistant with completed/orphaned tool calls (existing condition from `applyStreamAnchorRebind`)
- **Trigger**: Existing check at [prompt.ts:603-606](../../packages/opencode/src/session/prompt.ts#L603-L606)
- **Recovery**: Unchanged from pre-Phase-1 — slice not applied, full history retained
- **Operator action**: Not actionable; this is a defensive guard that should rarely fire in healthy sessions
