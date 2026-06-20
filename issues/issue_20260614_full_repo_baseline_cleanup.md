# Full Repo Baseline Cleanup PR Scope

Status: OPEN (re-measured 2026-06-20) — baseline 大幅收斂 **38 → 13 failing / 339 files**。舊清單的 security 主嫌（killswitch-gate / path-traversal / storage-hardening / rate-limit-judge）+ skill-SSOT 群 + session/server 多檔**全數自綠**。本次清掉 1 個確認的 test-drift（tweaks.attachment-inline，commit 見下），其餘 12 檔分三類,各有 stop gate。詳見「Re-measure 2026-06-20」段。

## Re-measure 2026-06-20 — 13 failing / 339, 分類 + reclassify

完整 baseline log:`/tmp/baseline-run.log`。逐檔核實（**未盲信 subagent 分類**,2 檔被我重新定性）：

### ✅ Fixed this session (1)

- `src/config/tweaks.attachment-inline.test.ts` — **test-drift,已修綠**。runtime `AttachmentInlineConfig` 新增 `autoInlineUploadBudgetTokens:20000`（tweaks.ts:559）,`toEqual` 缺欄位。純測試落後,已補欄位 commit。

### env (1) — 非 code bug

- `packages/console/app/test/rateLimiter.test.ts` — `Cannot find package 'sst'`（缺依賴,環境 blocker,與舊清單同）。

### needs-decision (2) — 被我從「test-drift」重新定性,需 maintainer 決策,不盲改

- `src/mcp/enablement-tool-keys.test.ts` — 測試正確抓到 enablement.json 的 docxmcp pptx `prefer` 清單（`docxmcp_pptx_read` 等,enablement.json:383-396）廣告了 **default unified profile 不 register** 的工具（server 只暴露 `docxmcp_document`+`docxmcp_stage`,pptx 工具走 `DOCXMCP_TOOL_PROFILE=legacy`）。**決策點**:default profile 該不該廣告 legacy-profile 工具?要嘛改 enablement.json 資料、要嘛測試 model 要納入 profile 概念。非單純 drift。
- `test/server/session-resume.test.ts` — DD-5 busy-skip。runtime（session.ts:884-892）**仍正確**回 `busy_skipped`,測試也**仍期望** `busy_skipped`,但實得 `ok`。root cause:測試 `SessionStatus.set(busy)` 寫的 Instance state 與 route handler `SessionStatus.get` 讀的 AsyncLocalStorage scope **不一致**（harness instance-context wiring）。**需修 harness**讓 set/get 同 instance,非改斷言。

### real-bug-suspect (4) — 斷言 security/contract invariant 失敗,**絕不可為求綠改斷言**,需 git-blame runtime intent

- `test/pty/pty-output-isolation.test.ts` — pty session A 輸出 `"AAA"` 洩漏到 session B 的 websocket（`expect(outB).not.toContain("AAA")` 失敗）。疑 **cross-session output leak**,安全相關。
- `test/session/working-cache.test.ts` — post-compaction manifest `summaryBody` 非 string（應 `toContain("Working Cache: L2=0")`）→ manifest 沒產出 awareness 內容,疑 compaction provider regression。
- `test/session/structured-output.test.ts` — 3 fail。plain-text 回應應寫 `StructuredOutputError` 實得 `error.name=undefined`;compaction 後 `structured` 應留 `{answer}` 實得 `undefined`。錯誤路徑 + compaction 後遺失,疑真 bug。
- `test/server/session-autonomous.test.ts` — 3 fail。原應 block 的 `wait_subagent` 現被判 `resumable:true` 並真的 resume（`applied:true`）;`blockedReasons` 應 `["waiting_user_non_resumable:wait_subagent"]` 實得 `[]`。**autonomous resume-gate 放行翻轉**,疑 regression（部分 received 新欄位是合約擴張,但 resumable/applied 語意翻轉是核心嫌疑）。

### needs-rewrite (5) — 共同根因 freerun-bridge 架構遷移,test harness 未餵新架構所需（baseURL/family）→ 整案重寫,非逐 assertion patch

- `test/session/llm.test.ts` — `UnknownFamilyError: family="openai-gated"`（舊 gated family 已不在 knownFamilies）。
- `test/session/llm-cms-stream.test.ts` — stream 契約 15s timeout（freerun stateless rewrite 路徑與測試假設不符）。
- `test/session/attachment-ownership.test.ts` — `provider openai has no options.baseURL — cannot build LlmClient`（freerun-bridge.ts:233）+ timeout。
- `test/session/prompt-account-routing.test.ts` — `context_budget` / `latestUser.content` 結構已變;self-heal 未走 compaction。
- `test/mcp/oauth-browser.test.ts` — `BrowserOpenFailed` 永久 timeout（隔離 5s / baseline 30s 皆掛）,event 等待邏輯與現行 OAuth flow 不符。

---

## (歷史) Closeout 2026-06-15 (session) — 21/22 affected files green, 1 WIP-blocked

## Closeout 2026-06-15 (session) — 21/22 affected files green, 1 WIP-blocked

