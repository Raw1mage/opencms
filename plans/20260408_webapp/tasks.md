# Tasks

## 1. Planning Follow-through

- [x] 1.1 Read the approved implementation spec for webapp voice input MVP
- [x] 1.2 Confirm browser-only scope, fail-fast unsupported policy, and stop gates
- [x] 1.3 Confirm critical files and prompt-editor integration boundaries

## 2. Integrate prompt-input voice control

- [x] 2.1 Add mic control and route-aware UI in `packages/app/src/components/prompt-input.tsx`
- [x] 2.2 Wire `packages/app/src/utils/speech.ts` into prompt-input state lifecycle for the desktop path
- [x] 2.3 Integrate interim/final transcript into canonical prompt editor/state without creating a second text authority
- [x] 2.4 Add unsupported/error messaging and explicit stop behavior for the desktop path
- [x] 2.5 Extend the plan to treat iPhone / Android as capability-based speech targets
- [x] 2.6 Define the capability gate and unsupported fallback boundary
- [x] 2.7 Define mic UX states for supported, recording, and unsupported cases
- [x] 2.8 Define the desktop/iPhone / Android route selection policy and detection heuristics

## 3. Validation

- [~] 3.1 Add or update focused prompt-input test coverage for desktop and mobile voice-input state interactions (deferred: current beta slice completed without new component-level tests)
- [~] 3.2 Run targeted lint/typecheck/tests for touched app files (blocked: beta worktree lacks `tsgo` and full workspace dependency/tooling resolution)
- [~] 3.3 Perform desktop-browser manual verification and record evidence (blocked: browser smoke not yet executed in this run)
- [~] 3.4 Perform mobile-browser manual verification and record evidence (blocked: browser smoke not yet executed in this run)
- [~] 3.5 Perform unsupported-browser/fail-fast verification and record evidence (blocked: browser smoke not yet executed in this run)
- [x] 3.6 Add iPhone / Android path manual smoke criteria and acceptance notes
- [x] 3.7 Add desktop path smoke criteria and acceptance notes

## 4. Documentation / Retrospective

- [x] 4.1 Write `docs/events/event_20260408_webapp_voice_input_mvp.md`
- [x] 4.2 Verify `specs/architecture.md` sync status and note whether doc changes are needed
- [x] 4.3 Compare implementation results against the proposal's effective requirement description
- [x] 4.4 Produce a concise validation checklist with delivered scope, gaps, deferred items, and evidence
- [x] 4.5 Update the event log and plan artifacts to reflect mobile voice-input expansion
- [x] 4.6 Update design and handoff docs to separate desktop speech and mobile recording slices
