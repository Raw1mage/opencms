# Handoff: provider-account-decoupling

## Execution Contract

- Build agent loads exactly one phase from [tasks.md](tasks.md) into TodoWrite at a time (plan-builder §16.1)
- Phase rollover is atomic: phase-summary → next phase TodoWrite → first task `in_progress` happen back-to-back, no user prompt between
- Every code change runs through `plan-sync.ts` after task checkbox toggle; sync warnings handled per plan-builder §16.3 decision tree
- Implementation runs in a beta worktree per `beta-workflow` skill (this work touches the main runtime; admission gate qualifies)
- No commit batches all checkboxes at the end — checkbox state must reflect actual progress per plan-builder §16.8

## Required Reads

Before touching any code, the build agent must read:

1. [proposal.md](proposal.md) — why + scope + 三個 user 決策（單次切換 / OAuth 不動 / 全面 sweep）
2. [spec.md](spec.md) — 7 條 Requirement 的 GIVEN/WHEN/THEN，特別是 *Acceptance Checks*
3. [design.md](design.md) — DD-1..DD-9 九條決策；DD-8（無 shim）和 DD-9（parser 只給 migration 用）是地雷防線
4. [data-schema.json](data-schema.json) — Family / AccountId / 4 種新 Error 型別
5. [c4.json](c4.json) — 哪些檔案會被砍 (`removed[]`)
6. [grafcet.json](grafcet.json) — S0..S9 切換流程；rollback path 是 backup 不是程式碼相容
7. AGENTS.md（repo root）— 第一條「No Silent Fallback」整條

## Stop Gates In Force

Build agent MUST stop and ask the user before:

- **Touching OAuth token storage format** — out of scope per user decision 2026-05-02; only query interface changes allowed
- **Adding any compatibility shim or fallback** — DD-8 forbids; if a caller is breaking and the obvious fix is "accept both forms", stop and re-design
- **Deleting `Account.parseProvider` / `resolveFamilyFromKnown`** — DD-9 keeps them for migration; only the runtime call sites are removed
- **Skipping the backup step in cutover** — DD-7; backup is the sole rollback mechanism
- **Running migration script without `--dry-run` first** — operator gate, not agent gate; agent never executes phase 9 (cutover) without explicit user confirmation
- **Modifying accounts.json structure** — already family-keyed; only sanity-check, no rewrite
- **Bringing the daemon up without verifying `.migration-state.json`** — boot guard exists for this; do not bypass with env var or flag

## Execution-Ready Checklist

Before agent enters `implementing`:

- [ ] All artifacts in [c4.json](c4.json) `containers[]` are reachable on disk (or noted as `New` in design.md)
- [ ] `Account.knownFamilies()` enumerated and matches the `Family` regex in [data-schema.json](data-schema.json)
- [ ] Beta worktree spun up per `beta-workflow` skill; baseBranch is `main`
- [ ] `OPENCODE_DATA_HOME` for the beta env points at an isolated dir (NOT shared with the running daemon's `~/.local/share/opencode`)
- [ ] [test-vectors.json](test-vectors.json) reviewed; the fixture session matches a real legacy session shape so the migration test is meaningful
- [ ] `specs/architecture.md` Provider/Family/Account section drafted (can land in phase 8.3 but the agent should know where to write)

## Cutover Coordination

Phase 9 is operator-driven, not agent-driven. After phase 8 completes:

1. Agent stops, summarises phase 8 in event log
2. Agent posts a cutover checklist (mirroring [tasks.md](tasks.md) §9) to the user
3. Operator runs §9.1–§9.6 by hand; agent observes via daemon logs
4. Operator confirms smoke pass → agent promotes spec `verified → living`
