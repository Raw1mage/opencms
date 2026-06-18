# BUG: 任何 auto-compaction 後 runloop 停住——synthetic Continue 注入因 `buildContinueText` 恆空而靜默 no-op

- **日期**：2026-06-18
- **嚴重度**：high（每次自動壓縮都中斷 agentic 工具迴圈；使用者須手動再戳一下才續跑）
- **元件**：opencode session runtime — `compaction.injectContinueAfterAnchor` ×`PostCompaction.buildContinueText` × prompt runloop `no_user_after_compaction` 退出點
- **回報者**：pkcs12（live，session `ses_127a8a471ffeNvACvK7B21xanG`，cms.thesmart.cc）
- **狀態**：OPEN（RCA 完成、fix plan 待批准實作）

## 症狀

只要一次 auto-compaction（overflow / cache-aware / idle / empty-response）在 agentic 工具迴圈**中途**觸發，壓縮成功後 runloop 不會接著把工具迴圈跑完，而是直接轉 `idle`。使用者體感為「**一壓縮，runloop 就停下來了**」，要再送一則訊息（或等 supervisor/autonomous re-dispatch）才會續跑。

與兩個先前 BR 的關係：

- `issues/closed/issue_20260614_rotation_compaction_runloop_stop.md`（CLOSED）：結論為 3R 重啟打斷在途回合，**非壓縮問題**。本 bug 與重啟無關——daemon 未重啟也發生。
- `bug_20260616_cold_bgate...md` **axis 3**（已修，`d852214c0`）：處理「被折疊掉的**未回應 user 訊息**」→ replay 一則真實 user 訊息驅動迴圈。本 bug 是**互補的另一半**：壓縮發生在 user 已被回應、但 assistant 還有**待續工具迴圈**時——此時 anchor 後沒有 user 可 replay，改走 synthetic Continue 注入路徑，而該路徑壞了。

## 證據（debug.log，兩次真實觸發）

### 觸發 A — 10:53:39（舊 build，雙靈魂尚在）
```
10:53:39.091  claude_cold_compaction_gate  promptTotal=200182 cacheReadFraction=0.18 → "cache-aware"
10:53:39.289  compaction.continue.gate     decision=true  reason="no_post_anchor_user_static_intent"
10:53:39.302  compaction.continue.injected decision=false reason="empty_continue_text" followUpCount=0
10:53:39.362  loop:no_user_after_compaction — exiting cleanly
10:53:39.364  session.status → idle
```

### 觸發 B — 11:31:48（新 build `9c7e19a35`，雙靈魂已修，問題二仍復現）
```
11:31:48.252  predicate step=3 outcome=fire ("cache-aware", promptTotal=211594)
              compaction.continue.gate     decision=true  reason="no_post_anchor_user_static_intent"
              compaction.continue.injected decision=false reason="empty_continue_text" followUpCount=0
11:31:48.605  session.idle
11:32:22      新 runloop（step 重置為 1）才接上 ← 34 秒空窗
```

兩次都是：**gate 決定要注入 Continue（decision=true），但 injector 因為 continueText 為空而靜默放棄（decision=false）**。

## Root Cause

因果鏈（全部已對源碼）：

