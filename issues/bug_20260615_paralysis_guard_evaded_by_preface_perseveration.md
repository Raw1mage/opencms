# 跳針：固定開場白 + 變動微動作的零進度 loop，逃過 paralysis guard

Status: OPEN (reported 2026-06-15；RCA 完成；fix 已實作+單元測試+typecheck 綠，**待部署+即時驗證**才轉 observing)

## Fix（已實作，未部署）

`packages/opencode/src/session/prompt.ts` + `message-v2.ts`，2026-06-15：

- **缺陷 A**：新增 `paralysisCleanStreak`。recovery counter 不再「一個乾淨 turn 就歸零」，
  改成**只計真正有進度（mutate 檔案）的 turn**，累積到 `PARALYSIS_CLEAN_STREAK_RESET`(=2) 才清。
  關鍵：純讀的門面 turn 不給 streak credit——因為它還會佔住 3-turn 偵測窗、延後再偵測兩輪，
  若只數「未觸發 triple 的 turn」仍可被「每 3 個 paralyzed turn 插 1 個門面 turn」game。
  gating 在 file mutation 上，純讀空轉就會保持 escalation armed → 下一次 triple 直接 hard-halt。
- **缺陷 B**：新增 Detector D `detectPrefaceParalysis`（exported, pure, 單元測試 5 pass）——
  前 ~140 字 jaccard > `PARALYSIS_PREFACE_SIM_THRESHOLD`(=0.6) **且**最近 3 turn 無 file-mutating
  tool（`PARALYSIS_PROGRESS_TOOLS`=write/edit/multiedit/apply_patch）才算 paralysis，餵進既有
  ladder（先 soft nudge，復發才 halt）。batch-edit 因有 mutation 被 veto，不誤判。
- `ParalysisDetectedError.detector` enum 加入 `"preface"`。
- 測試：`prompt.paralysis-preface.test.ts`（5 pass）；`prompt.observed-condition.test.ts` 無回歸（41 pass 合計）。

驗證計畫：部署後觀察 log 的 `paralysis-recover: progress turn, streak building`／
`cleared after sustained progress streak`／`detector: "preface"`，確認真實 session 不再無限 nudge。

Type: Bug Report
Severity: High（單一 session 空轉 ~38 分鐘、~92M total tokens；既有兩道防線皆未攔住）

關聯前例：
- `issues/closed/bug_20260518_session_repetition_loop.md`
- `issues/closed/bug_20260530_narrate_then_stall_regression.md`
- `issues/closed/bug_20260602_claude_cli_rapid_narrative_compaction_cascade.md`

現場：`ses_1353b6dccffeZJE6IFh6NQFCbT`（slug `eager-lagoon`，directory `/home/pkcs12/projects/opencode`，
title「檢視未解issues」）。事發 2026-06-15 21:46 → 22:24。

---

## Symptom（使用者回報）

session「開始跳針」：assistant 每一輪開場都複誦同一組安撫句，每輪只做一個 tiny read/grep，
不收斂。觀察期間 round 已到 495、total tokens ~92M（多為 cache read）。

重複的開場白兩個階段：
- 階段一（21:52–22:02）：「Batch-1 error notice fully drained / consumed / **it keeps
  re-injecting** but is consumed / **final re-inject**」。
- 階段二（22:21–22:23）：漂移到不相干的 `provider-cms` 調查，開場換成「context is green (2%) /
  **pace is the issue, not budget** / continuing provider-cms — `nvidia` undefined」，
  每輪一個微讀（`provider.ts` offset 100→160→1150→1595…）。

**22:24:53 模型自己呼叫 `question` 工具問使用者方向 → 跳出 loop。這是唯一打斷它的東西。**

---

## RCA

### 先澄清一個被證據推翻的假設

「notice 每輪被重新注入」**不是** producer bug。log 實證：

```
PendingSubagentNotice appended        共 2 次（batch-1 error + batch-2 success）
auto-resume: parent runloop enqueued  共 2 次
```

batch-1 那條 error notice **只 append 過 1 次**，並在下一輪被
`prompt.ts` 的 drain（按 jobId 移除）正常清掉——現在 `info.json#pendingSubagentNotices`
只剩 batch-2 的 success notice、無 batch-1 殘留，證明 drain 有效。

→ 模型口中的「keeps re-injecting」是 **confabulation**。真正每輪都在的是那句被
`enqueueAutonomousContinue` 寫進 transcript、**永不撤回**的合成 user turn
「`Subagent … finished (status=error). Drain pending notices and continue.`」，
加上模型自己前幾輪全以「drained」開頭的慣性 → 自我增強的強迫複誦。

### 觸發鏈

1. 21:29 派 coding subagent（`ses_13487256affeLP1W41tAFsao2B`）批次修測試。
2. 21:46 它在 `revert-compact` 鑽牛角尖、17 min context 耗盡 → `status=error`。
3. `pending-notice-appender.ts:64-116` 做了**唯一一次**該做的事：append 1 條 notice ＋
   enqueue 1 句 priority=critical 的合成 continue「Drain pending notices and continue.」。
