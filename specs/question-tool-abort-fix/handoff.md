# Handoff — question-tool-abort-fix

## Execution Contract

Executor must obey the following in order:

1. **Read `spec.md` in full before writing any code.** Requirements A/B/C define acceptance — coding without reading the Scenarios will miss cache-per-session and pre-aborted signal edge cases.
2. **Phase order is fixed**: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6. Phases 1 and 2 both touch server code but must not be collapsed — reason telemetry (C) needs signed-off call-site list before Phase 1 can be unit-tested end-to-end.
3. **Mark `- [x]` in tasks.md immediately** after each sub-task completes. Run `plan-sync.ts` after each one. Drift output controls next-mode decision per skill §16.3.
4. **One `in_progress` at a time** in TodoWrite. Phase rollover is atomic per skill §16.1.
5. **No hotfix shortcut.** This is not a single-file bug fix — it cuts through server and webapp. Full lifecycle applies.
6. **Branch discipline.** Work on current branch `test/session-poll-cache` unless user asks otherwise. Do not create new branches or fetch-back without instruction. If user asks for beta workflow, invoke `beta-workflow` skill — plan-builder and beta-workflow are independent concerns (skill §16.7).

## Required Reads

Before touching code, executor must read:

- [specs/question-tool-abort-fix/spec.md](spec.md) — Requirements + Scenarios
- [specs/question-tool-abort-fix/design.md](design.md) — DD-1..DD-5 decisions (especially DD-1 on RejectedError reuse and DD-3 on CancelReason enum)
- [specs/question-tool-abort-fix/data-schema.json](data-schema.json) — type contracts (CancelReason enum, QuestionDockCacheKey format)
- [specs/question-tool-abort-fix/sequence.json](sequence.json) — target bug P2 and manual-stop P3
- [specs/architecture.md](../architecture.md) — system SSOT (especially Bus messaging and rotation3d sections)
- [packages/opencode/src/question/index.ts](../../packages/opencode/src/question/index.ts) — current Question state machine
- [packages/opencode/src/session/prompt-runtime.ts](../../packages/opencode/src/session/prompt-runtime.ts) — AbortController site to modify
- [packages/app/src/components/question-dock.tsx](../../packages/app/src/components/question-dock.tsx) — cache target
- AGENTS.md §0 "Plan Before Implement" and §1 "No Silent Fallback"

## Stop Gates In Force

Executor **must stop** and request user decision at these points:

1. **Before any state promotion** (`implementing → verified`, `verified → living`). User reviews acceptance evidence.
2. **If Phase 2 reveals more than 10 cancel call sites** — requires revisit of enum (maybe need more values or a nested enum). Run `revise` mode.
3. **If Phase 3 hash implementation fails on a target browser** (e.g. node SSR pre-render throws on SubtleCrypto) — stop, propose fallback strategy to user before editing.
4. **If Phase 5.2 shows the bug is not reproduced by rate-limit fallback alone** — the actual trigger is something else; pause and collect more log before declaring victory.
5. **If tsc / lint fails after Phase 2.7** — never `-- --no-verify`. Fix root cause.
6. **Commit contains more than scope** (e.g. accidentally touched other files) — amend commit scope before proceeding.
7. **Destructive operations** (git reset, force-push, rm tracked files) — always ask. Per memory `feedback_no_rm_tracked`.

## Execution-Ready Checklist

- [x] `.state.json` state = `designed` (ready for promotion to `planned` once this file is finalized)
- [x] `proposal.md`, `spec.md`, `design.md` present and valid
- [x] `idef0.json`, `grafcet.json`, `c4.json`, `sequence.json`, `data-schema.json` present and valid
- [x] Scope lockdown: IN/OUT edges in proposal.md agreed with user
- [x] DD-1..DD-5 documented with alternatives considered
- [x] `tasks.md` phased, unchecked, mapped to DD decisions
- [x] `handoff.md` (this file) declares stop gates
- [ ] `test-vectors.json` present (blocks `planned` promotion)
- [ ] `errors.md` present (blocks `planned` promotion)
- [ ] `observability.md` present (blocks `planned` promotion)
- [ ] User explicit "begin" or `implementing` promotion signal

## Validation Evidence Location

Once tasks are all checked, fill this section with:

- `bun test packages/opencode/src/question/` output (Phase 1.7)
- `bunx tsc --noEmit` output (Phase 2.7)
- QuestionDock unit / Playwright output (Phase 3.8)
- Manual E2E report from Phase 5 (each case 5.1–5.6)
- `grep 'reason=' ~/.local/share/opencode/log/debug.log | head` snippet

Add entry to `.state.json.history` with `mode: "promote", to: "verified"` when evidence is attached.
