# Handoff: session/rebind-procedure-revision

## Execution Contract

This is a **multi-phase refactor**, not a hotfix. Five phases in design.md §"Migration / rollout":

- **Phase A**: Foundations (M0-M6) — additive, no call site rewired
- **Phase B**: Pilot rewire — empty-response recovery only (M7-1)
- **Phase C**: Remaining account/compaction sites (M7-2 through M7-4)
- **Phase D**: Fragment policy split land (M6-1 through M6-6 as a single PR)
- **Phase E**: Backend-failure path (M7-5)

Each phase is independently shippable. **Do NOT bundle phases** — the policy-split (Phase D) is the highest-blast-radius single change and must land in its own PR with explicit before/after fragment audit.

Code lands on a beta worktree per `beta-workflow` skill. Main repo only receives fetch-back after verification of each phase. Daemon restart only after user consent. Phases B / C / E each require their own user consent moment before rolling forward.

## Required Reads

Before writing any code, the implementer MUST read in this order:

1. This package's `spec.md` (full) — the requirement contract
2. This package's `design.md` (full) — architecture + 12 DDs + matrix
3. `data-schema.json` — exact type shapes
4. Sibling spec `/specs/compaction/recall-affordance/` (graduated 2026-05-11) — L1+L2+L3 machinery this plan extends
5. Code touched, with line ranges:
   - `packages/opencode/src/session/prompt.ts` lines 440-470 (anchor decision), 1180-1220 (pre-loop), 1430-1460 (empty-response)
   - `packages/opencode/src/session/compaction.ts` lines 160-200 (compaction chain bridge), 3600-3640 (second site)
   - `packages/opencode/src/session/rebind-epoch.ts` (entire file, 230 lines)
   - `packages/opencode/src/session/context-fragments/amnesia-notice.ts` (entire file, 115 lines)
   - `packages/opencode/src/session/context-fragments/index.ts` (entire file — fragment registry surface)
   - `packages/opencode/src/session/transport-ws.ts` lines 540-620 (backend-failure paths)
   - `packages/opencode/src/provider/models.ts` (full list of providers; for chain-semantics registry seeding)

## Stop Gates In Force

- **AGENTS.md §1 no-silent-fallback** — every classifier dispatch and every fragment injection MUST emit a structured event. Silent paths fail CI.
- **Memory rule "Restart Daemon Requires User Consent"** — DO NOT auto-restart after any phase. Ask the user.
- **Memory rule "Commit All Means Split Code From Docs"** — code commits (in beta worktree) and plan-doc commits (in main repo) MUST be separate. tasks.md ticks land in main; code lands in beta.
- **Memory rule beta-workflow §7.1** — fetch-back happens in `~/projects/opencode`, not a worktree.
- **Memory rule "Always Commit Submodule Pointer Bumps"** — none expected; flag any if they appear.
- **DD-7 no silent default in policy classification** — Phase D MUST fail CI if any fragment lacks an explicit policy. Do not add a default fallback.
- **DD-8 ordering invariant** — digest capture awaited before invalidateContinuationFamily. Tests assert this.
- **DD-11 no duck-typing** — every new providerId added to the codebase must be classified explicitly in chain-semantics.ts; missing entry fails CI.

## Phase Cut Points

A natural cut between phases lets the user pause and verify. The implementer SHOULD NOT advance to the next phase without surfacing the verification evidence (test output, telemetry capture, behaviour diff) from the prior phase.

| Phase | Cut criterion |
|---|---|
| A → B | All M0-M6 unit tests pass; no behaviour change observable |
| B → C | M7-1 + M8-7 pass; empty-response recovery emits chain.init.injected in a live session |
| C → D | M7-2/3/4 + M8-2/3/6 pass; account switch + compaction cases verified |
| D → E | M6 fragment audit complete; M10-A7 passes; bundle_user recomputes on rebind in production telemetry |
| E → done | M7-5 + M8 backend-failure regression; M10-A1 grep clean |

## Execution-Ready Checklist

- [ ] Beta worktree branch created (suggested: `beta/session-rebind-procedure-revision-phase-a`)
- [ ] Phase A: M0 + M1 + M2 + M3 + M4 + M5 implemented; all unit tests green
- [ ] Phase A: `bun run typecheck` green
- [ ] Phase A: code committed to beta; tasks.md M0-M5 ticked in main; events/event_*_phase_a_complete.md recorded
- [ ] User consent obtained → Phase B begins (separate beta branch)
- [ ] Phase B: M7-1 implemented; M8-7 integration test passes; telemetry capture from live session shows chain.init.injected
- [ ] User consent → Phase C
- [ ] Phase C: M7-2/3/4 implemented; M8-2/3/4/6 integration tests pass
- [ ] User consent → Phase D
- [ ] Phase D: M6 land as single PR; M10-A7 registry test green; before/after fragment audit document in events/
- [ ] User consent → Phase E
- [ ] Phase E: M7-5 implemented; M10-A1 grep regression green
- [ ] Phase E: M9-1/2/3 telemetry validated against 24h production sample
- [ ] All M10 acceptance gates green
- [ ] Verified state reached; user consent for graduation

## What This Plan Does NOT Do (out of scope)

- Replace `previous_response_id` mechanism
- Add Layer D dispatcher-level tool mask (Layer C nudge stays; demand expected to drop)
- Translate codex reasoning items into anthropic-compatible format (cross-provider switch leaves a structural gap that's accepted for now)
- Implement chain-preserving retry for empty-response recovery (follow-up plan)
- Implement capability-changed notice for E5 (follow-up sibling plan)
- Recover lost server-side reasoning trace (structurally impossible)

## Sibling Plans to Coordinate With

- `/specs/compaction/recall-affordance/` (graduated 2026-05-11): this plan extends its L3 amnesia-notice body. Coordinate on shared `renderDigest` helper.
- `/plans/compaction_narrative-compaction-quality/` (proposed): narrative summary quality affects digest reliability. If that plan lands first, the digest captured during compaction may be more accurate.

## Risks To Surface Early

If during implementation any of these surface, STOP and consult the user:

- A providerId in `models.ts` that doesn't fit SS / SL / Hybrid cleanly → may need a fourth class
- A `session_stable` consumer where neither `conversation_stable` nor `chain_stable` is obviously correct → may indicate a third invariant we didn't see
- Cache miss bump from `chain_stable` retag exceeds 30k tokens per reset → trade-off review needed
- Phase B replay of ses_1e56ed3f9ffebv4AaWOlcPLz20 STILL reproduces the read loop → root cause was not what we thought; revise spec before continuing
