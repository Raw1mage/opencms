# Handoff

## Status

- Source plans:
  - `plans/codex-efficiency/`
  - `plans/aisdk-refactor/`
- Promotion status: merged into this formal spec package after user confirmed both tracks were implemented and merged.
- This package is a reference/handoff surface, not an active unfinished build plan.

## Read Order For Future Maintenance

1. `specs/codex_provider_runtime/design.md`
2. `specs/codex_provider_runtime/spec.md`
3. `specs/codex-protocol/whitepaper.md`
4. Historical plan artifacts only when implementation archaeology is needed:
   - `plans/aisdk-refactor/design.md`
   - `plans/aisdk-refactor/tasks.md`
   - `plans/codex-efficiency/design.md`
   - `plans/codex-efficiency/tasks.md`

## What This Package Preserves

- Why codex provider moved/stayed on the AI SDK path
- Which request/transport features belong in providerOptions vs fetch interceptor
- Which continuity/efficiency behaviors are part of the codex runtime contract
- Which cleanup boundaries should not regress

## Maintenance Rules

- Extend codex provider under the AI SDK Responses contract; do not resurrect a second authoritative loader/runtime path.
- Keep protocol observation (`specs/codex-protocol/whitepaper.md`) separate from opencode-local normative implementation rules.
- Preserve explicit failure / degrade semantics for unsupported codex features.
- Treat per-session continuity isolation and removal of unsafe integration seams as architecture constraints, not optional cleanup.

## Historical Note

The original plans retain more granular task-level details and analysis notes. They may be archived or deleted later by explicit user instruction; this promotion step does not delete them automatically.
