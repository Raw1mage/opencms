# Full Repo Baseline Cleanup PR Scope

Status: OBSERVING (2026-06-22) — 核心真 bug 已全清，餘 6 項皆非產品正確性風險、排 backlog。本輪：structured-output 真 regression 已修（case 1 enforcement reachability + case 2 DD-7 compaction-round 守衛，commit `61603e1c0`，8 pass + 廣域回歸全綠）；前輪 pty security gap 亦已修。**剩餘 6 項（needs-decision 2 / needs-rewrite 4 / env 1）逐項定性後無一傷害產品正確性**，移入 observing 待排期：

- **env(1)** `rateLimiter`（缺 `sst`）— 非 code bug，裝依賴或永久 skip。
- **needs-decision(2)** `enablement-tool-keys`（pptx profile 廣告語意，設計選擇）/ `session-resume`（harness AsyncLocalStorage instance wiring，runtime 與測試期望皆正確）— 卡使用者設計決策，非技術 bug。
- **needs-rewrite(4)** `llm` / `attachment-ownership` / `prompt-account-routing` / `oauth-browser` — 共同根因 freerun-bridge 架構遷移，test harness 未餵 baseURL/family；逐 assertion patch 無意義，待有人動 bridge harness 時整案重寫。

重啟條件（任一）：(a) 追求 baseline 全綠（CI gate / release）；(b) 有人動 freerun-bridge test harness（順手重寫 needs-rewrite 4 項）；(c) 使用者就 enablement profile 語義 / session-resume harness 拍板。詳見下方「Re-measure 2026-06-22」段。

## Re-measure 2026-06-22 — backlog 10 → 8，structured-output 反向重分類

隔離單跑全部 10 檔（HEAD d58f20a07，含 DD-8 等新 commit）。對照 2026-06-20：

### ✅ 自綠 (2)，移出 backlog

- `test/server/session-autonomous.test.ts` — 2026-06-20 為 3 fail（schema 擴張 drift）。autonomous-gate-enforcement / DD-8 工作把 response schema 與測試 `toMatchObject` 對齊，現 **7 pass / 0 fail**。
- `test/session/llm-cms-stream.test.ts` — 2026-06-20 列 needs-rewrite（freerun stream 15s timeout）。現 **3 pass / 0 fail**，stream 契約已對齊。

### 🔴 structured-output — 反向重分類：test-drift → **真 runtime regression**（mask 已避免）

`test/session/structured-output.test.ts`（2 fail：`writes StructuredOutputError when model returns plain text` + `keeps json_schema flow after auto compaction`）。

2026-06-20 的「safe drift，改 mock 即可」結論**錯誤**——它把 `[PHASE2] applied=false reason=no-anchor` 當成失敗主因，但那是 `prompt.ts:3833` 的 always-on `console.error` debug 噪音，與失敗無關。

源碼層 RCA（green baseline `815cb4132`「fix(session): enforce structured output error」對照 HEAD）：

- 實測 runtime：plain-text json_schema 回應 `finish="stop" structured=undefined error=undefined` → **runtime 沒設 StructuredOutputError**。
- 兩條 enforcement 路徑都漏掉 clean-terminal-text 這格：
  - guard A（`prompt.ts:3039`）在迴圈頂部，僅經 `continue` 可達；
  - guard B（`prompt.ts:4159`）要求 `result==="stop"`，但 clean text 經 `processor.process` 回 `"continue"`（processor 此行為自 baseline 即如此，**未變**）；
  - 新增的 `isCleanTerminal` break path（`prompt.ts:4297-4382`，content-filter + autonomous-continuation 機制，**baseline 沒有**）在抵達 guard A 前就 `break`。
- 因果：loop 重構（新增 clean-terminal break path）時未把 structured-output enforcement 帶進該分支 → enforcement guard 變不可達 = **真 regression，非測試落後**。
- 註：早先 subagent RCA 把機制誤判為「processor 回傳 stop→continue 退化」，經 `git show 815cb4132:processor.ts` 證偽（baseline 即 `return "continue"`）；結論（enforcement 不可達）不變。
- **處置（2026-06-22 更新）**：拆成兩個 case 分別處理。

#### Case 1 `writes StructuredOutputError when model returns plain text` — ✅ 已修（runtime fix）

