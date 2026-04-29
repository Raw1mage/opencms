# Handoff

## Required Reads

- `specs/architecture.md`
- `docs/events/event_20260430_agentmemory_knowledge_system.md`
- `refs/agentmemory/README*` and project metadata after submodule import

## Executor Contract

- Do not modify upstream submodule contents.
- Do not implement runtime integration in this slice.
- Preserve unrelated working tree changes.
- Use fail-fast behavior for missing repo/network access.

## Expected Output

- Submodule entry under `/refs/agentmemory`.
- Event log with functional analysis and knowledge-system expansion recommendations.
