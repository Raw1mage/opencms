---
name: graphrag-memory
description: Improve /memory-based knowledge graph and GraphRAG quality for lower token usage, higher retrieval precision, and better grounded answers. Use when tasks mention memory, knowledge graphs, GraphRAG, entity-relation extraction, multi-hop retrieval, or response grounding.
---

# Skill: graphrag-memory

## Overview

Use this skill when the task is to build or improve `/memory`-based knowledge graph quality for:

- lower token usage,
- higher retrieval precision,
- better response grounding and traceability.

This skill is designed for opencode's single `memory` MCP tool surface and assumes graph CRUD is already available.

## When to use

Trigger on requests mentioning:

- `memory`, `knowledge graph`, `GraphRAG`, `kg-rag`,
- `token saving`, `precision`, `grounded answer`,
- `entity relation extraction`, `multi-hop retrieval`.

## Goals

1. Keep memory graph clean and canonical (high signal, low noise).
2. Retrieve the **smallest useful subgraph** for each query.
3. Return evidence-backed answers with confidence and timestamps.

## Recommended architecture (for opencode)

1. **Graph store**: `/memory` as authoritative entity-relation store.
2. **Optional vector sidecar**: embeddings for node/observation text for semantic recall.
3. **Hybrid retrieval pipeline**:
   - Query normalization
   - Entity linking
   - k-hop neighborhood fetch (bounded)
   - Re-ranking (relation strength, recency, source trust)
   - Token-budget packing

## Standard operating flow

### A) Ingestion

1. Extract candidate entities and relations from source text.
2. Canonicalize names (case, aliases, abbreviations).
3. Upsert with `memory_*` tools:
   - create entities/relations if new,
   - append observations with source and time metadata.
4. Avoid duplicates:
   - merge alias entities,
   - drop low-confidence triples.

### B) Retrieval

1. Resolve query entities first (exact + semantic aliases).
2. Expand local neighborhood with strict limits (example: 1-2 hops, capped nodes).
3. Re-rank candidates by:
   - semantic relevance,
   - edge/path confidence,
   - recency decay,
   - source reliability.
4. Build final context pack:
   - conclusion-supporting facts first,
   - de-duplicate semantically similar observations,
   - enforce hard token budget.

### C) Response format

Always return:

- `Answer`
- `Evidence` (entity/relation/observation pointers)
- `Confidence` (high/medium/low)
- `Freshness` (timestamps or staleness warning)

## Precision rules

- Prefer explicit relations over weak text-only hints.
- Penalize stale/conflicting observations.
- If evidence is insufficient, state uncertainty explicitly.
- Never promote ungrounded inference as fact.

## Token efficiency rules

- Only include top-ranked subgraph snippets.
- Summarize long observation chains into structured bullets.
- Remove repeated synonyms and duplicate paths.
- Keep relation path evidence short and auditable.

## Quality metrics (minimum targets)

- Context precision@K >= 0.8
- Hallucinated unsupported claims <= 5%
- Average context tokens reduced by >= 30% vs naive dump
- Evidence coverage: every factual claim linked to at least one memory item

## Implementation notes

- Use `memory` with explicit scope metadata for repo-specific vs cross-project facts.
- Keep major architecture decisions in `docs/events/`.

## References

- External inspiration: `alirezarezvani/claude-skills` -> `engineering/rag-architect/SKILL.md` (RAG baseline).
- This skill extends that baseline with GraphRAG-style graph-first retrieval for opencode memory MCP.