- 修法：`prompt.ts` 的 `isCleanTerminal` break path 內、所有 break 分支之前，補 json_schema enforcement（限 `isCleanTerminal`，鏡像頂部 guard A 條件：`format.type==="json_schema" && structured===undefined && !error` → 設 StructuredOutputError）。
- runtime probe 坐實：plain-text json_schema 回應 `finish="stop"`、`result="continue"`、structured/error 皆 undefined → guard B（要求 `result==="stop"`）不可達，`isCleanTerminal` break 在回到 guard A 前退出。修法在 break 前補回 enforcement。
- 廣域回歸驗證全綠：structured-output 7 pass（case 1 綠）、session-autonomous 7 pass、compaction 38 pass、post-anchor-transform 11 pass，無退化。

#### Case 2 `keeps json_schema flow after auto compaction` — ✅ 已修（取向 Y，plan `runloop_structured-output-enforcement-ordering`）

- 修法（DD-7，最小）：`prompt.ts` 的 `isCleanTerminal` / `isUnrecognizedTerminalWithOutput` 加 `result !== "compact"` 守衛——壓縮輪（`result==="compact"`）的 assistant message 可能帶 `finish="stop"`（plain-text overflow turn 觸發 compaction），原本會誤滿足 isCleanTerminal 進 terminal-decision block（設 error/break），殺掉壓縮後的 round。守衛後壓縮輪一律 fall-through 到 loop 底 `continue`，下一輪重送較小 prompt。`consecutiveCompactions>=3`（:4222）已 bound，不會無限迴圈。
- 取向定案 = **取向 Y**（使用者拍板）。spike 證實非純 test-drift（取向 Z 排除）：即使把 mock 改成 runtime 真正消費的 `inspectBudget`，case-1 enforcement 仍在壓縮輪前 break。真正死結是 isCleanTerminal 缺 `result !== "compact"` 守衛——runtime processor 本來就在 `inspectBudget().overflow` 回 `"compact"`（`processor.ts:1206→2040`），不需動 processor 回傳語義。
- 配套：測試 mock 目標從已搬家的 `SessionCompaction.isOverflow` 改為 runtime 真正消費的 `inspectBudget`（合法 test-drift 修正，測試 intent 不變）。
- 驗證：structured-output **8 pass / 0 fail**；廣域回歸全綠（session-autonomous 7 / compaction 38 / post-anchor-transform 11 / compaction-hybrid 22）。

#### （原待決策記錄，已由上方取向 Y 結案）

- LOOP-PROBE 坐實：此 case **只跑 step 1**（`result="continue", finish="stop"`），mock 的 round-2 structuredStream 與 compaction **從未執行**。
- 根因：`deriveObservedCondition` 的 `isOverflow()`（`prompt.ts:1211`）被包在 `if (input.lastFinished)`（:1210）內；iteration 1 無前一輪 assistant → `lastFinished=undefined` → mock `isOverflow=true` 永不被諮詢 → 不 compaction → plainText → `result="continue"` → `isCleanTerminal` break。baseline 時這個 `continue` 會讓 iteration 2 才有 `lastFinished`、才觸發 compaction + round 2。`isCleanTerminal` break **斬斷了 baseline 的多輪 compaction-retry 路徑**——與 case 1 同源，但修法方向**衝突**：case 1 要「立即 error + break」，case 2 要「不 break、再給 loop 一輪 compaction 機會」。
- 正確調和需動 scarred-core 的 loop ordering（terminal-decision vs compaction-retry 優先序），屬高風險重構，**超出 baseline test cleanup 範圍**，需獨立 plan + 使用者決策。Case 1 的窄修法不影響此 case（修法前後皆紅）。

### 維持原分類（重測確認不變，無可安全 mop-up）

- env(1): `console/app/test/rateLimiter.test.ts` — 仍 `Cannot find package 'sst'`。
- needs-decision(2): `src/mcp/enablement-tool-keys.test.ts`（2 fail，docxmcp pptx profile 廣告語意）、`test/server/session-resume.test.ts`（1 fail，harness instance-context wiring）。
- needs-rewrite(4): `test/session/llm.test.ts`、`test/session/attachment-ownership.test.ts`、`test/session/prompt-account-routing.test.ts`、`test/mcp/oauth-browser.test.ts`（共同根因 freerun-bridge 遷移，test harness 未餵 baseURL/family）。

