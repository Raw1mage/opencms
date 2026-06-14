# Bug: 使用者的短答覆「A」未進入下一輪 context assembly → AI 重問已回答的問題(referential short-answer dropped;narrative-compaction seam 的第二種破壞形態)

- **Date**: 2026-05-31
- **Severity**: Critical(使用者**已送達**的決策答覆在下一輪對 AI 不可見,AI 因此重問同一題。這比單純 anchor lag 更嚴重:不是「AI 記憶落後於磁碟」,而是「**使用者當輪輸入被靜默吞掉**」。在任何 question→answer 驅動的工作流會造成決策死鎖、無限重問、使用者信任崩潰。使用者明確指出「這是嚴重系統問題的冰山一角」)
- **Component**:
  - narrative compaction 產生器(把歷史壓成 `prior_context` narrative 注入 prompt 的那層)
  - claude-cli provider context assembly(組裝「壓縮 anchor + 自上次壓縮以來的 verbatim 新訊息」成模型可見 prompt)
  - 兩者之間「哪些訊息已被 anchor 涵蓋 / 哪些必須以 verbatim tail 補上」的 cursor 契約
- **Status**: CLOSED — original compaction-seam RCA was disproven; later step-loop/context refactors superseded the suspected path.
- **關聯**: `bug_20260531_narrative_anchor_lag_vs_session_db_truth.md`(原以為同一 seam;**證偽後兩者的 compaction-seam 歸因皆不成立** — 見 §0 + §4)

---

## 0. RCA 修正 — compaction-seam 歸因經程式碼層證偽(2026-06-01)

> 本報告原由 llmserver session 內觀察寫成,作者無 opencode compaction pipeline 程式碼 access,RCA 停在「對話可觀測證據」層並推測為 context-assembly seam。2026-06-01 在 opencode repo 內讀完完整 context 組裝控制路徑後,**原 RCA 三條指控全部與程式碼矛盾**:

| 原報告指控(§2.3 / §3) | 實際程式碼 | 判定 |
|---|---|---|
| verbatim tail 漏掉最新 user 訊息 | `MessageV2.filterCompacted`(`packages/opencode/src/session/message-v2.ts:1179-1245`)由新→舊掃描,遇最近一個 compaction anchor 才 `break`,再 `reverse()` 成時序——**保留 anchor→DB head 的全部訊息**。token budget guard 從**最新往回**累加,超限時 `break` 砍的是**靠近 anchor 的最舊訊息**,結構上不可能砍掉最新 user 訊息 | **證偽** |
| post-anchor tail 改寫吞訊息 | `post-anchor-transform.ts` v7(default,`enableDialogRedactionAnchor=true`)是 **pass-through no-op**(`:175-184`);v6(legacy,flag off)只 drop completed **assistant**,且 `:204-207` 明確「無 user 訊息則 drop nothing」、`:211` loop 只掃 `< lastUserIdx`——keep everything after the latest user message intact | **證偽** |
| 短答覆 / trivial-message 過濾誤殺「A」 | 全 `session/` 目錄唯一的「≤512 字元清空」在 `compaction.ts:852`,但只在 **small-model-context 單訊息超 budget** 的 edge case 觸發,作用對象是**壓縮模型自己的輸入**,不是主對話 prompt。主 prompt 組裝路徑無任何 min-length / trivial-message 過濾 | **證偽** |

額外:`filterCompacted` 是 **provider-agnostic** 的(`DD-21`,每個 provider byte-identical 邊界掃描),所以也不是「claude-cli provider 特有」的問題——原 Component 第 2、3 點歸因錯誤。

### 修正後的 root cause 指向(待坐實)

症狀「跑完 toolcall 沒 summary 就停 → 下一輪才補」**不是 context 漏訊息**——使用者的「A」自始至終都在模型可見 context 裡。真正的層是 **step-loop 的回合終止判斷**,核心在 `packages/opencode/src/session/prompt.ts:1825` 的 `isEmptyRound`:

