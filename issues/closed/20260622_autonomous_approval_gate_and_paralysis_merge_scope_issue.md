# Bug Report: 自治監督的「批准閘門 + paralysis 復原」缺陷，與一個未決的 merge 範圍決策

## 0. Handoff Summary

一個 session（`ses_115cfbcf1ffehcVTMsR680zR5M`，docxmcp 專案）被 `ParalysisDetectedError` 強制中止（"Loop halted: 3 consecutive turns repeated the same narrative EVEN AFTER a recovery nudge"）。RCA 確認：模型的**正事其實已完成**（兩個程式修改、測試通過），它是卡在「文件收尾」雜務上，對著一個**被誤標 `needsApproval` 的待辦**原地打轉，最後被 paralysis 偵測器 nudge-then-halt。**關鍵：該 session 不是 autonomous 模式**（`workflow.autonomous.enabled=false`）。

根因是三個疊加缺陷 + paralysis 復原機制。修復已在 beta 分支 `beta/autonomous-gate-enforcement`（plan `harness/autonomous-gate-enforcement`）完整實作、測試綠、fetch-back 到 `test/autonomous-gate-enforcement` 並由使用者重啟 daemon 上線驗證中。**尚未 merge 回 main。**

本 BR 的**核心是一個未決決策**（confirmed bug，fix 已寫好，但 merge 範圍待定）：因為原始事故是 non-autonomous，**真正修好事故的是 DD-3 + DD-4**；**DD-1/DD-2（autonomous 守門）對該事故根本不會觸發**，它是把死設定 `requireApprovalFor` 變成真的會擋的「方向性硬化」。要 merge 全部四個 DD 還是只留 DD-3+DD-4，取決於 **autonomous arming 接下來是保留（runtime-owned）還是整個拿掉**——使用者當下沒時間決定。

**下一個 session 先做**：讀本 BR → 決定 arming 方向 → 線上驗證閘門行為 → 按範圍 merge。

## 1. Bug Identity

| Field | Value |
| --- | --- |
| Title | 自治監督批准閘門假陽性 + paralysis 對閘門誤殺；fix 已實作待定 merge 範圍 |
| Component | `packages/opencode/src/session/` — `todo.ts`、`workflow-runner.ts`、`prompt.ts`(paralysis runloop)、`index.ts`(AutonomousPolicy)、`tool/todo.ts` |
| Reporter | session 接手自 `ses_115cfbcf1ffehcVTMsR680zR5M` halt 事故；pkcs12（cms.thesmart.cc, live） |
| Date | 2026-06-22 |
| Severity | high（自治/續跑 session 會被假閘門 + paralysis 誤殺；交付中斷、需人工接手） |
| Priority | P1 |
| Status | **RESOLVED / CLOSED (2026-06-22)** — fix merged to `main` + 部署上線；arming 已退役回答了 merge 範圍決策。見文末 Resolution |
| Affected paths | 見 Component；plan `plans/harness_autonomous-gate-enforcement/` |

## 2. Environment

- repo：`/home/pkcs12/projects/opencode`（mainRepo，baseBranch=`main`）
- beta worktree：`/home/pkcs12/projects/opencode-worktrees/autonomous-gate-enforcement`（branch `beta/autonomous-gate-enforcement`）
- 目前 main repo **checked out 在 `test/autonomous-gate-enforcement`**（fetch-back 後的狀態，§7.1 step 6）
- daemon：prod 模式，`/usr/local/bin/opencode`，per-user daemon `/run/user/1000/opencode/daemon.sock`，使用者已重啟（binary 重建於 2026-06-22 00:38，pid 21939，health 正常）→ **beta 程式碼目前 live 在 test 分支上**
- main 工作區有**他人 in-flight 未提交 WIP**（`serve.ts`、`server.ts`、`metrics-exporter.ts`(untracked)、`sidebar-items.tsx/.css`、`webctl.sh`/`templates/webctl.sh`、`tool-page.tsx`）——**與本修復零重疊，絕不可動**。
- config 已備份：`~/.config/opencode.bak-20260621-2144-autonomous-gate-enforcement/`
- daemon lifecycle 只可走 `system-manager:restart_self` 或 `webctl.sh restart`（AGENTS.md / CLAUDE.md）

## 3. Expected Behavior

- 一個被標 `needsApproval` 的步驟，runtime 應**確定性地暫停並交還使用者**（或模型有明確「請求批准」的動作），而**不是**讓模型對著一道無法跨越的旗標原地打轉。
- paralysis 偵測器**不得**把「合法的閘門等待」誤判為癱瘓而 nudge-then-halt。
- 文件/收尾類雜務**不得**因為文字含 "architecture/refactor" 等字就被誤標成需批准。
- Invariant：「能標一道門，就必須同時給跨越它的鑰匙；守門由 runtime 執行，不甩給模型自由心證。」
- 絕不可發生：模型在沒有可執行出口的情況下被偵測器當成 stuck 殺掉。