Worked the full affected-file set (22 files touched this session). Parallel per-file sweep (each file own process, `-P 6`) gives the authoritative state:

**GREEN: 21 files.** Includes the 3 env-pollution commons fix (`test/preload.ts` now strips `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_AUTH_SECRET` + `OPENCODE_ALLOW_GLOBAL_FS_BROWSE`), the partial-mock→spread-real-namespace fixes (killswitch-gate, llm-rate-limit-routing import layer), dead-test surgery (turn-summary-capture), schema-drift (hardening `TARGET_VERSION`), contract-drift (task handoff-child, rate-limit-judge UNKNOWN-no-promote, session-messages-cursor `before` param, bootstrap-policy prose, provider-cms), and skill-SSOT cluster (skill/capability-layer/mandatory-skills — fixed by subagent: skills now scan `Global.Path.data/skills` only).

**Two REAL runtime regressions found + fixed (not masked):**

- `revert-compact` + `session-message-delete`: `StorageRouter` had no per-message `remove` primitive, so `SessionRevert.cleanup` / `Session.removeMessage` / `MessageV2.remove` deleted via legacy-fs-only `removeMessageInfo`, never touching sqlite-format sessions (broken by storage phase-1 refactor `9a09f92e`). Fix: added `removeMessage`/`removePart` to the Backend interface + both backends (sqlite, legacy) + the Router delegating object, and routed all 3 call sites through `StorageRouter`. Typecheck clean, both green, legacy unit tests unregressed.

**`test/session/llm-rate-limit-routing.test.ts` — case 1 FIXED, case 2 has 1 real behavioral question left.**

- **Case 1 `backfills resolved active account` — FIXED (test drift).** Git proved `df4bf81aa fix(session): stop falling back to global activeAccount for in-flight requests` is **committed runtime**; the runtime no longer calls `Account.getActive` (only a comment references it). The test asserted the pre-RCA fallback. Renamed to `does not backfill global active account...` and rewrote assertions to expect `input.accountId` undefined + no `x-opencode-account-id` header. This ALIGNS with the committed no-fallback decision (does NOT re-introduce a fallback). Verified 1 pass in isolation.
- **Case 2 `uses account-scoped provider config when pinned` — harness bug fixed, 1 real question remains.** Found+fixed a genuine harness bug: the test did not mock `@/auth`, so it leaked into real `Auth.get` → `UnknownFamilyError(family="opencode")` (only visible in isolation; masked by mock-pollution in the full-file run). Added the missing `@/auth` mock. That cleared the crash and exposed the **real** behavioral question: pinned `pincyluo` account routes pathname correctly to its own `baseURL` (`/v1` ✓) but the apiKey resolves to the base provider's `wrong-base-v1` key instead of `pincy-key` — i.e. **per-account provider config does not override base-provider config for the apiKey dimension.** This test was introduced by `63bd34c4a fix(session): pin request account to session identity` (the account-pinning feature). Whether per-account `config.provider[<account-id>].options.apiKey` SHOULD win over the base `config.provider[<family>].options.apiKey` is an account-pinning design-intent question for the maintainer — NOT something to silently patch. **Pending: maintainer decision on per-account-config-override semantics.** Until then this 1 case stays red; the harness fix is a clean improvement regardless.

**Deferred (separate notes):** `incoming/baseline-deferred-notes.md` — `compaction-replay-integration.test.ts` (emptied; integration asserts pre-refactor CompactionManager kind-chain wiring — needs a rewrite against the new chain, not a quick patch) + nvidia provider-cms note.

**Environmental skip (unchanged):** `console/app/test/rateLimiter.test.ts` — `Cannot find package 'sst'` (missing dep).

**Working-tree note:** runtime edits this session are confined to the storage-router regression fix (`storage/{index,sqlite,legacy,router}.ts`, `session/{revert,index,message-v2}.ts`) + the test-only changes. The pre-existing WIP (`llm.ts`, `account/rotation/*`, `account/rate-limit-judge.ts` backoff constant, `capability-sync/`) is the user's in-flight work, untouched by the regression fixes.

## Re-run 2026-06-15 (later) — baseline re-measured

Re-ran `bun scripts/test-with-baseline.ts` (isolated per-file). Result: **38 failing files** (was 34 at last record). NOTE: the working tree is dirty — uncommitted runtime edits (`account/rate-limit-judge.ts`, `account/rotation/*`, `session/llm.ts`) and a new untracked `packages/opencode/src/capability-sync/` directory are present, plus recent commits `255c64a9f fix(skill): enforce single source of truth`, `54b19988d`/`572e2e4cc` (system-manager session resolution). These explain the delta from 34 → 38.

### 4 newly-failing files vs the 34-file record — root cause: skill-SSOT drift, NOT runtime regression

All four share one signal (`Available skills: none` / fixture skill not indexed) and trace to the skill-SSOT refactor + the untracked `capability-sync/` work; tests assert the pre-refactor contract.

