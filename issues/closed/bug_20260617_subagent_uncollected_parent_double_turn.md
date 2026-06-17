# BUG: subagent 未乾淨回收後，主 session agent 回應/動作重複兩次（"兩個靈魂"）

- **日期**：2026-06-17
- **回報者**：ismsworks 母礦蒸餾 session（ses_12af24a06ffeb…，多輪 task() 派工場景）
- **嚴重度**：high（破壞主對話完整性；使用者體感為「同一 session 有兩個 agent 同時對話」）
- **元件**：subagent 完成通知管線 — `task.ts` task.completed re-fire + `pending-notice-appender` + parent auto-resume

## 摘要

當一個 subagent（`task()` 派出）**完成後沒有被乾淨回收**（parent 沒有透過 `read_subsession` 消費那則 PendingSubagentNotice，或 notice 的「consumed exactly once」契約被破壞）後，**主 session 的 agent 之後每一個 turn——不論是執行工具動作還是輸出文字——都會重複兩次**，像是同一個 session 裡有兩個靈魂在平行跑、各自對使用者講一遍同樣的話、做一遍同樣的事。

## 重現情境（本 session 實際觀測）

```
1. 主 agent 連續派多個 subagent：task(M1 結構蒸餾) → 完成；task(M2 standards) → 完成
2. 每次只憑 system-prompt 那行 "[subagent ses_… finished status=success" 就繼續，
   未呼叫 read_subsession 真正消費 notice（= 未乾淨回收）
3. 此後主 agent 多個 turn 的「回應尾段」明顯整段複述：
   - M1 收尾 turn：先講完一次總結，又把同一份「本輪成果 / 進度全景 / 待續」整段再輸出一次
   - M2 收尾 turn：同樣的雙份輸出
4. 工具動作層也疑似雙跑（同一 turn 內出現語意等價的重複操作傾向）
```

使用者描述原文：「主對話的 agent 不管是做事還是說話，都會重複兩次，像是有兩個靈魂在同一個 session 中和我對話」。

## 根因假設（已定位源碼）

`packages/opencode/src/tool/task.ts` 約 518–529 行的 **"THE FIX"** 區塊（為 `issue_20260611_3r-orphans-active-subagent-eternal-wait` 引入）：

```ts
// ── THE FIX: deliver a terminal notice through the canonical pipeline …
// Re-fire task.completed so pending-notice-appender both appends a
// PendingSubagentNotice to the parent AND auto-resumes the parent runloop.
await Bus.publish(TaskCompletedEvent, { jobId: toolCallID, … })
```

這條 `task.completed` 的單一事件**同時**驅動兩個副作用：

1. **append** 一則 PendingSubagentNotice 到 parent info.json
2. **auto-resume** parent runloop

設計上靠 `jobId` 冪等（appender latest-wins 取代）來保證只跑一次。但**疑似的缺陷**：當 notice 的消費端（prompt assemble 的 drain / responsive-orchestrator R2「consumed exactly once」）與 re-fire 路徑競態時，**auto-resume 被觸發了兩次**——一次來自正常完成 promise、一次來自 registry re-fire（orphan reconcile 路徑），兩者沒有對 parent 的「本輪續跑」做互斥，於是 parent runloop 被拉起兩份，產生重複的 assistant turn。

相關交叉點（同檔）：

- `task.ts:2402` disk-terminal → task.completed → pending-notice-appender
- `task.ts:2518-2519` responsive-orchestrator R2 emit task.completed
- `session/index.ts:411` pending-notice-appender 在此 append；prompt assemble drains

兩條 emit 路徑（正常完成 vs registry re-fire / R2）若都抵達且 dedup 只作用在「append」層而非「auto-resume」層，就會雙重續跑。

## 預期 vs 實際

|      |                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------ |
| 預期 | subagent 完成 → 恰好一則 notice → parent 恰好續跑一個 turn（consumed exactly once）              |
| 實際 | 未乾淨回收 + 雙 emit 路徑 → parent runloop 被拉起兩次 → 主 agent 每個後續 turn 文字/動作重複兩遍 |

## 建議調查方向

