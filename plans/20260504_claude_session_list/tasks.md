# Tasks

## 1. Discovery and contract

- [x] 1.1 Map existing session list API, storage router, and provider/model metadata fields.
- [x] 1.2 Decide exact Claude classification rule without legacy fallback.
- [x] 1.3 Record the backend/frontend contract for the list shape.

## 2. Backend/API slice

- [x] 2.1 Reuse or extend the session list endpoint for Claude-related filtering.
- [x] 2.2 Add tests for filter and response shape.

## 3. Frontend monitoring slice

- [-] ~~3.1 Add Settings/Admin operator-facing list surface.~~ cancelled: superseded by user request for project-scoped sidebar tab.
- [x] 3.2 Add project-scoped sidebar session list tab for OpenCode / Claude switching.
- [x] 3.3 Wire Claude tab loading, empty, error, refresh, and click-through session navigation states.

## 4. Validation and docs

- [x] 4.1 Run focused tests/typecheck.
- [x] 4.2 Update architecture/event documentation and mark architecture sync.

## 5. Claude native takeover import

- [x] 5.1 Recon Claude transcript storage format and OpenCode session/message write path.
- [x] 5.2 Update plan/event contract: Claude tab click performs deterministic import/delta sync before navigation.
- [x] 5.3 Design runtime import contract: source mapping, delta detection, and unsupported block fail-fast behavior.
- [x] 5.4 Implement backend import/delta API and deterministic transcript normalizer.
- [x] 5.5 Wire sidebar Claude tab click to import/delta then navigate to the mapped OpenCode session.
- [x] 5.6 Add focused tests/typecheck and update event/architecture sync.
- [x] 5.7 Add deterministic new-content indicator contract (`currentLineCount`, `importedLineCount`, `hasNewContent`) and sidebar green dot.