```
isEmptyRound = (finish ∈ {unknown, other, error})
             && lastAssistant.tokens.input === 0
             && lastAssistant.tokens.output === 0
             && lastAssistant.id > lastUser.id
```

當一個 step 跑了 tool 但模型那一步**沒吐 text**(assistant turn 以 tool_call 收尾、finish 非 `stop`),「是否再起一個 step 讓模型基於 tool result 產生 final summary」的判斷才是症狀所在層。`prompt.ts:1860` 的 `lastUserAllSynthetic` guard 只處理 synthetic-trigger 空回應的 silent stop,真人 turn 不會被它誤判——所以症狀不是這個 guard,而是 tool-only step 之後的續轉條件。

### 仍待坐實的 evidence(誠實邊界)

**能斷言**:compaction-seam RCA 在程式碼層證偽。
**還不能斷言**:正面坐實「哪一個 finish/step/tokens 組合導致 tool 之後不再續一個 text step」需要一份**真實 runtime log**——`diag.preLLM`(`prompt.ts:2858`)+ `empty-response` log channel 已埋點,需抓「停掉」回合的 `finish` 值 / `tokens` / `step` 計數比對。沒有那份 evidence 前,正面 root cause 仍是推論,不得宣稱已找到。原報告 §2 的 instrumentation plan(boundary A-D)瞄準 compaction pipeline,**方向錯誤**;正確埋點在 step-loop 終止層(prompt.ts main loop)。

---

## 1. Baseline(症狀 / 重現 / 證據)

### 事件時序(逐輪,有截圖鐵證)

| Round | 角色 | 內容 |
|---|---|---|
| N-2 | AI | 盤點 plan 落地進度,結論:核心功能可跑但 T18 smoke 名實落差。提出 **A(補實 smoke 再 verified)/ B(接受 gap 直接往下)** 二選一 |
| N-1 | **使用者** | **「A」**(單字元答覆,referential — 指涉上一輪 AI 列舉的選項) |
| N | AI | **「我在等你對上一輪的 A / B 決定,沒有新指令前不動刀」** + 把 A/B 問題**原封不動重列一次** |
| N+1 | 使用者 | 貼出 N-1 的截圖:「我不是回了嗎?」|

### 鐵證

使用者於 N+1 提供的截圖,顯示 AI 在 Round N 的完整輸出開頭即為「我在等你對上一輪的 A / B 決定」——**證明使用者的「A」確實送達系統(否則使用者不會有上一輪畫面可截),但在組裝 Round N 的模型可見 context 時,那則「A」訊息不存在於 AI 視野**。

### 影響

- AI 對**剛剛回答過的問題**重新提問 → 決策迴圈無法前進。
- 若使用者不察(或答覆同樣簡短),可無限重問,形成 **decision deadlock**。
- 使用者每一次都要「貼截圖證明我回答過」,實質上是把系統的記憶責任轉嫁給使用者。
- 這是 question/answer 工作流的**地基性失效**:agent 的整個協作模型假設「使用者上一輪輸入在下一輪可見」,此假設被打破。

## 2. Instrumentation Plan(component boundary 埋點)

> 本報告無 compaction pipeline 原始碼 access,以下為交給 opencode 端的偵查藍圖。每個 boundary 觀察「輸入 / 輸出 / 狀態 / 截止 cursor」。

### 2.1 Boundary A — 使用者訊息落庫

- 埋點:使用者 Round N-1 的訊息寫入 session DB 時,記錄 `(messageID, role=user, char_len, parent_assistant_messageID)`。
- 期待:確認「A」確實落庫(預期會 — 使用者有畫面可截)。確立「訊息存在於 DB」這個事實,把問題範圍縮到「DB → 模型可見 context」之間。

### 2.2 Boundary B — compaction 截止 cursor vs 最新 user 訊息

- 埋點:組裝 Round N prompt 前,比對 `anchor_covers_up_to_messageID` 與 `latest_user_messageID`。
- 期待:若 anchor 截止點 < 最新 user 訊息 messageID,而該 user 訊息**既不在 anchor、也不在 verbatim tail** → 命中本 bug。這是最可能的 root cause 位置。