1. `cache-aware`（以及 `overflow`/`idle`/`empty-response`）在 `INJECT_CONTINUE` 表中為 `true`
   （[compaction.ts:1167-1185](packages/opencode/src/session/compaction.ts#L1167)）。
2. `shouldInjectContinue` 正確回傳 `decision=true`（anchor 後無 user、靜態意圖為 true）
   （[compaction.ts:2892-2950](packages/opencode/src/session/compaction.ts#L2892)）。
3. `injectContinueAfterAnchor` 取 `continueText = PostCompaction.buildContinueText(gather())`
   （[compaction.ts:2825-2844](packages/opencode/src/session/compaction.ts#L2825)）。
4. **但 `PostCompaction` 已於 2026-05-13 `49e171bcd`「retire post-compaction runtime-state resend」整組退役**：
   `gather()` 恆回 `[]`、`buildContinueText()` **無條件回 `""`**
   （[post-compaction.ts:60-82](packages/opencode/src/session/post-compaction.ts#L60)）。
5. `continueText` 為空 → injector 在 [compaction.ts:2835](packages/opencode/src/session/compaction.ts#L2835)
   提早 return（`empty_continue_text`），**沒有寫入任何 synthetic user 訊息**。
6. anchor 後無 user 訊息 → runloop 在 [prompt.ts:2242](packages/opencode/src/session/prompt.ts#L2242)
   `if (!lastUser)` 命中 → `no_user_after_compaction — exiting cleanly` → break → idle。

### 退化點與 conflation

`49e171bcd` 之前，`buildContinueText([])` 回的是一段**不帶任何 runtime state 的通用指令**：

> "Compaction completed. Continue from your existing plan and runtime state. Do NOT re-establish
> work that the runtime already tracks; … If there is no further work, stop with a brief summary."

退役 commit 的**正當目標**是移除「把 runtime state 用自然語言重送」造成的 duplicate authority signals
（即 `hints.length > 0` 那條帶狀態的分支）。但它**順手把空 hints 的通用 fallback 也歸零**——而那條
fallback 不帶任何狀態，是唯一在 auto-compaction 後**驅動 runloop 繼續**的東西。兩件事被混為一談：

- 「不要重送 runtime state（duplicate authority）」← 該移除，✓
- 「壓縮後給一句極簡 Continue 指令讓迴圈別停」← **不該移除，被誤殺**

結果：`INJECT_CONTINUE[*]=true` 的契約自 2026-05-13 起對 `cache-aware`/`overflow`/`idle`/`empty-response`
**全部變成 dead contract**——gate 永遠說要注入、injector 永遠注入空字串、迴圈永遠停。

### 為什麼 axis-3（`d852214c0`）沒蓋到

axis-3 replay 的前提是「有一則**未回應的 user 訊息**被折疊」——它 replay 那則真實 user 訊息，`lastUser`
就有了。但壓縮發生在**工具迴圈中途**（user 早已被回應、finishReason=`tool-calls` 代表還有待跑工具）時，
anchor 後本來就**沒有待答 user 訊息可 replay**，只能靠 synthetic Continue——正好踩進上述空字串黑洞。

## 影響範圍

任何 session 在 context 壓力下自動壓縮（cache-aware/overflow/idle）且當下 assistant 正在多輪工具迴圈中
——即所有長 agentic 任務。每次壓縮都斷一次，靠使用者手動續戳或 supervisor re-dispatch 補救（本 session
11:31→11:32 的 34 秒空窗即此）。

## Fix Plan

### 主修（最小、低風險）— 還原 stateless Continue fallback
`PostCompaction.buildContinueText` 在空 hints 時，回到一段**不帶 runtime state** 的極簡指令，例如：

> "Compaction completed. Continue from where you left off and follow your existing plan. Do NOT
> re-establish work the runtime already tracks. If there is no further work, stop with a brief summary."

- 帶狀態的 `hints.length > 0` 分支維持退役（`gather()` 仍回 `[]`，不復活 duplicate authority）。
- 只還原「無 hints → 通用 fallback」，重新武裝 injector → synthetic user 訊息得以寫入 → `lastUser`
  有值 → runloop 續跑而非 `no_user_after_compaction`。
- 末句「If there is no further work, stop」防 busy-spin：真的沒事做時模型會自行收尾。

### Cascade / 無限迴圈安全性
還原的是**原本就設計成 true** 的行為，且既有防護仍在：30s cooldown（DD-13）、post-compaction-echo skip
（F2/DD-5）、size-based B-gate 折疊後縮到門檻下（cascade-immune）。`rebind`/`provider-switched` 仍是
false-gated（守 2026-04-27 infinite-loop bug）。故安全。

### 縱深防護（次要、可選，較動 runloop 敏感區）
在 [prompt.ts:2242](packages/opencode/src/session/prompt.ts#L2242) `!lastUser` 退出前，區分最近一個 finished
assistant turn 是「**真正完成**（finishReason=stop / 無待跑工具）」還是「**工具迴圈中途被壓縮打斷**
（finishReason=tool-calls）」：前者 exit-clean 正確；後者即使 synthetic Continue 因故缺席也應續跑（或就地補一個
Continue），不可靜默轉 idle。作為主修失效時的 belt-and-suspenders；因觸及退出 invariant，獨立評估。

### 回歸測試
1. `cache-aware`（及 `overflow`）壓縮、anchor 後無 user → 斷言 `buildContinueText` 非空 → injector 實際寫入
   synthetic user 訊息 → `filterCompacted` 視圖含該 user → runloop **不**命中 `no_user_after_compaction`。
2. 反向：finishReason=stop 的真正完成回合壓縮 → 仍應 exit-clean（不可因主修而變成永不停）。

## 驗證方式（fix 上線後）
同類 session 再觸發 auto-compaction 時，log 應見 `compaction.continue.injected decision=true`、其後
**沒有** `loop:no_user_after_compaction`，且同一 runloop（step 不重置）直接續跑下一拍工具呼叫。
