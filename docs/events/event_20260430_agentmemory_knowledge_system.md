# Event: AgentMemory Reference Import and Knowledge System Expansion

## Requirement

Add `https://github.com/rohitg00/agentmemory` to `/refs/` as a submodule, analyze its capabilities, and use it as input for expanding OpenCode CMS into a knowledge management system.

## Scope

### IN

- Add `refs/agentmemory` submodule.
- Analyze upstream functionality and integration implications.
- Propose OpenCode knowledge-management architecture direction.

### OUT

- No runtime integration yet.
- No daemon restart.
- No changes to upstream submodule contents.

## Tasks

- 1.1 Create plan and event log skeleton.
- 1.2 Read OpenCode architecture/event context for memory and knowledge boundaries.
- 1.3 Add `https://github.com/rohitg00/agentmemory` as `refs/agentmemory` submodule.
- 1.4 Analyze AgentMemory features, storage model, APIs, and runtime assumptions.
- 1.5 Record integration proposal, validation evidence, and architecture-sync note.

## Debug Checkpoints

### Baseline

- Need a reference implementation for agent memory / knowledge management.
- OpenCode already has session memory/compaction and SharedContext; external knowledge storage must not blur those authorities.

### Instrumentation Plan

- Inspect upstream repository metadata and docs after submodule clone.
- Compare capabilities against OpenCode architecture surfaces: session memory, SharedContext, MCP managed apps, provider/runtime boundaries.

### Execution

- Created plan package at `plans/20260430_agentmemory_knowledge_system/`.
- Added `https://github.com/rohitg00/agentmemory` as git submodule at `refs/agentmemory`.
- Read OpenCode architecture and memory/compaction event context, especially the message-stream SSOT consolidation and hybrid-LLM compaction boundaries.
- Inspected upstream AgentMemory docs and source: `README.md`, `ROADMAP.md`, `package.json`, `src/index.ts`, `src/triggers/api.ts`, `src/functions/observe.ts`, `src/functions/smart-search.ts`, `src/functions/context.ts`, `src/functions/consolidation-pipeline.ts`, `src/types.ts`, and `src/state/schema.ts`.
- Explore subagent `ses_2255d70d1ffe9qcNPqlYZk9szM` completed, but transcript read failed with `session_not_accessible`; main-session evidence above is used as the analysis source.

### Root Cause / Findings

- AgentMemory is a standalone persistent-memory engine for coding agents. It exposes MCP, REST, hooks, and a viewer; it targets multi-agent clients rather than being tied to a single agent runtime.
- Runtime model: Node >= 20 package (`@agentmemory/agentmemory`) backed by `iii-engine`; package dependencies include `iii-sdk`, `zod`, and optional local embedding packages (`@xenova/transformers`, ONNX runtimes).
- Capture model: hook payloads (`session_start`, `prompt_submit`, `pre_tool_use`, `post_tool_use`, `post_tool_failure`, `pre_compact`, `subagent_*`, `stop`, `session_end`) become observations. `mem::observe` strips private data, deduplicates by session/tool/input, stores raw observation, emits stream updates, and either performs opt-in LLM compression or zero-LLM synthetic compression.
- Storage model: KV scopes include sessions, per-session observations, memories, summaries, profiles, graph nodes/edges, semantic/procedural memory, audit, actions, leases, routines, signals, checkpoints, facets, lessons, insights, image refs/embeddings, slots, and state.
- Retrieval model: hybrid search combines BM25, optional vector embeddings, and graph score; `memory_smart_search` defaults to compact results and supports explicit expansion by observation IDs.
- Context model: `mem::context` builds bounded context from project profile, recent session summaries, and high-importance observations, wrapped in an `<agentmemory-context project="...">` envelope.
- Consolidation model: four-tier design maps working observations to episodic summaries, semantic facts, and procedural workflows; semantic/procedural extraction requires enabled LLM-backed consolidation and records audit entries.
- Tool/API surface: README advertises 51 MCP tools, 6 resources, 3 prompts, 4 skills, and 107 REST endpoints; source confirms REST triggers for observe/search/context/remember/forget/consolidate/graph/team/audit/snapshot/vision/slots/etc.
- Trust controls: privacy stripping before storage, optional auth via `AGENTMEMORY_SECRET`, audit entries for mutating/governance paths, and feature flags for LLM-costing or injection behavior.