---

## Re-measure 2026-06-20 — 13 failing / 339, 分類 + reclassify

完整 baseline log:`/tmp/baseline-run.log`。逐檔核實（**未盲信 subagent 分類**,2 檔被我重新定性）：

### ✅ Fixed this session (3, baseline 13 → 10)

- `src/config/tweaks.attachment-inline.test.ts` — **test-drift,已修綠**。runtime `AttachmentInlineConfig` 新增 `autoInlineUploadBudgetTokens:20000`（tweaks.ts:559）,`toEqual` 缺欄位。純測試落後,已補欄位 commit。
- `test/pty/pty-output-isolation.test.ts` — **真 security gap,已修**。補回 send loop 的 `token(ws) !== sub.token` 守衛（`b6c2ddd5a` 當初為修終端機行為連同移除,只剩 socket.id 檢查）。`sub.token` 早已在 connect() 捕獲,僅補回 hot-path 比對。真實 client 不受影響（token() 對 data-less wrapper 委派 .raw,故 wrapper-token === loop-token）。2 pass / 0 fail,tsgo 乾淨。commit 見下。
- `test/session/working-cache.test.ts` — **退役契約,已 test.skip**。`PostCompaction.gather()` 被 `49e171bcd` 故意 stub 成 `[]`（退役 runtime-state resend）,該 case 斷言已不存在的 awareness-manifest。skip + 註明 provenance,非 runtime bug。14 pass / 1 skip。

### 🔎 git-blame 定性結果（2026-06-20，2 suspect 皆非真 bug）

逐個追了 runtime intent，兩個行為契約 suspect 確認**都是測試落後，非 runtime 漏寫**：

- `test/session/structured-output.test.ts`（2 fail）→ **test-drift，非真 bug**。enforce guard 仍在（prompt.ts:3010）。失敗時 `[PHASE2] no-anchor provider=openai` 在 guard 之後（:3793）**反覆** log，代表 loop 卡在「未走到 :3020 break」一直重轉。guard 父條件（:2998）要求 `finish ∉ [tool-calls,unknown,other]`，`484772a09` 才把 `"other"` 加入排除；而 mock `plainTextStream` 吐 `finishReason:"stop"` 卻**未提供** anchor/compaction server-side 結構，使近期 `expandAnchorCompactedPrefix` 判 `no-anchor`、該輪不被 finalize。→ **改 mock 補 finish/anchor 結構即可，不動 runtime**。安全 drift。
- `test/server/session-autonomous.test.ts`（3 fail）→ **schema 擴張 drift，gate 邏輯健在**。`resumable`/`blockedReasons` 真值來源 `workflow-runner.ts:317-328` 完整（dormant/in_flight/busy/retry/autonomous_disabled 各自 push）。測試由 `b125b2779` 加入後，`572e2e4cc`/`b8727ca4f`/`174eed7e2` 給 response 增 health/supervisor/anomalies 欄位 → `toMatchObject` 巢狀 shape 落後。**非 resumable 語意翻轉**。改測試前須逐欄位確認 received 值符合 gate 預期（中風險 drift，不盲改）。

**最終結論**：原標的 4 個「real-bug-suspect」git-blame 後只有 **pty 1 個是真 gap（已修）**，working-cache=退役、structured-output=mock 落後、session-autonomous=schema 擴張，**無一傷害產品正確性**。baseline 的核心價值（挖出唯一 security gap）已兌現。

### ✅ 收尾結論（2026-06-20）— 核心價值已兌現，餘 9 檔排 backlog

本次 cleanup 把 baseline 從 **38 → 9 failing**，並完成最重要的一件事：**逐檔 git-blame 把「疑似 4 個 real bug」收斂成「1 個真 security gap（pty 跨 session 輸出洩漏）並修掉」**。

剩餘 9 個 failing 經評估**邊際效益遞減**，全屬以下三類、**無一傷害產品正確性**，排入 backlog：

