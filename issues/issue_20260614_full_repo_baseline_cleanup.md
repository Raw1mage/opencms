# Full Repo Baseline Cleanup PR Scope

Status: OPEN — extracted from `harness_freerun-mode` validation gate; not part of freerun feature scope.

## Summary

Full repo baseline validation currently fails on non-freerun drift. During `harness_freerun-mode` beta validation, focused freerun tests and CLI smoke passed, but broad `bun test` / baseline cleanup exposed unrelated repo-wide failures. Those tentative fixes were reverted out of the freerun beta branch and should be handled in a separate PR.

## Evidence

- Freerun focused scope is green: `OPENCODE_SKIP_TUI=1 FREERUN_SCOPE_FINAL=1 bun test --timeout 30000 packages/opencode/test/freerun packages/opencode/src/session/freerun-command.test.ts packages/opencode/src/session/todo.test.ts packages/app/src/components/session/cache-hotness.test.ts` → `133 pass, 0 fail`.
- Freerun CLI/header smoke is green: local mock OpenAI-compatible provider received `x-opencode-mode=freerun`, `x-opencode-session-id`, `x-opencode-iteration`, and `x-opencode-node-id` headers.
- Plan event: `plans/harness_freerun-mode/events/event_2026-06-14_scope-cleanup.md` records why full-suite detour changes were reverted.
- Plan task: `plans/harness_freerun-mode/tasks.md` keeps `6.1` blocked as out-of-scope baseline drift.

## Observed Failure Areas

- Playwright / app e2e dependencies and browser-oriented tests in raw full `bun test`.
- MCP/OAuth browser tests, including callback/browser-open behavior and SDK mock surface drift.
- Provider/account routing tests with custom provider family resolution and mock-contract drift.
- Snapshot / workspace diff tests whose assertions lag current diff body / opt-in behavior.
- Compaction / post-anchor / working-cache tests whose expected payload shape lags current runtime contracts.
- App unit runner behavior where broad directory test invocation can accidentally load non-test CLI/TUI entrypoints.
- Bun mock pollution between same-process tests where partial module mocks truncate namespace exports.

## Proposed PR Plan

1. Create a separate branch, e.g. `baseline/full-repo-test-cleanup`.
2. Reproduce with the canonical full repo test command and capture the first failing file/chunk.
3. Fix runner isolation first so failures are real test failures, not CLI/TUI side effects.
4. Convert brittle partial `mock.module` stubs into full-surface mocks or file-level isolation.
5. Update tests that assert retired contracts, but avoid changing runtime behavior unless a real bug is proven.
6. Keep freerun plan changes out of this PR except for references in the issue/PR description.

## Acceptance Criteria

- Canonical full repo test command reaches completion or has a sharply documented remaining environmental blocker.
- No freerun behavior changes are required to make the baseline pass.
- Each changed test documents the current runtime contract it asserts.
- Any runtime fixes discovered during cleanup include focused regression tests.

## Out Of Scope

- Provider UI manual verification for freerun.
- Freerun feature implementation or ContextNode behavior changes.
- Daemon/web lifecycle restart or deployment.
- GitHub PR creation unless explicitly requested.
