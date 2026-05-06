# Handoff: codex-empty-turn-recovery

## Execution Contract

The executor (human or AI agent) implementing this spec MUST:

- Treat [tasks.md](tasks.md) as the canonical execution ledger; update checkboxes in real-time per plan-builder §16.3
- Materialize **only the current phase's** unchecked items into TodoWrite at any moment; do not batch the whole file
- Run `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/codex-empty-turn-recovery/` after every checkbox toggle; honor drift warnings per §16.3 decision tree
- Keep `.state.json.state` consistent with progress (`planned → implementing` on first `- [x]`; `implementing → verified` only when all checked + acceptance evidence captured per Phase 4)
- **Never** introduce a `hard-error` recovery action — Decision D-1 forbids it. Even temporarily during incremental work. If a code path looks like it wants to throw on empty-turn, route it through the classifier instead
- **Never** silently fall back if the classifier returns an unrecognized recovery action — `log.warn` + return `pass-through-to-runloop-nudge` as the safe default. Surfacing must be explicit per AGENTS.md 第一條
- **Never** bypass log emission to "speed up" recovery — D-2 makes logs the load-bearing path; recovery is subordinate
- **Never** introduce backoff or second-retry to retry-once-then-soft-fail — DD-7 caps firmly at 1; amplifying load on a degraded backend is the explicit Risk R3

## Required Reads

Before touching any code, the executor MUST have read and understood:

1. [proposal.md](proposal.md) — Decisions D-1..D-5 (max fault tolerance, log evidence floor, audit-before-omit, broad nudge, slug)
2. [spec.md](spec.md) — GIVEN/WHEN/THEN scenarios for every cause family + log mechanism + nudge interaction; Acceptance Checks A1-A7
3. [design.md](design.md) — Decisions DD-1..DD-12 (classifier location, log channel, retry layer, enum values, phase order); Risks R1-R7; Critical Files list
4. [data-schema.json](data-schema.json) — log entry JSON Schema; cause-family enum; recovery-action enum (no `hard-error`)
5. [c4.json](c4.json) — components C1-C9 + relationships; understand the boundary between WS-layer and SSE-layer classifier invocation sites
6. [sequence.json](sequence.json) — four reference flows (P1 ws_truncation+retry, P2 server_empty with reasoning, P3 successful negative case, P4 log-failure resilience)
7. [idef0.json](idef0.json) + [grafcet.json](grafcet.json) — A1-A6 functional decomposition + 10-step state machine showing the empty-turn lifecycle (detect → classify → log → recover → cycle)
8. [packages/opencode-codex-provider/src/sse.ts](../../packages/opencode-codex-provider/src/sse.ts) — current flush block at lines 142-184 (where classifier hook lands per DD-4)
9. [packages/opencode-codex-provider/src/transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts) — current ws.onclose at lines 418-424 (where silent endStream is replaced per DD-5)
10. [packages/opencode-codex-provider/src/provider.ts](../../packages/opencode-codex-provider/src/provider.ts) — current request builder at lines 60-105 (Phase 2 derives requestOptionsShape here)
11. `~/.claude/skills/plan-builder/SKILL.md` §16 — execution contract during `implementing`
12. `AGENTS.md` 第一條 — no-silent-fallback constraint
13. Memory: `feedback_no_silent_fallback.md`, `feedback_provider_boundary.md`, `feedback_minimal_fix_then_stop.md`, `feedback_destructive_tool_guard.md` — guiding principles for this work

## Stop Gates In Force

Stop immediately and request approval / decision if any of the following occurs during execution:

- **SG-1** A new cause-family pattern emerges in production logs that doesn't match any of the six enum values — execute `extend` mode revision before adding to the enum (D-1 / spec Requirement `Cause-family enum is finite and append-only`)
- **SG-2** Code change touches files outside the Critical Files list in design.md — escalate as scope creep
- **SG-3** A test fails that suggests the classifier is producing false positives on real-but-truncated responses (Risk R2) — pause Phase 2 and audit predicate boundaries before continuing
- **SG-4** plan-sync.ts warns with drift > 3 files — investigate per §16.3 decision tree before continuing
- **SG-5** Smoke test in 1.13 / 3.9 / 4.4 reveals retry rate > 20% of empty turns — DD-7 retry cap holding but indicating broader codex degradation; halt rollout, surface to operators, do not enable Phase 3 in production until cause analysed
- **SG-6** Smoke test reveals log volume > 10 MB / day on a single instance — exceeds R1 mitigation envelope; pause + reduce log granularity OR accelerate logrotate setup before continuing
- **SG-7** Production logs show `server_empty_output_with_reasoning` at ≥ 5% of empty-turn cluster (per spec Requirement `Audit-before-omit`) — trigger D-3 `extend` mode revision to add codex-subscription parameter omission
- **SG-8** Any destructive action on user data (accounts.json, session storage, JSONL log file deletion) proposed but not requested by user
- **SG-9** Any `bun test` run risks wiping XDG state — per [feedback_beta_xdg_isolation.md](~/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_beta_xdg_isolation.md), beta-workflow MUST isolate via `OPENCODE_DATA_HOME` before running tests in beta worktree
- **SG-10** `transport-ws.ts` retry attempt #2 also fails — this is the soft-fail boundary; under no circumstances enable retry #3, even if it "would obviously succeed". DD-7 cap is non-negotiable

## Execution-Ready Checklist

Before starting Phase 1, the executor confirms:

- [ ] Required Reads 1-13 above completed
- [ ] Local working copy of `packages/opencode-codex-provider/` clean (no uncommitted changes that would conflict)
- [ ] Test runner reachable: `bun test packages/opencode-codex-provider/test/` passes on baseline
- [ ] `<XDG_STATE_HOME>/opencode/codex/` writable; if not, create with `mkdir -p`
- [ ] If executing in beta worktree per beta-workflow skill: `OPENCODE_DATA_HOME` is set (per SG-9)
- [ ] User has been told the production rollout plan: Phase 1 goes live first (log infra), then Phase 2 (classifier discrimination, no behavioral change), then Phase 3 (retry, behavioral change worth gating)
- [ ] User confirms they are not in the middle of a session that would be disrupted by codex provider redeploy

## Validation Evidence (filled during Phase 4)

Acceptance check results recorded here as Phase 4 progresses:

- [ ] A1 — `msg_dfe39162f` fingerprint replay → `ws_truncation` + `retry-once-then-soft-fail` confirmed: __evidence link__
- [ ] A2 — synthetic `response.completed{output:[]}` + `reasoning.effort` → `server_empty_output_with_reasoning` confirmed; `suspectParams` includes `reasoning.effort`: __evidence link__
- [ ] A3 — successful stream with deltas → no empty-turn log entry: __evidence link__
- [ ] A4 — log channel forced to throw → recovery completes; only side effect is `console.error` breadcrumb: __evidence link__
- [ ] A5 — every cause-family scenario in spec.md produces expected family + action + log entry: __evidence link__
- [ ] A6 — 24h smoke test: zero hard-error, no exception escape: __evidence link__
- [ ] A7 — runloop continues to fire `?` nudge for all classified empty turns; nudge synthetic message carries classification metadata: __evidence link__

## Promotion Gate to verified

Spec is promoted to `verified` only when:

- All Phase 4 tasks (4.1-4.6) checked
- All 7 acceptance checks above have evidence links recorded
- Log distribution snapshot from 4.5 captured in event log
- D-3 audit decision recorded: either (a) no `extend` needed, or (b) `extend` mode revision drafted to address OpenHands B/C parameter omission
