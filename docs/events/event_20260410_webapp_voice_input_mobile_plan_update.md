# Event: webapp voice input mobile plan update

Date: 2026-04-10
Status: Planning Updated
Plan Root: `plans/20260408_webapp/`

## Scope

- Update the existing webapp voice-input plan so iPhone / Android browsers are treated as capability-based speech-recognition targets when `SpeechRecognition` / `webkitSpeechRecognition` is present.
- Keep the boundary inside the webapp client surface and preserve fail-fast behavior.

## Key Decisions

- iPhone / Android browsers should activate the shared speech-recognition path when capability detection passes.
- Unsupported state must be explicit when capability detection fails.
- Route selection must remain visible and deterministic.

## Plan Artifacts Updated

- `plans/20260408_webapp/tasks.md`
- `plans/20260408_webapp/implementation-spec.md`
- `plans/20260408_webapp/design.md`
- `plans/20260408_webapp/handoff.md`

## Verification

- Read current architecture and existing webapp voice-input planning artifacts.
- Confirmed the plan already contains speech-recognition support and only needed capability-based route policy alignment for iPhone / Android.
- Updated planning artifacts to reflect the capability-based contract.
- Architecture Sync: Verified (No doc changes).

## Remaining

- If execution continues, the next build slice should define or implement the mobile recording/transcription boundary in code.
- Browser smoke / typecheck / lint evidence remains pending for the overall voice-input workstream.
