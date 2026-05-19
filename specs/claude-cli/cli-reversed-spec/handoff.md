# Handoff: Claude Code CLI 2.1.144 Reversed Engineering

## Execution Contract

This is a **documentation-only** reversed engineering spec. No code changes are produced.

- **Deliverable**: `chapters/protocol-datasheets.md` — 12-section wire protocol reference for Claude Code CLI 2.1.144
- **Source**: Minified `cli.js` bundle from `@anthropic-ai/claude-code-linux-x64@2.1.144` (static analysis only, no execution)
- **Consumer**: OpenCMS provider-claude alignment work (separate implementation specs)
- **Scope boundary**: Wire protocol only (headers, bodies, SSE, retry, auth). Internal agent orchestration, UI, and session persistence are out of scope.

## Required Reads

1. `chapters/protocol-datasheets.md` — The primary deliverable; 12 sections covering the complete wire protocol
2. `spec.md` — Requirements R1 (completeness), R2 (retry), R3 (delta tracking)
3. `design.md` — Decisions DD-1 (bundle extraction), DD-2 (wire-only scope), DD-3 (delta versioning)
4. `idef0.json` — Retry pipeline activity decomposition
5. `grafcet.json` — Retry state machine transitions
6. `sequence.json` — 429 handling message flow through both layers
7. `data-schema.json` — Retry config, rate limit state, header structures

## Stop Gates In Force

| Gate | Condition | Status |
|------|-----------|--------|
| G1 | Protocol datasheet has all 12 sections (SS1-SS12) non-empty | PASSED |
| G2 | Beta flag table lists exactly 24 active entries | PASSED |
| G3 | Retry constants in SS5 match extracted source values | PASSED |
| G4 | Delta section lists >=10 major changes + unchanged items | PASSED (10 major + 5 unchanged) |
| G5 | IDEF0/GRAFCET/sequence diagrams present and valid | PASSED |

## Execution-Ready Checklist

- [x] Source material (`cli.js` 2.1.144) extracted and available in `refs/claude-code-npm/`
- [x] All 12 protocol datasheet sections written with no placeholders
- [x] Retry architecture fully documented (2-layer, 13 app constants, decision flow)
- [x] Beta flag registry complete (24 active + 5 API-specific + 2 null slots)
- [x] Delta from 2.1.126 enumerated (10 major changes, 5 confirmed-unchanged items)
- [x] IDEF0, GRAFCET, sequence diagrams created
- [x] Data schema captures retry config, rate limit state, and header structures
- [x] No code implementation required — this spec feeds downstream alignment work
