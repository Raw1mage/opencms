# Baseline-deferred: nvidia provider + compaction-replay-integration

Status: CLOSED 2026-06-23 — deferred backlog, closed as not-actively-pursued. Neither is a regression: (1) `nvidia` is a never-implemented runtime provider (a missing feature, not a bug), (2) compaction-replay-integration is a known test gap. Both tests remain `test.skip`/`describe.skip` with inline reasons; reopen via a fresh feature/spec when either is actually scheduled. Original analysis preserved below.

~~OPEN (2026-06-15) — two baseline failures deferred from `issue_20260614_full_repo_baseline_cleanup` because they are NOT mechanical test drift. Both are `test.skip`/`describe.skip` with inline reasons pointing here.~~

## 1. `test/provider/provider-cms.test.ts` — "cms admin-like nvidia api account shows provider model list"

**Verdict: not test drift — missing runtime feature.**

`nvidia` is not a runtime provider:

- absent from `Account.PROVIDERS` (`src/account/index.ts:22`) — set is `google-api, openai, claude-cli, gemini-cli, gitlab, github-copilot, gmicloud, opencode`
- absent from the provider `database` in `src/provider/provider.ts`
- absent from models.dev

The account-merge loop (`src/provider/provider.ts:1602-1604`) does `const baseProvider = database[family]; if (!baseProvider) continue` — so adding an nvidia API account can never produce `providers["nvidia"]`. The test (added in commit `e24359c7a fix(cms): canonicalize provider identity resolution and add nvidia e2e`) asserts nvidia support that the current runtime does not wire through the standard provider path.

**To re-enable:** wire `nvidia` into the provider database (a custom-provider entry with a baseURL + model list, similar to the gmicloud `https://api.gmi-serving.com/v1` custom path at `provider.ts:827/1462`). This is runtime feature work, not a test edit.

## 2. `src/session/compaction-replay-integration.test.ts` — "SessionCompaction.run wires replay helper for each observed condition" (6 cases)

**Verdict: not test drift — asserts pre-refactor internal wiring.**

These integration tests assert the old internal call shape of `SessionCompaction.run()`: that it directly calls `_writeAnchor` / `_replayHelper` with a specific snapshot-threading signature. The kind-chain execution was rebuilt around `CompactionManager` (`requestPublish` / `requestEnrich` + kind-chain in `src/session/compaction.ts`). In the mocked setup, `run()` now hits chain-exhaustion and returns `"stop"` (`compaction.ts:2795`) before reaching the asserted anchor writer — so `result` is `"stop"` not `"continue"`, and the anchor-writer `writes` array stays empty.

This was the file that exhausted a batch-fix subagent's context (it is a genuine refactor-gap, not a one-line flip).

**To re-validate:** rewrite the 6 cases against the current `CompactionManager` contract — assert `requestPublish`/`requestEnrich` intents and the new kind-chain anchor path, or drive `run()` with mocks that let a kind actually commit so the anchor writer is reached.

## Context

Both surfaced during the full-repo baseline cleanup (2026-06-15). The 2 real runtime regressions found in the same pass (`revert-compact` + `session-message-delete`, root cause: `StorageRouter` had no per-message `remove`, so deletes bypassed sqlite-format sessions) were FIXED in that task. These two are deferred because fixing them risks scope-creep (nvidia) or masking a refactor gap (compaction-replay) without a proper rewrite.
