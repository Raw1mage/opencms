# Event: Memory GraphRAG skill assessment and bootstrap

Date: 2026-02-21
Status: Done

## Context

User goal: make `/memory` knowledge graph more token-efficient, high-performance, and high-precision.

## Findings

1. Current `/memory` capability is graph CRUD (entities / relations / observations / search), which is a strong storage layer but not a full GraphRAG retrieval stack.
2. Through `skill-finder` workflow and GitHub search, no reliable drop-in `SKILL.md` explicitly focused on GraphRAG for opencode memory MCP was found.
3. A high-quality adjacent baseline was found:
   - `alirezarezvani/claude-skills` -> `engineering/rag-architect/SKILL.md`
   - Good generic RAG architecture and evaluation guidance, but not graph-first memory orchestration.

## Decision

Create a project-local + template-synced skill `graphrag-memory` tailored to opencode memory MCP.

### Added files

- `.opencode/skills/graphrag-memory/SKILL.md`
- `templates/skills/graphrag-memory/SKILL.md`

## Why this decision

- Satisfies immediate need without waiting for an external perfect-match skill.
- Aligns with project rule: template/runtime sync to avoid drift.
- Keeps `/memory` as authoritative graph store while adding GraphRAG-style retrieval guidance.

## Scope of new skill

- Graph-first hybrid retrieval flow: entity linking -> bounded neighborhood -> rerank -> token-budget packing.
- Precision controls: confidence/freshness weighting, conflict handling, evidence-backed response format.
- Token controls: de-duplication, compact evidence packing, strict budget.
- Suggested quality targets: precision@K, hallucination rate, token reduction ratio.

## Risks

- Skill guidance is process-level; production impact depends on follow-up implementation in runtime query pipeline.
- Quality metrics require benchmark harness to validate continuously.

## Next

1. Add benchmark dataset + evaluation script for `/memory` retrieval quality.
2. Implement ranker and context packer in memory retrieval path.
3. Track precision/token KPIs in CI or periodic report.