## 4. Actual Behavior

- `ses_115cfbcf…` 在收尾階段：待辦 `驗證合併 + architecture 同步 + 結 issue + event 收尾` 被推斷為 `action.kind=architecture_change / needsApproval=true`。
- 模型連續多輪重述「architecture sync + close issues + event wrap-up」，但**只讀檔不寫檔**（碰到要寫的點就退回）。
- paralysis 偵測器在一次 nudge 後仍偵測到重複 → halt，session 中止。
- 該 session `autonomous.enabled=false`（**非自治**）——所以它不是被自治續跑引擎推著跑的，而是被 subagent-completion 續跑 + 使用者「繼續」推進，最後撞上 paralysis。

（早段另有一次 ~10 輪空轉：specbase `plan_create`/`event_record` 的 `repo=docxmcp` 靜默失敗——屬不同類，已由當時的 recovery nudge 救回。）

## 5. Steps To Reproduce

`Suggested reproduction`（事故本身依賴特定對話脈絡，以下為等效最小重現）：

1. 在 `packages/opencode` 跑 `bun test src/session/todo.test.ts`（修復前）：`inferActionFromContent({content:"schema migration refactor", status:"pending"})` → 預期得到 `architecture_change/needsApproval`（這就是假門來源）。
2. 一個續跑中的 session，待辦文字含 "architecture"，模型認知到「需批准」但無批准動作 → 多輪只讀不寫。
3. 觀察 paralysis runloop（`prompt.ts:~2822` 偵測點）在 nudge 後仍判定重複 → `ParalysisDetectedError`（`prompt.ts:~2948`）。

**修復後驗證重現**見 §11 / §13。

## 6. Evidence

| Evidence | Type | Reference | What it shows |
| --- | --- | --- | --- |
| E1 | session 紀錄 | `ses_115cfbcf1ffehcVTMsR680zR5M`（docxmcp）`info.json` | `autonomous.enabled=false`、`state=waiting_user`、title「盤點未解BR」、halt 事實 |
| E2 | code | `packages/opencode/src/session/todo.ts:61-94`（假門分支原 :75-83） | `architecture_change` 關鍵字推斷 → `needsApproval=true` |
| E3 | code | `packages/opencode/src/session/workflow-runner.ts:637-640` | "No pre-emptive gates. AI decides on approvals itself" — 死設定的證據 |
| E4 | code | `packages/opencode/src/session/index.ts:196,427` | `requireApprovalFor` 預設含 `architecture_change`、從未被讀取執行 |
| E5 | code | `packages/opencode/src/session/prompt.ts:~2822`(偵測)、`~2894-2960`(nudge/halt)、`468-483`(`selectParalysisNudge`) | paralysis 偵測→單次 nudge→halt 的階梯 |
| E6 | code | `packages/opencode/src/session/prompt.ts:1584,1645` | 口頭 arming 仍 live（`detectAutorunIntent`→`updateAutonomous enabled:true`） |
| E7 | commit | `273db4a2b`（2026-06-22 01:22） | 退役「per-prompt `autonomous` 旗標」，改 runtime-owned；**非**關閉 arming |
| E8 | plan | `plans/harness_autonomous-gate-enforcement/`（proposal/design/spec/tasks/idef0/grafcet…） | 完整 4-DD 設計 + DD-5；tasks 勾選狀態 |
| E9 | git | `beta/autonomous-gate-enforcement` 5 commits：`f7741cb`(DD-3) `86b0c58`(DD-1/2) `a96b203`(DD-4+2.4+discoverability) `e81845f`(2.7 整合測試) | 實作落點 |
| E10 | test | `packages/opencode` `bun test`：workflow-runner 40 / todo / model-orchestration / src/tool 92 / 整合測試 → merged 後 159 pass 0 fail | 驗證綠 |
| E11 | test(已知紅) | `test/server/session-autonomous.test.ts` 3 reds | **clean main 上即存在**（baseline 確認），非本修復造成；`tasks.md` 4.1 有平行修復嘗試（`wait_subagent`/`message.parts`）——採用前須驗證 |

## 7. Impact / Risk