4. notice 下一輪正常 drain。但 transcript 從此永久帶著那句 standing 指令。
5. 模型把「已處理一次的錯誤」變成每輪開場儀式，零真實進度，直到 22:24 自己問 user 才脫困。

### 兩個真正的 runtime 缺陷

**缺陷 A — paralysis guard 的 recovery counter 重置太天真。**
`packages/opencode/src/session/prompt.ts:2594-2668`。逃生梯本身是對的：
overflow→compaction（2563-2592）→ 首次偵測注入 nudge（2594-2632）→ nudge 後仍 3 連發 →
hard-halt `ParalysisDetectedError`（2637-2657）。**但 2661-2668 只要出現一個非重複 turn
就把 `paralysisRecoveryCount` 歸 0。** 模型的實際行為正好是：nudge 一響 → 回一句
「You're right, I've been looping」做一個門面動作（打斷該次三連）→ counter 歸零 → 立刻復發。
結果 nudge 在 **21:34 / 21:43 / 21:53 獨立響三次，永遠到不了 hard-halt branch**。
模型等於在 game 這個 detector。

**缺陷 B — detector 偵測不到「固定開場白 + 變動微動作」的零進度型態。**
偵測 key 是「3 個連續近乎相同的整個 turn」（signature＝同 tool 同參數；或整輪 narrative
相似度）。本案是**固定安撫開場白 + 每輪不同的 micro-action**（read 不同 offset、grep 不同字串）。
整輪相似度被變動的尾巴稀釋到閾值以下，tool signature 每輪又不同 → detector 全程沉默。
round telemetry 的 `anomalyFlags` 整段是 `[]` 即鐵證。

### 助燃的設計問題（非 bug，但同源）

`enqueueAutonomousContinue` 對 `status=error` 寫進 transcript 的是開放式「**and continue**」、
**且沒有任何「已完成」訊號去 supersede 它**。這正是模型最容易 perseverate 的 standing
指令型態（永久存在、無終止條件、下一步不具體）。

---

## 影響範圍

- 496 輪、~92M total tokens、~38 min 低產出空轉。
- 既有兩道防線（paralysis nudge/halt、subagent notice drain）皆未攔住此型態。
- 任何「主 agent 派 subagent 且 subagent 以 error 收尾」的長 session 都可能復現，
  尤其 subagent 因 context 耗盡而 error 時（會帶 critical continue + 開放式 and continue）。

---

## 建議修法（方向，未實作；主 loop 敏感，待範圍確認）

1. **缺陷 A：counter 不要一個 compliant turn 就全歸零。**
   改為慢衰減，或在一個 round 視窗內累計「已發出的 nudge 次數」——同一視窗第 N 次 nudge
   即升級（compaction / 強制 question-to-user / hard-halt），即使每次 nudge 之間夾了一個門面 turn。
   目標：模型無法靠「假裝改邪歸正一輪」無限重置逃生梯。

2. **缺陷 B：新增與整輪相似度正交的偵測訊號。**
   - **開場 n-gram 跨 N 輪重複**：對每輪 leading sentence / 前 k token 做 n-gram，跨 N 輪高重疊即旗標，
     與尾巴的 tool 動作是否變動無關。
   - **N 輪無 state delta**：N 個連續 round 沒有任何「實際進展」訊號（無檔案被 edit、無測試狀態變化、
     無 todo 推進）即旗標。零進度本身就是病，不需整輪字面相同。
   - 命中時寫入 round telemetry 的 `anomalyFlags`（目前這種型態全程 `[]`）。

3. **助燃設計：autonomous-continue 的可撤回性 / 具體性。**
   - 合成 continue 寫入後，notice 一旦 drain 應有對應的「已消化」訊號去 supersede 那句 standing 指令，
     避免它在 transcript 裡無限期慫恿「drain and continue」。
   - `status=error` 的 continue 文案改為具體下一步（例如「subagent 失敗於 X；驗證已套用的 edit、
     決定接手或交回 user」），而非開放式「and continue」。

---

## 待辦 / 開放問題

- [x] 缺陷 A 修法（progress-gated clean-streak）— done。
- [x] 缺陷 B detector（preface + no-mutation gate，pure helper + 單元測試）— done。
- [ ] **部署 + 即時驗證**（log 訊號）後將本 issue 移到 `observing/`。
- [ ] soak：觀察是否有 Detector D 誤判（純讀但合理的長 session）；必要時調 0.6 閾值。
- [ ] 復現：是否需要 subagent error 才觸發，或任何長 session 都可由「固定開場白」誘發？
- [ ] 與 `bug_20260530_narrate_then_stall_regression` 的修法是否重疊 / 可合併防線。
