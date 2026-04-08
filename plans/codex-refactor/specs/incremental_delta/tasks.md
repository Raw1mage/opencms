# Tasks

## 1. Instrument Delta Effectiveness

- [ ] 1.1 Read the approved implementation spec and companion artifacts
- [ ] 1.2 Add request/output instrumentation for delta length, full part length, and SSE payload size
- [ ] 1.3 Capture baseline evidence for main session and subagent streaming paths

## 2. Define Continuation Versioning And Invalidation

- [ ] 2.1 Define the version-control inputs for append-only submission (system prompt, tool schema, provider-model identity, transcript base, upstream handle)
- [ ] 2.2 Add deterministic invalidation/rebind behavior for changed continuation contracts
- [ ] 2.3 Add explicit continuation invalidation for `first-frame timeout`, `mid-stream stall timeout`, `close-before-completion`, and `previous_response_not_found`
- [ ] 2.4 Record operator-visible evidence for continuation reuse vs rebind decisions

## 3. Rewrite Runtime Delta Transport

- [ ] 3.1 Refactor session streaming updates so the hot path publishes append-only delta-aware data instead of repeated full parts
- [ ] 3.2 Adjust message event definitions and SSE fanout to match the new transport contract
- [ ] 3.3 Keep durable storage semantics explicit without using storage payloads as the streaming transport shape

## 4. Update Consumers And Bridge Paths

- [ ] 4.1 Rewrite Web global sync to apply streamed assistant deltas without full-part reconcile per chunk
- [ ] 4.2 Rewrite TUI sync to apply streamed assistant deltas without repeated full-part search/reconcile per chunk
- [ ] 4.3 Update subagent bridge handling so child streamed updates do not re-amplify full payloads

## 5. Validate And Sync Documentation

- [ ] 5.1 Run targeted validation for request append-only behavior plus session/app/TUI delta paths and record payload-size evidence
- [ ] 5.2 Validate timeout/continuation failure paths (`first-frame timeout`, `mid-stream stall timeout`, `previous_response_not_found`) and record recovery behavior
- [ ] 5.3 Update event log with implementation outcomes and architecture sync result
- [ ] 5.4 Compare implementation against the proposal's effective requirement description