- **使用者可見**：自治/續跑 session 在無真實阻擋的情況下被中止，需人工接手；交付被打斷。
- **可靠性**：「假門 + 偵測器誤殺」會反覆發生在任何待辦文字命中關鍵字、或任何 advisory 旗標模型無法行動的情境。
- **資料**：無資料毀損風險（事故 session 的程式修改本身是好的）。
- **blast radius**：所有走 paralysis runloop 的 session（含 non-autonomous）；以及未來任何被標 `needsApproval` 的自治步驟。
- **安全**：DD-3 移除誤判後，真正危險動作（push/destructive）仍在 tool-permission 層被擋——無安全降級。

## 8. Root-Cause Hypotheses

### H1：假門（architecture_change 關鍵字推斷）是模型「看到一道過不去的鎖」的來源
Confidence: high（已確認）
- 為何可信：E2 + E1（事故待辦文字含 "architecture"）；DD-3 移除後 `todo.test.ts` 斷言翻轉通過。
- 如何確認：修復前後跑 `todo.test.ts`；對事故原文字串斷言不再 gate。
- 如何反駁：若移除後模型仍 dither → 來源不只假門。

### H2：paralysis 復原對「閘門等待」無效且會誤殺
Confidence: high
- 為何可信：E5；nudge = 對同一模型/同一脈絡再注入文字，對「缺的是鑰匙不是建議」的卡死結構上無效。
- 如何確認：DD-4 `isGateSuspended` 為真時偵測器讓路（TV-7）。
- 如何反駁：找到 nudge 確實救回 gate-induced dither 的案例。

### H3（範圍關鍵）：DD-1/DD-2 不是本次事故的失敗路徑
Confidence: high
- 為何可信：事故 `autonomous.enabled=false`（E1）；`planAutonomousNextAction` 在 `enabled=false` 時 early-return `not_armed`，DD-1/DD-2 閘門根本跑不到。
- 推論：**事故修復 = DD-3 + DD-4**；DD-1/DD-2 是把死設定變活的方向性硬化，與「autonomous 改 runtime-owned」（E7）一致，但非事故必需。
- 如何確認：在 non-autonomous session 重跑事故等效情境，只 DD-3+DD-4 即可避免 trap。

## 9. Workarounds

- 暫時：使用者「繼續」推進被卡 session（事故當下即如此，但會再撞 paralysis）。
- 暫時：避免待辦文字使用 "architecture/refactor/schema/migration" 等字（治標，不可靠）。
- 不建議長期依賴上述任一。

## 10. Proposed Fix Direction

已實作於 `beta/autonomous-gate-enforcement`（待決定 merge 範圍）：

- **DD-3（事故必需）**：移除 `inferActionFromContent` 的 `architecture_change` 關鍵字分支；保留 push/destructive。
- **DD-4（事故必需）**：`prompt.ts` paralysis runloop 在 nudge/halt 前，若 `isGateSuspended`（待辦 `awaiting_approval` 或 workflow `waiting_user:approval_needed`）則讓路、不計入階梯、不 halt；真正無門空轉仍 halt（backstop 保留）。
- **DD-1（方向性硬化）**：`requireApprovalFor` 在 `planAutonomousNextAction` 變成真的會擋 → 確定性暫停 `waiting_user:approval_needed`（重用 `NON_RESUMABLE_WAITING_REASONS`），不 disarm autonomous。含 2.4 idempotency（不雙重暫停）。
- **DD-2（方向性硬化）**：保留 todo 狀態 `awaiting_approval` 當模型的交還鑰匙，走同一條暫停路；todo 狀態 schema 文件已標示供模型發現。
- **DD-5（語意）**：批准 = 使用者重新介入（R5 disarm → 互動式完成該步），閘門刻意**不自動重啟 autopilot**（human-in-the-loop, safe-by-default）。

相容性：`index.ts` 預設 `requireApprovalFor` 已去掉 `architecture_change`（死值）；`architecture_change` enum 值保留無害。

## 11. Acceptance Criteria

- 正向：non-autonomous 續跑 session，待辦含 "architecture" → **不**被標 needsApproval、**不**被 paralysis 誤殺（DD-3+DD-4）。
- 正向（若採 DD-1/2）：armed session + push/destructive 待辦 → 確定性暫停 `waiting_user:approval_needed`，不 dither、不 halt。
- 正向（若採 DD-2）：模型設待辦 `awaiting_approval` → 同樣乾淨暫停。
- 反向/回歸：真正無門的「同工具同參數」空轉 → paralysis **仍**會 halt（backstop）。
- 反向：`requireApprovalFor=[]` → 不暫停（證明設定是活的）。
- 測試：`bun test src/session/{workflow-runner,todo,model-orchestration}.test.ts src/tool` + `test/server/session-autonomous.test.ts -t "approval gate suspends"` 全綠；3 個既有紅須與 clean main baseline 比對確認非本修復造成。