### 2.3 Boundary C — verbatim tail 拼接邏輯

- 埋點:claude-cli provider 組裝時,記錄它在 anchor 之後拼接了哪些 verbatim 訊息(messageID range + roles)。
- 期待:確認 tail 是否**漏掉了最後一則 user 訊息**。特別檢查邊界條件:
  - **短答覆是否被某種 min-length / "trivial message" 過濾誤殺?**(「A」只有 1 字元 — 高度可疑)
  - tail range 的計算是否 off-by-one,把最新一則 user 訊息排除在外?
  - anchor 產生與 tail 拼接是否非原子,存在「anchor 已更新但 tail 尚未納入新 user 訊息」的 race?

### 2.4 Boundary D — referential answer 的語意完整性

- 埋點:即使「A」進了 context,它的**指涉對象**(上一輪 AI 列舉的 A/B 選項)是否也在 context 內?
- 期待:若「A」進了 tail 但 A/B 選項定義被壓進 anchor 且遺失,模型仍無法 resolve「A」指什麼。需確認 referential short-answer 的**兩端**(答覆 + 被指涉的選項)同時可見。

## 3. Root Cause(causal chain,基於可觀測證據)

```
Round N-2: AI 提出 A/B 選項(選項定義隨後可能被壓進 narrative anchor)
  └→ Round N-1: 使用者回「A」(1 字元,referential,落入 session DB)
       └→ Round N 組裝模型可見 context 時:
            anchor 截止點停在 N-2 或更早
            而「A」這則 user 訊息既沒被重新壓進 anchor,也沒被 verbatim tail 納入
            (疑似觸發點:短答覆過濾 / tail off-by-one / anchor-tail race —— 待 §2.3 坐實)
            └→ 模型可見 context 中「使用者最後一次輸入」是 N-2 之前
                 模型據此認為「使用者還沒回答 A/B」
                 └→ 重問 A/B + 宣稱「我在等你的決定」
                      └→ 使用者:我不是回了嗎?(被迫截圖自證)
```

關鍵斷言(與關聯 issue 一致):**模型沒有幻覺,也沒有忽略使用者**。它忠實回應了它被餵的 context;錯在 context assembly 把使用者**已送達的當輪輸入**漏掉了。模型無從知道有一則它看不到的 user 訊息存在。

## 4. 與 `bug_20260531_narrative_anchor_lag_vs_session_db_truth.md` 的區別(為何是獨立 issue)

兩者同源於 narrative-compaction × claude-cli provider 的 seam,但**破壞形態與嚴重度不同**:

| 維度 | anchor_lag issue | 本 issue(short-answer dropped) |
|---|---|---|
| 丟失的是什麼 | AI **自己**過去做的工作(實作/commit) | **使用者**當輪的決策輸入 |
| 對比基準 | anchor vs 磁碟 SSOT | 模型可見 context vs 使用者實際送出的訊息 |
| 後果 | AI 低估自己進度,可能重做已完成工作 | AI 重問已回答問題,decision deadlock |
| 自救可能 | AI 可用「先讀磁碟 SSOT」紀律自行攔截 | **AI 無法自救** — 它不知道有看不到的 user 訊息;只有使用者截圖才能揭露 |
| 嚴重度 | High | **Critical** |

**本 issue 更嚴重的根本原因**:anchor_lag 至少 AI 能靠 SSOT 紀律補救(磁碟是 ground truth,AI 可主動查)。但「使用者當輪輸入被吞」**沒有任何 AI 端 ground truth 可查** —— 使用者的訊息不在磁碟、不在 git,只存在於 session DB 的對話流,而那正是壞掉的那條路徑。AI 對「我沒收到的訊息」完全盲視。這就是使用者說的「冰山一角」:任何依賴對話連續性的協作,地基都不可信。

## 5. 為何 Severity 是 Critical