- **`test/tool/skill.test.ts`** — REGRESSED after being marked fixed in `1c860b503`. `Skill "tool-skill" not found. Available skills: none`. The `255c64a9f` skill SSOT change altered how skills are discovered; the test's fixture setup no longer registers. Fails in BOTH isolated AND single-process mode (not an isolation artifact).
- **`test/session/capability-layer-runtime.test.ts`** — `pinnedFirst` no longer contains `probe-skill`; `entry.pinned` not true (DD-15 reinject side-effect). Same skill-index root cause. Fails in both modes.
- **`test/session/mandatory-skills-integration.test.ts`** — TV9/TV10/TV11 expect status `preloaded` from project `.claude/skills/`; skill not picked up. Same root cause.
- **`test/file/path-traversal.test.ts`** — 3 cases: `File.read`/`File.list` no longer throw `Access denied: path escapes project directory` for `../` traversal. Project-root resolution differs in this run; needs confirmation whether this is a real security regression (path-escape guard) or a test-harness cwd issue. **Flag for security review** alongside the existing killswitch-gate / storage-hardening triage.

Classification: 3 are skill-SSOT test drift (update tests to new discovery contract); 1 (`path-traversal`) needs a real-bug-vs-harness determination before touching. None require reverting the skill-SSOT or capability-sync runtime work.

## Progress 2026-06-15

### Baseline reproduced & diagnosed

Full run (`bun scripts/test-with-baseline.ts`): **251 fail / 2823 pass** across 329 files. Per-file isolation sweep split the failures decisively:

- **~124 fails (63%) were cross-file POLLUTION** — files that pass alone but fail in the shared single-process run. Root cause: the runner ran all 328 files in ONE `bun test` process, and 44 files call `mock.module` while only 12 restore; bun does not fork per file, so module mocks / global state bleed into later files. Pollution also _masked_ a few real failures.
- **~72 fails were REAL** (fail in isolation too) — genuine contract drift or possible bugs.

### Structural fix (commit `75dcd6e4b`)

Reworked `scripts/test-with-baseline.ts` to run **each file in its own process** with bounded parallelism (concurrency = cores−1, cap 16; `OPENCODE_TEST_NO_ISOLATE=1` restores the old single-process mode). Result: **60 failing files → 34**, all genuine. The baseline now reports real failures, not runner artifacts. No isolation-introduced failures (the 3 files newly visible were already failing/masked, incl. one env blocker).

### Real clusters fixed (commits `2038d84ad`, `e55cd5afc`, `1c860b503`) — all test-only, no runtime change

- **snapshot.test.ts** (43→0): snapshot became opt-in (`93e507440`) → enable in bootstrap config; `diffFull` FileDiff slimmed to metadata-only (no before/after bodies, fixed a ~5.5 GB dup) → assert `status`.
- **codex.test.ts**: JWT helpers moved retired `src/plugin/codex` → `account/quota/openai` (renamed) → re-point (only coverage of that logic).
- **google-calendar-app.test.ts**: deleted (built-in moved to a standalone server; module gone).
- **app-registry.test.ts**: dropped 6 obsolete google-calendar catalog tests.
- **skill.test.ts**: output now `<skill_loaded>` marker (content via session skill-layers), not inline `<skill_content>`.
- **truncation.test.ts**: externalization is token-gated (DD-1), `maxBytes` vestigial → rewrite 2 byte tests to token contract.

### Remaining real-failure backlog (34 files, ~72 fails) — need per-case bug-vs-drift triage

IMPORTANT: do NOT blanket-edit these to pass — several may be REAL regressions (mask risk). Each needs the same root-cause check used above (git-blame the contract, confirm intent).

- **Env blocker**: `console/app/test/rateLimiter.test.ts` — `Cannot find package 'sst'` (missing dep; environmental, not a code bug).
- **Likely real bugs to investigate first** (assert security/contract invariants): `src/server/routes/session.killswitch-gate.test.ts`, `src/session/storage/hardening.test.ts`, `src/account/rate-limit-judge.test.ts`.
- **Contract drift (likely test updates)**: `test/project/workspace-owned-diff.test.ts` (diff body shape), `test/tool/task.test.ts` (handoff-status child no longer "authoritative" for dispatch-block; agent validation order), `test/provider/provider-cms.test.ts` (1 real of 5; rest were pollution).
- **Session/server cluster** (compaction/llm/prompt/anchor/account-routing contract shapes lag runtime): `test/session/{compaction,compaction-hybrid,llm,llm-cms-stream,llm-rate-limit-routing,post-anchor-transform,revert-compact,structured-output,prompt-account-routing,bootstrap-policy,instruction,preflight-cooldown-guard,working-cache,attachment-ownership}.test.ts`, `src/session/{compaction-replay-integration,prompt.turn-summary-capture}.test.ts`, `test/server/{session-list,session-resume,session-select,session-meta,session-messages-cursor,session-message-delete,session-autonomous,account-providerkey-compat,frontend-tweaks-route}.test.ts`, `test/mcp/oauth-browser.test.ts`, `test/pty/pty-output-isolation.test.ts`.

Original below.

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