## 12. Open Questions

1. **（主決策）autonomous arming 接下來保留（runtime-owned）還是整個拿掉？**
   - 保留 → merge 全部 4 DD（DD-1/2 即 runtime-owned 守門，方向一致）。
   - 拿掉 → DD-1/DD-2 變死碼，merge 只留 DD-3 + DD-4。
   - 第三條：先只 merge DD-3+DD-4，DD-1/2 留 beta 待 arming 拍板。
2. 使用者提到「paralysis fix applied」——是否有**平行 track** 另外改了 paralysis？需與本 beta 的 DD-4 對齊，避免雙重/衝突。
3. `tasks.md` 4.1 記錄的「修 session-autonomous 3 reds（wait_subagent/message.parts）」是否已實際落在某分支？採用前須驗證來源與正確性。
4. `requireApprovalFor` 是否該連 push/destructive 也完全交給 tool-permission 層（避免雙重守門）？目前決定保留（DD-3 lock）。

## 13. Next Session Checklist

1. **先讀**：本 BR；`plans/harness_autonomous-gate-enforcement/proposal.md` + `design.md`（DD-1..5）+ `tasks.md`。
2. **回憶事故**：session `ses_115cfbcf1ffehcVTMsR680zR5M` 的 `info.json`（確認 `autonomous.enabled=false`，支撐 H3）。
3. **定決策**：Open Question #1（arming 方向）→ 決定 merge 範圍。
4. **看程式**：`workflow-runner.ts:568-646`(`planAutonomousNextAction` + `isAutonomousApprovalGated`)、`isGateSuspended`；`todo.ts:61-94`；`prompt.ts:~2822` 的 DD-4 guard。
5. **跑驗證**：`cd packages/opencode && bun test src/session/workflow-runner.test.ts src/session/todo.test.ts test/server/session-autonomous.test.ts`；確認 3 reds 為既有（與 clean main 比對）。
6. **線上驗**（daemon 已是 test 分支）：arm 一個 session 丟「delete old snapshots」→ 應乾淨暫停 `waiting_user:approval_needed`；待辦設 `awaiting_approval` → 同；待辦寫「architecture 同步」→ 不被假門卡。
7. **若批准 merge**（beta-workflow §7.3，需使用者明確點頭）：`test/autonomous-gate-enforcement` → `main`（按範圍可能先 revert/不取 DD-1/2 的 commit）；刪 `beta/`+`test/` 分支；移除 worktree `/home/pkcs12/projects/opencode-worktrees/autonomous-gate-enforcement`；graduate spec 至 `/specs/`。
8. **絕不可動** main 工作區那批他人未提交 WIP（serve.ts/server.ts/metrics-exporter/sidebar/webctl）。
9. **停止點**：merge 範圍決定 + 線上驗證通過 + 使用者明確批准前，不 merge 回 main。

## Related

- Plan/spec：`plans/harness_autonomous-gate-enforcement/`（state=implementing）
- 實作分支：`beta/autonomous-gate-enforcement`（5 commits）；fetch-back 分支：`test/autonomous-gate-enforcement`
- 相關既有 spec：`specs/harness/autonomous-opt-in`（R5「blocker→disarm」是本修實作的契約）；姊妹類 `specs/question-tool_idle-watchdog-false-kill`（看門狗誤殺合法暫停）
- 退役脈絡：commit `273db4a2b`（per-prompt autonomous 旗標 → runtime-owned）

---

## Resolution (2026-06-22)

> **⚠️ CORRECTION (2026-06-22, post-graduation review)** — 本 Resolution 早先寫的「DD-1/DD-2 為 inert 死碼」**結論錯誤,已作廢**。該判斷下在 DD-8(commit `2c4a830c2`)落地**之前**。DD-8 把 **subagent-completion 續跑路徑(orchestrator 自我派工,`task_completion`/`task_failure` trigger)重新導去走批准閘門,且該路徑 arm-independent**(不受 `autonomous.enabled=false` 影響)。DD-8 並加了測試 `"explicit awaiting_approval handback suspends even on a subagent-triggered unarmed turn"` 斷言閘門在此暫停。實證:把 DD-1/2 移除會讓該 DD-8 測試失敗(2026-06-22 驗證)。**∴ 四個 DD 全部 live、互相咬合,DD-1/2 不可移除(DD-8 依賴它們)。** 下方 §Final RCA / §Fix Implemented / §Follow-ups 中所有「inert/死碼/可清理」字樣均以本更正為準。

