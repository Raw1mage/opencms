# Design: Claude Code CLI 2.1.144 Reversed Engineering

## Context

OpenCMS's provider-claude reproduces Claude Code CLI wire behavior. The last alignment baseline was 2.1.126. Version 2.1.144 introduced 16 new beta flags, new headers (`anthropic-client-platform`, `x-anthropic-additional-protection`), billing header changes, OAuth scope expansion, and new SSE events. A complete reversed engineering spec is needed as the alignment reference.

The source is a minified 14MB bundle (`cli.js`, 19641 lines) with mangled variable names. Analysis is static only — the CLI binary is not executed.

## Goals / Non-Goals

**Goals:**
- Extract and document the complete wire protocol from the 2.1.144 bundle
- Document the two-layer retry architecture with all constants and decision logic
- Track all deltas from 2.1.126 to 2.1.144
- Produce IDEF0/GRAFCET/sequence diagrams for the retry pipeline

**Non-Goals:**
- Implement any code changes (separate task)
- Reverse engineer non-wire-protocol internals (agent orchestration, UI, session persistence)
- Execute the CLI binary or perform dynamic analysis

## Decisions

### DD-1: Source — Minified Bundle Extraction

Extract protocol details from the npm-published minified bundle rather than attempting to obtain unminified source. The bundle is publicly available via `@anthropic-ai/claude-code-linux-x64` and contains all wire protocol constants as string literals. Variable names are mangled but string constants (header names, URLs, error messages) are preserved verbatim.

**Rationale:** This is the only publicly available source. String constants and numeric literals are reliable extraction targets even in minified code.

### DD-2: Scope — Wire Protocol Only

Limit scope to what crosses the network boundary: HTTP headers, request/response bodies, SSE events, retry behavior, authentication flows, and rate limit handling. Internal logic (tool execution, agent orchestration, UI rendering) is out of scope.

**Rationale:** OpenCMS needs wire-level fidelity for fingerprint alignment. Internal behavior divergence is acceptable and expected.

### DD-3: Versioning Strategy — Track Upstream Releases

Each significant Claude Code CLI release gets a delta section appended to the datasheet (§12 pattern). The spec package version tracks the CLI version it documents. When the delta becomes large enough, a new spec version is cut.

**Rationale:** Incremental delta tracking is cheaper than full re-extraction and highlights exactly what needs provider-claude alignment updates.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Minified variable names make control flow hard to trace | Focus on string literals, numeric constants, and structural patterns |
| Bundle may contain dead code paths | Cross-reference with observed network behavior when possible |
| Upstream releases may change retry constants silently | Delta tracking (DD-3) catches changes; re-extract on each major version |
| Static analysis cannot verify runtime-conditional behavior | Document conditions as extracted; flag uncertainty where applicable |

## Critical Files

| File | Role |
|------|------|
| `chapters/protocol-datasheets.md` | Primary deliverable — 12-section protocol reference |
| `idef0.json` | Activity decomposition of retry/rate-limit pipeline |
| `grafcet.json` | State machine of retry loop |
| `sequence.json` | Message flow for 429 handling through both layers |
| `data-schema.json` | Key data structures (retry config, rate limit state, headers) |
| `refs/claude-code-npm/cli.js` | Source material (2.1.144 bundle) |
