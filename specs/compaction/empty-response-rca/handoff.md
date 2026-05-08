# Handoff: fix-empty-response-rca

## Execution Contract

The executor (human or AI agent) implementing this spec MUST:

- Treat [tasks.md](tasks.md) as the canonical execution ledger; update checkboxes in real-time per plan-builder §16.3
- Materialize **only the current phase's** unchecked items into TodoWrite at any moment; do not batch the whole file
- Run `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/fix-empty-response-rca/` after every checkbox toggle; honor drift warnings per §16.3 decision tree
- Keep `.state.json.state` consistent with progress (`planned → implementing` on first `- [x]`; `implementing → verified` only when all checked + acceptance evidence captured per Phase 3)
- **Never** regress codex-empty-turn-recovery's invariants (INV-01 no-throw, INV-04 always log, INV-08 retry cap=1, INV-13/14 enum stability, INV-16 provider-boundary). Where conflict arises, this spec opens an `extend` revision on codex-empty-turn-recovery rather than mutating it silently
- **Never** import codex-provider types into opencode runtime code (DD-3's `isModelTemporaryError` reads `providerMetadata.openai.emptyTurnClassification.causeFamily` as opaque metadata via property access — no type import). Boundary discipline holds
- **Never** rotate accounts on a classified empty turn (DD-3 makes this structural). If a future change adds a rotation trigger that would fire on empty-turn classifier metadata, that change is a regression that must be reverted
- **Never** ship Phase 2 (DD-1 compaction change) before Phase 1 has soaked in production for ≥ 24 hours. Phase 2 touches compaction-adjacent logic; Phase 1's effect (rotation rate drop) is the prerequisite signal that Phase 1 is stable

## Code-vs-Docs Split (per `feedback_commit_all_split_code_docs.md`)

This spec's PHASE 1 + PHASE 2 work touches PRODUCT CODE in:

- `packages/opencode-codex-provider/src/transport-ws.ts` (DD-2)
- `packages/opencode-codex-provider/src/sse.ts` (DD-2/DD-5)
- `packages/opencode-codex-provider/src/empty-turn-classifier.ts` (DD-5)
- `packages/opencode/src/session/processor.ts` (DD-3)
- `packages/opencode/src/session/prompt.ts` (DD-1)

Per memory `feedback_commit_all_split_code_docs.md`: code changes MUST go through **beta-workflow** (separate beta branch, fetch-back, merge — see `~/projects/skills/beta-workflow/SKILL.md`). Docs changes (this spec, event notes, runbooks, architecture.md) commit to main directly.

Implementer MUST surface the split before executing any "commit all" directive: separate beta-branch commits for code, main commits for docs.

## Required Reads

Before touching any code, the executor MUST have read and understood:

1. [proposal.md](proposal.md) — Decisions D-1..D-7 (especially D-7 resume + Live Recurrence Evidence section)
2. [spec.md](spec.md) — 5 Requirements with GIVEN/WHEN/THEN scenarios; 6 Acceptance Checks A1-A6
3. [design.md](design.md) — Decisions DD-1..DD-5 (predictedCacheMiss derivation, throw-leak closure, rotation guard, Phase split, wsErrorReason field); 6 Risks/Trade-offs; Critical Files
4. [data-schema.json](data-schema.json) — wsErrorReason field; CacheEquilibriumDetectionEvent; M8/M9/M10 metric queries
5. [c4.json](c4.json) — components C1-C9 + relationships
6. [sequence.json](sequence.json) — three flows (P1 throw-leak closure, P2 cache equilibrium break, P3 pre/post-fix comparison)
7. [idef0.json](idef0.json) + [grafcet.json](grafcet.json) — A0-A7 functional decomposition + 11-step lifecycle covering both DD-1 and DD-2 paths
8. [`specs/codex-empty-turn-recovery/`](../codex-empty-turn-recovery/) — predecessor spec; especially design.md DD-9 cause-family table and invariants.md INV-01/INV-08/INV-13/INV-14/INV-16
9. [`specs/codex-empty-turn-ws-snapshot-hotfix/`](../codex-empty-turn-ws-snapshot-hotfix/) — sibling hotfix; pattern for boundary normalization (TransportSnapshot interface)
10. [docs/events/event_20260507_codex-empty-turn-loop-prevention-explained.md](../../docs/events/event_20260507_codex-empty-turn-loop-prevention-explained.md) — original L1-L7 landmine analysis
11. [packages/opencode/src/session/prompt.ts:1884](../../packages/opencode/src/session/prompt.ts#L1884) — DD-1 culprit
12. [packages/opencode-codex-provider/src/transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts) lines 289, 472, 495 — DD-2 throw sites
13. [packages/opencode/src/session/processor.ts](../../packages/opencode/src/session/processor.ts) lines 149-181 + 1447 — DD-3 hook + caller
14. `~/.claude/skills/plan-builder/SKILL.md` §16 — execution contract during `implementing`
15. `~/.claude/skills/beta-workflow/SKILL.md` — for the code-change phases
16. Memory: `feedback_no_silent_fallback.md`, `feedback_provider_boundary.md`, `feedback_commit_all_split_code_docs.md`, `feedback_restart_daemon_consent.md`, `feedback_compaction_two_principles.md`

## Stop Gates In Force

Stop immediately and request approval / decision if any of the following occurs during execution:

- **SG-1** A change to `WsObservation` or `TransportSnapshot` interface would require renaming an existing field (would break codex-empty-turn-ws-snapshot-hotfix's regression test). Adding `wsErrorReason` is OK; renaming `wsFrameCount` or `frameCount` is NOT
- **SG-2** DD-3's guard logic in `isModelTemporaryError` requires importing types from codex-provider package — STOP, INV-16 violation. The metadata read MUST be opaque property access
- **SG-3** Phase 2's compaction change reduces cache-aware compaction firing rate by > 80% in tests (suggests R1 over-fired and removed too much). STOP and reconsider DD-1's rule table
- **SG-4** plan-sync.ts warns with drift > 3 files outside Critical Files list — investigate per §16.3 decision tree before continuing
- **SG-5** Smoke test in 3.4 reveals rotation events still occurring within 60s of empty-turn classifications — DD-2/DD-3 incomplete; do not promote to verified
- **SG-6** Smoke test in 3.4 reveals daemon throwing exceptions from any WS-layer empty-turn path — DD-2 throw-leak NOT fully closed; locate the leaked site
- **SG-7** Any destructive action on user data (accounts.json, session storage, JSONL log file deletion) proposed but not requested by user
- **SG-8** Any `bun test` run risks wiping XDG state — per [feedback_beta_xdg_isolation.md](~/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_beta_xdg_isolation.md), beta-workflow MUST isolate via `OPENCODE_DATA_HOME` before running tests in beta worktree
- **SG-9** Daemon restart proposed without explicit user request — per `feedback_restart_daemon_consent.md`, restart is approval-gated. Pause + ask
- **SG-10** Phase 2 work begins before Phase 1 has soaked ≥ 24 hours in production with rotation rate drop confirmed — STOP, soak first

## Execution-Ready Checklist

Before starting Phase 1, the executor confirms:

- [ ] Required Reads 1-16 above completed
- [ ] Local working copy of `packages/opencode-codex-provider/` and `packages/opencode/src/session/` clean (or beta-workflow worktree set up per code-vs-docs split)
- [ ] Test runner reachable: `bun test packages/opencode-codex-provider/src/` passes baseline (107 tests from codex-empty-turn-recovery + codex-empty-turn-ws-snapshot-hotfix)
- [ ] `<XDG_STATE_HOME>/opencode/codex/` writable; `cache-equilibrium.jsonl` will be created on first emission
- [ ] If executing in beta worktree: `OPENCODE_DATA_HOME` is set (per SG-8)
- [ ] User has been told the production rollout plan: Phase 1 deploys first (throw-leak + rotation guard, immediate observable signal), then Phase 2 (compaction change, after 24h soak)
- [ ] User confirms no in-flight session is critical enough that the daemon restart needed for Phase 1 deploy would disrupt them

## Validation Evidence (Phase 3 task 3.3)

Acceptance check results recorded here as Phase 3 progresses:

- [ ] A1 — cache_read does not lock at constant value for ≥ 3 consecutive turns: __evidence link__ (Phase 2 deploy required)
- [ ] A2 — WS truncation event no longer triggers account rotation: __evidence link__ (Phase 1 deploy + 24h soak)
- [ ] A3 — empty-turns.jsonl includes `wsErrorReason` field: __evidence link__ (Phase 1 deploy + first ws_no_frames event)
- [ ] A4 — 107+ existing codex-provider tests + new tests pass: __evidence link__ (CI / local run)
- [ ] A5 — 24h soak: zero new account-rotation events from empty-turn errors: __evidence link__ (M9 query result)
- [ ] A6 — INV-16 boundary preserved (no codex-provider type import in opencode runtime): __evidence link__ (code review of processor.ts diff)

## Promotion Gate to verified

Spec is promoted to `verified` only when:

- All Phase 1 (1.1-1.14), Phase 2 (2.1-2.8), Phase 3 (3.1-3.6) tasks checked
- All 6 acceptance checks above have evidence links recorded
- Daemon redeploy confirmed via daemon-startup.jsonl entry; first post-deploy empty-turn JSONL entry shows `wsErrorReason` field present
- 24h soak captures M9 query showing zero rotations within 60s windows of empty-turn classifications
- Architecture sync entry recorded in proposal.md or event log