- **needs-rewrite (5)** — freerun-bridge 架構遷移技術債，建議有人動 bridge harness 時一次性重寫；
- **needs-decision (2)** — enablement profile 廣告語意 / session-resume harness instance-context，屬設計選擇非 bug；
- **env (1)** — 缺 `sst` 套件，裝套件或永久 skip；
- （structured-output / session-autonomous 兩個 drift 已併入上述評估，確認非真 bug，待順手修測。）

**此 issue 的核心任務（找出並修掉真正會傷害產品的 bug）已完成**。剩餘為健康度投資，不阻塞，待排期。

### env (1) — 非 code bug

- `packages/console/app/test/rateLimiter.test.ts` — `Cannot find package 'sst'`（缺依賴,環境 blocker,與舊清單同）。

### needs-decision (2) — 被我從「test-drift」重新定性,需 maintainer 決策,不盲改

- `src/mcp/enablement-tool-keys.test.ts` — 測試正確抓到 enablement.json 的 docxmcp pptx `prefer` 清單（`docxmcp_pptx_read` 等,enablement.json:383-396）廣告了 **default unified profile 不 register** 的工具（server 只暴露 `docxmcp_document`+`docxmcp_stage`,pptx 工具走 `DOCXMCP_TOOL_PROFILE=legacy`）。**決策點**:default profile 該不該廣告 legacy-profile 工具?要嘛改 enablement.json 資料、要嘛測試 model 要納入 profile 概念。非單純 drift。
- `test/server/session-resume.test.ts` — DD-5 busy-skip。runtime（session.ts:884-892）**仍正確**回 `busy_skipped`,測試也**仍期望** `busy_skipped`,但實得 `ok`。root cause:測試 `SessionStatus.set(busy)` 寫的 Instance state 與 route handler `SessionStatus.get` 讀的 AsyncLocalStorage scope **不一致**（harness instance-context wiring）。**需修 harness**讓 set/get 同 instance,非改斷言。

### real-bug-suspect (4) — git-blame + runtime 偵查後重新定性 (2026-06-20)

逐檔追了 runtime intent,4 個只有 1 個是真 gap,1 個確認非 bug,2 個偏合約演進:

- 🔴 `test/pty/pty-output-isolation.test.ts` — **真 gap,需決策**。git blame（`packages/opencode/src/pty/index.ts` send loop @284-304）證明此處曾有 `if (token(ws) !== sub.token) { delete; continue }` 守衛,現已被改成只剩 `sockets.get(ws) !== sub.id`（commit `5f4778250` refactor + 後續）。失敗 case「identity token only on wrapper, Bun reuses raw socket before next onOpen」會穿透 socket.id 相等但 token 不同的縫。屬 **cross-session pty output leak** 的縮窄情境。**決策點**:socket.id 是否被刻意視為足夠身份?若否,需把 token 比對補回 send loop（屬 security/architecture change，需 maintainer 批准）。
- 🟢 `test/session/working-cache.test.ts` — **非 bug = test-drift**。`PostCompaction.gather()`（post-compaction.ts:58-61）被**故意** stub 成 `return []`，配合 `49e171bcd fix(compaction): retire post-compaction runtime-state resend`。測試斷言的是**已退役**的 awareness-manifest 契約（`summaryBody` 應含 L2/L1 counts）。runtime 是對的,測試該改/skip。
- 🟠 `test/session/structured-output.test.ts` — **疑 drift,需小確認**。enforce 守衛仍在（prompt.ts:3010 寫 `StructuredOutputError`）,但 `484772a09` 把 `"other"` 加進 finish 排除清單,且失敗走 `[PHASE2] no-anchor`（anchor-prefix-expand）路徑。fail 源於 mock stream 的 finishReason / anchor 假設與近期 compaction/anchor 改動不符,偏測試落後而非 runtime 漏寫。需確認 plainText mock 的 finishReason 是否該更新。
- 🟠 `test/server/session-autonomous.test.ts` — **合約擴張 + 疑翻轉混合**。`toMatchObject` 失敗主因 received 多出大量新欄位（health / supervisor / anomalies）→ autonomous 子系統近日大改,測試 schema 落後。其中 `resumable`/`applied` 對 `wait_subagent` 的語意翻轉需**單獨**確認是否真 gate regression,不可連同 schema drift 一起盲改。

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
