# Handoff: codex-update

## Execution Contract

This plan is executed in beta-workflow mode. All product code changes land on the beta worktree's branch (`beta/codex-update` recommended); fetch-back to `~/projects/opencode` is the final step before promoting to `living`.

## Required Reads

1. [proposal.md](proposal.md) — why and scope boundaries
2. [design.md](design.md) — full audit, DD-1..DD-6, critical files
3. [invariants.md](invariants.md) — INV-1..INV-7 (must be preserved by every commit)
4. [spec.md](spec.md) — Requirements with GIVEN/WHEN/THEN
5. [test-vectors.json](test-vectors.json) — concrete IO pairs per Requirement
6. [tasks.md](tasks.md) — phased checklist (canonical source for TodoWrite during `implementing`)

### Reference Material

- Upstream commits to consult while implementing:
  - `a98623511b` (#20437) — session_id / thread_id split — header semantics + prompt_cache_key
  - `35aaa5d9fc` (#20751) — WS send-side idle timeout pattern (Rust `tokio::time::timeout` wrapper around `ws_stream.send`)
  - `2070d5bfd3` (#21284) — response.processed (DEFERRED per DD-5 — do not implement)
  - `5d6f23a27b` (#21249) — compact cache_key/service_tier (DEFERRED per DD-4 — backend handles)
- Upstream `build_session_headers` reference: [refs/codex/codex-rs/codex-api/src/requests/headers.rs](refs/codex/codex-rs/codex-api/src/requests/headers.rs)

## Stop Gates In Force

1. **§17 carry-forward gate** — if any task discovers a constraint not enumerated in invariants.md, stop and amend INV-N before patching
2. **Live smoke fails** (§6 in tasks.md) — if a real codex turn does not show both headers as expected, stop and revise (do not push)
3. **Unit test cannot be made deterministic** — if §3 send-stall test relies on real timer behavior in a flaky way, stop and request user guidance on a better mock harness
4. **Submodule pointer drifts** — if codex submodule `M refs/codex` appears in `git status` mid-implementation, stop; this plan is pinned at `f7e8ff8e5` (commit `dbd8f7215`); a new bump opens a separate `extend`

## Out of Scope (do NOT touch)

- `response.processed` outbound ack (DD-5)
- Direct `/responses/compact` invocation (DD-4)
- Submodule pointer (pinned)
- Provider architecture refactor
- Other providers (Anthropic, Gemini)
- Codex submodule contents (read-only reference)

## Execution-Ready Checklist

Before starting Phase 1:

- [ ] beta worktree exists at `/home/pkcs12/projects/opencode-beta` (per memory: this is permanent — do NOT recreate)
- [ ] beta branch checked out: `git -C /home/pkcs12/projects/opencode-beta checkout -b beta/codex-update` (or rebase onto main if already exists)
- [ ] `OPENCODE_DATA_HOME` exported to a beta-isolated path (per memory: `feedback_beta_xdg_isolation`)
- [ ] No uncommitted changes in main repo `~/projects/opencode` other than the proposal/design artifacts in `specs/codex-update/`
- [ ] Bun test runner available: `bun --version` succeeds

## Per-Task Ritual

Per plan-builder §16.3:
1. Mark `- [x]` in [tasks.md](tasks.md) immediately when each task completes
2. Run `bun run /home/pkcs12/.claude/skills/plan-builder/scripts/plan-sync.ts specs/codex-update/`
3. Update TodoWrite status to `completed`

## Phase Boundary Ritual

Per plan-builder §16.4: at end of each `## N.` phase, write a phase-summary entry to a docs event log file (e.g. `docs/events/event_2026-05-08_codex-update.md` or follow existing dating convention) covering: Phase, Done, Key decisions, Validation, Drift, Remaining.

## Promotion Schedule

| From → To | Trigger |
|---|---|
| `designed → planned` | this handoff.md committed |
| `planned → implementing` | first `- [x]` appears in tasks.md (i.e. task 1.1 done) |
| `implementing → verified` | tasks 5.1, 5.2, 5.3, 6.3, 6.4 all green |
| `verified → living` | beta-workflow fetch-back merged to `main` (task 7.3) |