## Integration Proposal for OpenCode CMS

### Recommended Architecture Direction

1. Add a first-class **Knowledge Management subsystem** separate from existing `SessionCompaction`.
   - `SessionCompaction` remains the per-session prompt-window SSOT derived from message stream anchors.
   - New KM layer owns durable cross-session/project knowledge: observations, facts, patterns, decisions, file history, graph edges, and provenance.
2. Capture observations from OpenCode's existing Bus/message/tool lifecycle instead of importing AgentMemory's hook mechanism verbatim.
   - Candidate producers: session start/end, user prompt, assistant completion, tool call start/end/failure, subagent start/finish, compaction anchor creation, plan-builder task transitions.
   - Use existing Bus infrastructure for boundary-safe event propagation; do not add polling or ad-hoc timers for core capture.
3. Expose KM through managed MCP tools plus internal server routes.
   - Initial tools: `knowledge_remember`, `knowledge_search`, `knowledge_file_history`, `knowledge_session_handoff`, `knowledge_graph_query`, `knowledge_forget`, `knowledge_verify`.
   - Keep MCP tool output compact by default; require explicit expansion by IDs for large memories, mirroring AgentMemory's compact/expand pattern.
4. Use explicit namespaces and authority boundaries.
   - Scope keys: `global`, `user`, `workspace`, `project`, `session`, `team`.
   - Retrieval must fail fast when scope/auth is ambiguous; no silent fallback to global or first available namespace.
5. Adopt AgentMemory concepts selectively, not as a runtime dependency.
   - Good to copy conceptually: observation schema, compact search + expand, four-tier consolidation, provenance, audit/delete governance, access-strength/decay, project profile, file history.
   - Avoid copying as-is: iii-engine dependency, Claude-specific hooks, standalone daemon lifecycle, provider fallback chain, direct context injection into every tool turn.

### Suggested MVP Slice

- Phase 1: internal observation ledger derived from OpenCode Bus + message stream with privacy filtering and audit.
- Phase 2: BM25-only search + compact/expand MCP tools; no vector DB yet.
- Phase 3: project profile and file-history summaries generated from observations.
- Phase 4: optional vector embeddings and graph extraction behind explicit config flags.
- Phase 5: UI/admin knowledge browser and governance delete/export.

### Key Risks

- Authority confusion with existing compaction memory. Mitigation: compaction remains prompt-window state; KM is durable retrieval/provenance state.
- Token bloat from automatic context injection. Mitigation: default to explicit tools and bounded recall; no implicit injection unless separately approved.
- Secret leakage through tool observations. Mitigation: sanitize before persistence and audit every delete/export path.
- Subagent and autonomous workflow races. Mitigation: capture via Bus events and persist with idempotent observation IDs.
- Dependency risk from iii-engine. Mitigation: treat AgentMemory as reference; implement on OpenCode-owned storage and Bus primitives.

### Validation

- `git submodule add "https://github.com/rohitg00/agentmemory" "refs/agentmemory"` succeeded.
- `.gitmodules` now contains `[submodule "refs/agentmemory"]` with path `refs/agentmemory` and URL `https://github.com/rohitg00/agentmemory`.
- `git status --short` shows `A  refs/agentmemory` and `M  .gitmodules`; unrelated pre-existing changes remain untouched.
- Architecture Sync: Verified (No doc changes). This task imported a reference submodule and produced analysis only; no OpenCode runtime module boundaries, data flows, state machines, APIs, or storage authorities were changed.
- XDG whitelist backup created at `~/.config/opencode.bak-20260430-agentmemory-knowledge-system/`; this is a pre-run snapshot for manual restore only.
