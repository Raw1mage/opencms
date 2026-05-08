# Handoff: compaction-fix Phase 1

## ERRATUM 2026-05-08 (d) — Phase 1 disabled, Phase 2 still live

Phase 1 stop gates SG-1, SG-3, SG-4, SG-7 below describe a per-turn
transformer rollout that was attempted (v1–v6) and disabled after a
re-read of upstream `for_prompt()` showed the transformer's premise
was wrong. See [proposal.md ERRATUM](./proposal.md#erratum-2026-05-08-d--phase-1-misframing-disabled).

Status of stop gates:
- **SG-1** (default off): satisfied permanently — `compaction_phase1_enabled=0`.
- **SG-2** (subagent bypass): moot — transformer not running for any path.
- **SG-3, SG-4, SG-5, SG-6**: only meaningful if transformer reactivated.
- **SG-7** (24h soak): not applicable — transformer never reached
  `phase1Enabled=true` in production.
- **SG-8** (Phase 2 gate): superseded — Phase 2 decoupled from Phase 1
  in commit `c1feb48a1`. Phase 2 ships independently.

The L2/L4 layer purity invariant in DD-7 of design.md remains
architecturally correct and applies to all Phase 2 work.

## Execution Contract

Implementer takes Phase 1 from `planned` → `implementing` → `verified` per beta-workflow contract. Code goes through beta worktree; docs (this folder) stay on main per [feedback_commit_all_split_code_docs.md](../../packages/opencode/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_commit_all_split_code_docs.md).

## Authority Surface (beta-workflow §1)

- mainRepo: `/home/pkcs12/projects/opencode`
- baseBranch: `main`
- implementationRepo / implementationWorktree: new worktree at `~/projects/opencode-worktrees/compaction-fix`
- implementationBranch: `beta/compaction-fix` (created from main HEAD at start)
- docsWriteRepo: same as mainRepo (single-repo project)

## Required Reads

1. [proposal.md](./proposal.md) — Why + framing (4-layer L1-L4 split, 0-token vs AI-based)
2. [spec.md](./spec.md) — GIVEN/WHEN/THEN scenarios per requirement
3. [design.md](./design.md) — DD-1..DD-7 decisions
4. [tasks.md](./tasks.md) — execution checklist (work items here)
5. [data-schema.json](./data-schema.json) — TraceMarker shape + tweaks keys + LayerPurityForbiddenKeys
6. [c4.json](./c4.json) + [sequence.json](./sequence.json) — component map + happy-path/safety-net/subagent flows
7. [idef0.json](./idef0.json) + [grafcet.json](./grafcet.json) — functional + state model

## Stop Gates In Force

- **SG-1**：tweaks flag default MUST be false. PR that flips default `phase1Enabled: true` is a separate commit landed only after SG-7 (24h soak green).
- **SG-2**：Subagent path bypass MUST be wired (DD-5). Tests in 4.2.3 cover this.
- **SG-3**：Safety net fallback MUST log warn (DD-4) — silent fallback rejected.
- **SG-4**：Layer purity guard MUST throw on forbidden keys (DD-7) — defensive assertion at format time.
- **SG-5**：Mode 1 inline `compaction` parts MUST be exempt from transform (DD-7 white-list). Test 4.1.5 enforces.
- **SG-6**：In-flight assistant MUST remain intact. Test 4.1.6 enforces. Breaking this corrupts pending tool-call boundaries.
- **SG-7**：24h soak window post-deploy with `phase1Enabled=true` for at least one real session — failure rate (fix-empty-response-rca empty-turns.jsonl) must NOT increase relative to 0.71% baseline. Document via M-equivalent jq query.
- **SG-8**：Phase 2 work does NOT start until Phase 1 ships to main and soaks ≥ 24h. compactedItems handling is separate spec iteration.

## Execution-Ready Checklist

- [ ] All Required Reads done
- [ ] Beta worktree created from main HEAD: `git worktree add ~/projects/opencode-worktrees/compaction-fix -b beta/compaction-fix main`
- [ ] tweaks.cfg test config understood (where new keys live, default values)
- [ ] WorkingCache write API surface confirmed (existing namespace in [packages/opencode/src/session/working-cache.ts](../../packages/opencode/src/session/working-cache.ts))
- [ ] Confirmed location of `applyStreamAnchorRebind` invocation in prompt.ts (~line 1840) — Phase 1 transformer hooks in immediately after this

## Validation Evidence (filled during verification)

### A1 — inputItemCount reduction
- [ ] Pre-Phase-1 baseline: avg inputItemCount on representative session
- [ ] Post-Phase-1 (flag on): avg inputItemCount on same session pattern
- [ ] Drop ratio matches expectation (>3x reduction for 30+ turn sessions)

### A2 — All existing prompt.applyStreamAnchorRebind tests pass
- [ ] `bun test packages/opencode/test/session/prompt.applyStreamAnchorRebind.test.ts` clean

### A3 — New unit tests cover G1-G6
- [ ] All tasks 4.x tests added and pass

### A4 — Subagent path integration
- [ ] Subagent prompt includes full parent context (no transform applied)

### A5 — Soak failure rate
- [ ] 24h post-deploy fix-empty-response-rca empty-turns.jsonl failure rate ≤ baseline 0.71%

### A6 — Feature flag rollback
- [ ] Flag default false confirmed in shipped commit
- [ ] Flag toggled off mid-session reverts behaviour to pre-Phase-1 immediately