1. **分離冪等域**：append 的 latest-wins dedup（by jobId）與 auto-resume 的觸發應**各自**冪等。目前 dedup 似乎只保護 append；auto-resume 需要獨立的「per-jobId 只 resume 一次」鎖（已 resume 的 jobId 不再 resume）。
2. **consumed-exactly-once 強化**：notice 被 drain 後應標記 consumed，re-fire 路徑命中已 consumed 的 jobId 時**只補 append、不再 auto-resume**。
3. **parent runloop 重入防護**：parent 若已有一個 in-flight turn（因前一個 resume 觸發），第二個 resume 訊號應 coalesce 進同一 turn，而非起新 turn。
4. **檢查 3R / daemon restart 與正常完成的雙觸發窗**：THE FIX 註解自承「detached completion promise … died with the old daemon，registry re-fire 補救」——需確認**正常情境（daemon 沒重啟）**下，completion promise 與 registry 是否可能都活著、都 fire。

## 影響範圍

任何多次 `task()` 派工且主 agent 未逐一 `read_subsession` 回收的 session。一旦觸發，污染後續整段對話（所有 turn 雙寫），使用者無法分辨哪一份是真實狀態，且可能導致重複的副作用操作（重複 edit / 重複 event_record）。

## Workaround（暫行）

主 agent 在收到 `[subagent … finished` notice 後，**立即 `read_subsession` 消費**再繼續，降低未乾淨回收觸發此 bug 的機率（本 session 後段已改採此紀律）。但這是迴避，非修復——核心仍是 auto-resume 的雙觸發需在 runtime 層收斂。

## Root Cause（確認 2026-06-17，精煉自原假設）

偵查推翻了本 BR 原推測的「正常情境雙 emit」。實際因果鏈分兩種場景：

1. **正常完成路徑不會雙 emit**：worker 正常完成時 `task.ts:949` 在 `worker.done` 當下即
   `registryRemove(toolCallID)`，**先於** background watcher 的 emit（`task.ts:2637`）。故
   orphan-reconcile 路徑（emit B, `task.ts:531`）只在 **daemon restart** 才觸發，daemon 未重啟時不會。
2. **正常情境雙跑的真正機制 = auto-resume 缺冪等 + 殘留 synthetic message**：
   `pending-notice-appender` 對單一 `task.completed` 事件做兩件事——append notice（**有** latest-wins
   冪等 by jobId）與 auto-resume（**完全無** per-jobId 冪等）。每個 subagent 完成都
   `enqueueAutonomousContinue` → 新建一則**持久** synthetic user message
   (`"Subagent J finished. Drain pending notices and continue."`)。但 prompt.ts drain 是 atomic
   一次清空所有 notice（`prompt.ts:3787`）。於是第一個 resume 的 turn 就把 notice 全清，**而那些
   synthetic user message 仍持久留在 SQLite**。runloop 每輪重新 stream 全部訊息，這些殘留 synthetic
   user 訊息持續驅動 parent，對著「已無 notice 可 drain」的提示一再重生等價總結 → 使用者體感
   「每個 turn 文字重複、兩個靈魂」。

冪等域分離不足是本質缺陷：append 與 auto-resume 是兩個獨立冪等域，舊碼只保護前者。

## Resolution（2026-06-17）

三管齊下，落點 `pending-notice-appender.ts` + `session/index.ts` + `prompt.ts`：

1. **per-jobId auto-resume 冪等鎖（DD-1/DD-3）**：session info 新增持久欄位
   `resumedSubagentJobIds: string[]`（bounded FIFO，上限 64）。appender 在 lock-serialized
   `Session.update` 內**原子認領** jobId；已認領者只 append、顯式 log skip、不 resume。持久化（非
   in-memory）因為 re-fire 路徑正是 daemon restart。
2. **coalesce（DD-5）**：appender 若偵測 parent 已有 pending continuation（`getPendingContinuation`），
   不再新建第二則 synthetic message——RunQueue per-session replace 保證單一 queued turn 會一次 drain
   所有 notice；僅補一次 resume tick。
3. **consumed-once（DD-2）**：prompt.ts drain 時把已消費的 jobId 併入 `resumedSubagentJobIds`，使任何
   被 turn 消費過的 notice 之後 re-fire（含 daemon restart orphan reconcile）也只 append、不 resume。

**回歸測試**：`packages/opencode/src/bus/subscribers/pending-notice-appender.test.ts`（4 pass）——
同 jobId 雙 fire 只 resume 一次、雙 jobId coalesce 不疊加、已 resume jobId 跳過、ledger bounded FIFO。
typecheck 乾淨（僅 pre-existing freerun-bridge baseline 錯誤無關）。bus subscribers 套件 7 pass 無回歸。

**Plan package**：`plans/bugfix_subagent-double-turn/`（state=implementing，13 artifacts 驗證綠，
GRAFCET 經 drawmiat canonical 驗證）。

**未 commit、未端到端 restart 驗證**（需使用者批准）。
