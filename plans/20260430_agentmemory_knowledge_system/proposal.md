# AgentMemory Knowledge System Expansion

## Requirement

User asked to add `https://github.com/rohitg00/agentmemory` under `/refs/` as a git submodule, analyze its functionality, and use that analysis to explore how OpenCode CMS can be expanded into a knowledge management system.

## Scope

### IN

- Add `rohitg00/agentmemory` as `refs/agentmemory` submodule.
- Inspect its README/source structure without modifying upstream code.
- Identify reusable concepts for OpenCode CMS knowledge management.
- Record integration boundaries against existing OpenCode memory, compaction, SharedContext, MCP, and managed-app architecture.

### OUT

- No production implementation in OpenCode runtime in this slice.
- No vendoring or copying upstream code into OpenCode packages.
- No daemon restart or runtime migration.
- No automatic fallback behavior for memory retrieval.

## Constraints

- Preserve existing uncommitted user changes.
- Treat `/refs/agentmemory` as reference-only until a separate implementation plan is approved.
- Knowledge management design must keep OpenCode's message-stream compaction single-source-of-truth separate from any long-term knowledge graph/vector store authority.

## Validation Plan

- `git status --short` confirms `.gitmodules` and `refs/agentmemory` submodule entries are staged/visible as repo changes.
- Read upstream README/package files to summarize capabilities.
- Event log records key decisions and next-step architecture proposal.