- 直接破壞 agent 協作的**最基本不變量**:「使用者上一輪說的話,AI 下一輪看得到」。
- 觸發條件平常到極點:**一個短的、指涉式的答覆**(「A」「對」「第二個」「yes」)——這是人類對選擇題最自然的回應方式。越簡潔的答覆越可能被吞(若 root cause 是短答覆過濾)。
- 無 AI 端護欄:不像 anchor_lag 可用 SSOT 紀律補位,本 bug 下 AI **結構性盲視**,只能靠使用者察覺並截圖。
- 信任侵蝕是複利的:使用者一旦發現「我的回答可能被吞」,就必須對每個答覆都防禦性地加長、重複、或截圖,協作成本爆炸。

## 6. Suggested Fix 方向(待 opencode 端依 §2 證據定案,**不得引入 silent fallback**)

按優先序:

1. **verbatim tail 必須涵蓋到 DB head(首選,治本)**:context assembly 的硬不變量 —— 自 anchor 截止 cursor 到 session DB head 之間的**所有**訊息(尤其最後一則 user 訊息)必須逐字進 context。任何訊息進不了 anchor,就**必須**進 tail;兩者的覆蓋範圍接縫處不得有 gap。這是 anchor_lag issue §5.1 與本 issue 共用的治本修法。
2. **短答覆/trivial-message 過濾審查**:若 tail 拼接有任何 min-length、whitespace-trim-to-empty、或「low information」過濾,必須確認它**永不**丟棄 role=user 的訊息。使用者訊息無論多短(1 字元、純標點、純 emoji)都是決策載荷,不可過濾。建議:過濾器對 `role=user` 一律 bypass。
3. **referential-answer 完整性檢查**:當最新 user 訊息短且指涉式(無獨立語意),context assembler 應確保它所指涉的上一輪 assistant 訊息(選項定義)也在可見範圍 —— 要嘛同在 tail,要嘛 anchor 完整保留了選項文本。
4. **STALE/INCOMPLETE context fail-fast 訊號**:若偵測到 anchor 截止 cursor 與 DB head 之間有未涵蓋的 user 訊息,注入顯式 `<system-reminder>`(例:`there is at least one user message after your last visible context — do not assume the user is silent; reconcile before asking`),逼模型不要把「看不到」誤判為「使用者沒回」。此為治本修法落地前的即時護欄,本身亦有長期價值(非權宜 fallback,是顯式告警)。

## 7. Acceptance Criteria

- 構造場景:assistant 出 A/B 選項(Round k)→ user 回單字元「A」(Round k+1)→ 斷言 Round k+2 組裝的模型可見 context **必含**該「A」訊息**且**含 Round k 的 A/B 選項定義。
- 邊界回歸:user 訊息為 1 字元 / 純標點 / 純 emoji / 純空白後僅餘 1 字元 —— 全部必須出現在下一輪 context,**不得**被任何 trivial-message 過濾丟棄。
- 反向斷言:在「anchor 截止點 < 最新 user messageID」的場景,context assembler **要嘛**把缺口訊息補進 tail,**要嘛**注入 INCOMPLETE-context reminder;**不得**靜默產出一個漏掉最新 user 輸入的 prompt。
- 修正後,「AI 重問使用者剛回答過的問題」這類事件歸零。
- 不得以「預設信 anchror / 拿截止點當完整輸入」作為修法(= silent fallback,違反 AGENTS.md 天條)。

## 8. 偵查方法論註記(供制度改善)

本 bug 由**使用者**揭露,非 AI 自察 —— 這本身就是 §4 所述「無 AI 端護欄」的證明。AI 對自己看不到的 user 訊息結構性盲視,故無法靠任何行為紀律自我攔截。這也意味著:在治本修法(§6.1)落地前,**唯一的偵測者是使用者**。建議 opencode 端優先做 §2.2 + §2.3 的 boundary 埋點,把「anchor 截止 cursor vs 最新 user messageID」差值做成可告警的 runtime metric,讓系統能在使用者截圖之前自己發現吞訊息。

使用者原話定性:「這是嚴重系統問題的冰山一角,不是道歉了事。」本報告據此以 Critical 立案,且不以「AI 行為調整」收尾 —— root cause 在 context assembly 管線,必須由 opencode 端程式碼層修復。