### Resolution Status
**RESOLVED / CLOSED.** Fix merged to `main` 並部署上線（prod binary `/usr/local/bin/opencode` 重建於 2026-06-22 16:31）。beta worktree 已移除、beta 分支收尾完成。fetch-back/merge/cleanup 在本 BR 開立後由 Raw1mage 完成。

### Final RCA（確認版）
- **H1（假門）確認**：`architecture_change` 關鍵字推斷是模型「看到過不去的鎖」的來源。DD-3 移除後，事故原文字串不再被標 needsApproval。
- **H2（paralysis 對閘門無效且誤殺）確認**：DD-4 `isGateSuspended` 讓偵測器對合法閘門等待讓路；backstop（真正無門空轉仍 halt）保留。
- **H3（DD-1/DD-2 非「事故」路徑）部分確認，但「inert」推論已被 §CORRECTION 推翻**：原始事故(`ses_115cfbcf`)確為 non-autonomous,有效修復是 **DD-3 + DD-4**。但 **DD-1/DD-2 並非死碼**——commit `2c4a830c2`(DD-8)雖確認 verbal arming 退役(`triggerPhrases:[]` → `autonomous.enabled` 釘死 false),卻同時把 **subagent-completion 續跑(arm-independent)導去走 DD-1/2 的閘門並依賴 `awaiting_approval`**。故 `planAutonomousNextAction` 的 early-return `not_armed` 只擋「plain user prompt」這一路;orchestrator 自我派工那一路照樣到閘門。**DD-1/2 在 main 上是 live 且 load-bearing。**

### Fix Implemented（main 上的相關 commit）
- `f7741cb2e` — DD-3 移除 `architecture_change` 關鍵字假門（保留 push/destructive）。**事故有效修復。**
- `a96b203ad` — DD-4 paralysis 對閘門讓路（`isGateSuspended`）+ 2.4 idempotency + `awaiting_approval` 可發現性。**事故有效修復。**
- `86b0c58de` — DD-1/DD-2 runtime 守門 + `awaiting_approval` 鑰匙。**live 且 load-bearing**:DD-8(`2c4a830c2`)的 orchestrator 自我派工續跑(arm-independent)正站在此閘門上,依賴 `awaiting_approval` 暫停。**不可移除。**
- `e81845f69` — 2.7 整合測試。
- **平行加碼（非本 plan，Raw1mage 另修）**：`22d5e3a81` fix(paralysis) — 修**另一類**卡死（hallucinated/dropped tool name → 'invalid' sink 假成功 → 幽靈名字無限重試；來自 `ses_115c28b4`，與本 BR 的 `ses_115cfbcf` 不同）；同改 `prompt.ts` paralysis 區，與 DD-4 共存（測試綠）。`2c4a830c2` DD-8 — autorun 退役導致 subagent-completion 續跑被 `not_armed` 卡死的回歸修復。

### Verification Results
- 我的 4 個 commit 皆為 `main` HEAD 祖先（`git merge-base --is-ancestor` 全 ✓）。
- `cd packages/opencode && bun test src/session/todo.test.ts src/session/workflow-runner.test.ts` → **67 pass / 0 fail**。
- deployed prod binary 重建於 main（含全部上述 commit），時間晚於 DD-8（11:48）→ 部署涵蓋。
- **驗證缺口（誠實標註）**：未對 live daemon 跑行為級 e2e（且 arming 已退役，自治路徑本就不易現場觸發）。確認層級＝**code-on-main + 單元/整合測試綠 + binary 部署**，非 live 行為 e2e。

### Follow-ups / Residual Risk
1. **DD-1/DD-2 不可移除（live, DD-8 依賴）**：2026-06-22 曾嘗試「清掉 inert DD-1/2」,移除後 DD-8 測試立刻失敗,已全數還原。任何後續若想精簡此區,必須先處理 DD-8 對 `awaiting_approval` 閘門的依賴。
2. **DD-4 × `22d5e3a81` 的組合**：兩者同改 paralysis runloop / `selectParalysisNudge`，測試綠但建議 reviewer 確認兩縫組合無互蝕。
3. **plan `harness/autonomous-gate-enforcement` 生命週期**：2026-06-22 更正「inert」結論後 graduate 至 `/specs/harness/autonomous-gate-enforcement`（四 DD 皆 live、DD-8 依賴 DD-1/2 的事實已寫入 design.md）。
4. 相關平行 issue（同日新開）：`issues/issue_20260622_orchestrator_no_autocontinue_*`、`issues/closed/issue_20260622_execution_mode_subagent_continuation_arm_gated.md` 等——皆 arming 退役後的續跑回歸線，與本 BR 同源脈絡，已各自處理。
