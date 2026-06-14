# Bug: narrative compaction anchor 落後於 session DB 真相 → AI 對已完成工作回報「還在計畫中」(narrative compaction × claude-cli provider 不協調)

- **Date**: 2026-05-31
- **Severity**: High(AI 基於過時 anchor 對使用者做出與磁碟 SSOT 直接矛盾的事實陳述;在長 session、跨多輪實作的工作流會系統性誤報進度,侵蝕使用者對 agent 的信任,且可能據錯誤前提採取破壞性動作如「重做已完成的工作」)
- **Component**:
  - narrative compaction 產生器(把 session 歷史壓縮成 `prior_context` narrative + `TOOL_INDEX` 注入 prompt 的那一層)
  - claude-cli provider 的 context assembly(收到 anchor 後組裝成模型可見 prompt)
  - 兩者之間的「壓縮截止點 ↔ session DB head」同步契約
- **Status**: CLOSED — original RCA was disproven and later context/anchor refactors replaced this path; retained as historical incident record.

---

## 0. RCA 修正 — anchor↔DB-head 漏訊息假設經程式碼層證偽(2026-06-01)

> 本報告原由 llmserver session 內觀察寫成,RCA 停在「anchor 內容 vs 磁碟 SSOT 比對」並推測 compaction 截止點之後的工作「既沒被重新壓進 anchor,也沒以 verbatim tail 補上」。2026-06-01 在 opencode repo 內讀完 context 組裝控制路徑後,**這個漏訊息假設不成立**:

- `MessageV2.filterCompacted`(`packages/opencode/src/session/message-v2.ts:1179-1245`)由新→舊掃描,遇最近一個 compaction anchor 才 `break`,再 `reverse()`——**anchor 之後到 DB head 的所有訊息都保留**。§3 causal chain 第 3-4 步(「截止點之後的工作既沒被重新壓縮也沒 verbatim 補上」)與此程式碼直接矛盾。
- `post-anchor-transform.ts` v7(default)pass-through;v6 只 drop completed assistant 且保留最新 user 之後全部。**沒有任何路徑會讓「anchor 截止點之後的已完成工作」對模型不可見。**

### 對症狀的重新解讀

原報告的症狀(AI 連續多輪說「還在計畫中」,與磁碟 9 endpoints 已實作矛盾)更可能源於:**那個 session 當時的 anchor 是在工作完成前產生的快照,而 anchor body 本身的內容過時**——但這是 **anchor body 的內容新鮮度**問題(壓縮當下沒涵蓋後續工作),**不是** tail 漏訊息。差別關鍵:後續工作的 **raw messages 仍在 context tail 內**(filterCompacted 保留了),模型其實看得到——所以 §4 說「AI 可用先讀磁碟 SSOT 紀律自救」成立,但成因不是「anchor 與 tail 之間有 gap」,而是「anchor 摘要文字本身不含後續工作 + 模型偏信摘要而非自己重讀 tail」。

§5 的 fix 方向(anchor 增量更新 / STALE_ANCHOR fail-fast / 跨層共用 cursor)**前提錯誤**:不存在 tail gap 要補。若要做護欄,正確方向是「anchor body 新鮮度告警」(偵測 anchor.time.created 遠早於 DB head 且其間有大量已完成工作 → 注入提示要模型以 tail raw messages / 磁碟 SSOT 為準,不要偏信 anchor 摘要)。

### 與 short_answer issue 的關係(修正)

原報告把本 issue 與 `bug_20260531_user_short_answer_dropped_from_context.md` 歸為「同一 seam 的兩種破壞形態」。**證偽後,兩者的 compaction-seam 歸因都不成立**:short_answer 的真正層在 step-loop 回合終止(見該 issue §0),本 issue 的真正層在 anchor body 內容新鮮度——**不是同一個 root cause**,當初的 seam 共因判斷是基於錯誤的 pipeline 心智模型。

---

## 1. Baseline(症狀 / 重現 / 影響範圍)

### 症狀

在一個長時間、跨多輪(Round 1–16+)的 llmserver 開發 session 中,使用者問「回顧一下目前 plan 執行情形」。AI 的 `prior_context` narrative anchor 停在 Round 16,內容顯示:

- Phase 2(control plane API,T10–T20)**尚未實作**
- 工作卡在「等使用者確認 3 個設計決策(subprocess 權限 / bootstrap 例外 / v2 out-of-scope)」
- 最後一則敘事是 AI 在補 architecture 文件的第 4 點(跨 OS GPU)

AI 因此連續多輪回答使用者「**還在計畫中**」「Phase 2 尚未進 implementing」「等你確認設計決策才動 code」。

### 磁碟 SSOT 真相(與 anchor 衝突)

當 AI 實際讀取磁碟(SSOT)時,發現完全相反的事實:

| 維度 | narrative anchor 說 | 磁碟 SSOT 實況 |
|---|---|---|
| `plans/driver_framework_switching/tasks.md` | T10–T20 未做 | T1–T20 **全部 `[x]`** |
| `.state.json.history` | 最後是 verified→designed(extend) | 已有 `designed→implementing→verified`,reason 寫明「smoke 22/22 PASS、9 endpoints、config SSOT」 |
| `src/llm-sidecar/src/main.rs` | 只有 `/control/active` | **9 個 `/control/*` routes** 全實作(active/profiles/health/modules/providers/start/stop/restart/loadmodel),行 572–580 |
| `git log` | (anchor 無此資訊) | 4 個 feature commits 已落地(`5351e6e` control plane + CLI、`6ef225e` deploy/exporters/smoke、`648d358` architecture+integration、`46f131a` systemd units 上線) |
| 工作樹 | (anchor 認為 dirty、待實作) | clean(僅 `.specbase/`、`issues/` untracked) |

### 影響範圍

- AI 對使用者做出**與磁碟 SSOT 直接矛盾**的事實陳述(「還在計畫中」),且重複多輪。
- 若使用者信任該陳述,可能下令「那就開始實作 Phase 2 吧」→ AI 會**重做已存在且已驗證的工作**(重複 9 個 endpoints),浪費算力、製造 merge/覆蓋風險。
- 此次因使用者追問 + AI 改採「先讀磁碟再下結論」(code-thinker SSOT 紀律)而即時攔截,但**攔截靠的是人工懷疑 + 工具紀律,不是系統保證**。

### 重現條件(推測,待 §2.4 確認)

1. 長 session,輪數多到觸發 narrative compaction
2. compaction 截斷點之後,session 仍有大量實質工作(實作、驗證、commit)被寫入 session DB
3. 下一次 provider 組裝 prompt 時,注入的是**壓縮當下的 anchor 快照**,而非 session DB 的最新 head
4. anchor 與 DB head 之間存在「未被重新壓縮 / 未被增量補進」的工作歷程 gap

## 2. Instrumentation Plan(component boundary 埋點建議)

> 寫報告的 llmserver session 無法存取 compaction pipeline 原始碼,以下為交給 opencode 端的偵查藍圖。每個 boundary 需觀察「輸入 / 輸出 / 狀態 / 截止點」四訊號。

### 2.1 Boundary A — compaction 產生器

- 埋點:每次產生 narrative anchor 時,記錄 `(anchor_covers_up_to_messageID, session_db_head_messageID, gap_message_count)`。
- 期待:正常情況 gap 應為 0 或極小;若 gap 大且未觸發再壓縮,即為本 bug 的溫床。

### 2.2 Boundary B — anchor ↔ DB head 同步檢查

- 埋點:provider 組裝 prompt 前,比對「即將注入的 anchor 截止 messageID」與「session DB 當前 head messageID」。
- 期待:若 anchor 截止點 < DB head,且兩者之間的 messages 既不在 anchor 也不在 verbatim tail → 標記 `STALE_ANCHOR` anomaly。

### 2.3 Boundary C — claude-cli provider context assembly

- 埋點:claude-cli provider 收到 anchor 後,記錄它是否額外拼接了「anchor 之後的 verbatim recent messages」,以及拼接的範圍。
- 期待:確認是否 provider 端「只信 anchor、不補 DB tail」造成 gap 對模型不可見。

### 2.4 Boundary D — 跨層截止點契約

- 埋點:確認 compaction 產生器與 claude-cli provider 對「哪些 message 已被 anchor 涵蓋、哪些需 verbatim 補上」是否共用同一份 cursor。
- 期待:若兩層各自維護 cursor 且不同步 → 即 root cause 的結構性來源(本 issue 標題的「不協調」)。

## 3. Root Cause(causal chain,基於對話可觀測證據)

```
長 session 輪數累積
  └→ narrative compaction 在某個 messageID(此例約 Round 16)產生 anchor 快照
       └→ 截止點之後 session DB 持續寫入實質工作
            (Phase 2 實作 T10–T20、cargo check、smoke 22/22、4 個 git commits、state→verified)
            └→ 下一輪 provider 組裝 prompt 時,注入的是「壓縮當下的 anchor」
                 而 anchor 截止點之後的工作歷程「既沒被重新壓縮進 anchor,也沒以 verbatim tail 補上」
                 └→ 模型可見上下文 = 過時 anchor(stop at Round 16)
                      └→ 模型據此回答「還在計畫中」,與磁碟 SSOT 直接矛盾
```

關鍵斷言:**模型沒有「幻覺」**——它忠實複述了它被餵的 anchor。錯誤發生在 anchor 與 session DB head 的同步契約:壓縮截止點之後的工作對模型不可見,且沒有任何 boundary 告訴模型「你的 anchor 已過時,請查 SSOT」。

這正是 narrative compaction 層(決定壓什麼、壓到哪)與 claude-cli provider 層(決定注入什麼、補不補 tail)之間缺乏同步契約的證據。

## 4. 為何 Severity 是 High

- 不是顯示瑕疵,而是**讓 AI 對使用者輸出反事實**,且反事實的方向是「低估已完成進度」——最容易誘導使用者下「重做」指令。
- 觸發條件(長 session + 截止點後大量工作)是**任何認真的多輪實作工作流的常態**,非邊角案例。
- 本次只因 code-thinker 的「先讀 SSOT 再下結論」紀律 + 使用者追問才攔下;**系統本身沒有護欄**。若 AI 當輪偷懶直接信 anchor,就會釀成重工或覆蓋。

## 5. Suggested Fix 方向(待 opencode 端依 §2 證據定案)

按優先序,且**不得引入 silent fallback**(AGENTS.md 天條):

1. **anchor 增量更新(首選)**:compaction 後若 session DB 繼續增長,下次組裝 prompt 時必須將「anchor 截止點 → DB head」之間的 messages 以 verbatim tail 補進 context,或觸發再壓縮把它們納入 anchor。讓「模型可見上下文」永遠覆蓋到 DB head。
2. **STALE_ANCHOR fail-fast 訊號**:Boundary B 偵測到 anchor 截止點 < DB head 且 gap 未被補上時,在注入 context 內顯式插入一行系統提示(例:`<system-reminder>anchor covers up to msg N; session has advanced to msg M — verify state against disk SSOT before asserting progress</system-reminder>`)。這不是 fallback,是顯式告警,逼模型查 SSOT。
3. **跨層共用 cursor**:讓 compaction 產生器與 claude-cli provider 共用同一份「已涵蓋 messageID」cursor,消除兩層各自為政的 gap(§2.4)。

> 註:選項 2 與既有的 `<system-reminder>` 注入機制同源,實作成本低,可作為選項 1 完整實作前的即時護欄(但本身即是有價值的長期護欄,非權宜)。

## 6. Acceptance Criteria

- 在「長 session + 壓縮截止點後有 N 則實質 message」的重現場景下,模型可見 context 必須涵蓋到 session DB head(verbatim tail 或重壓縮二擇一),或至少收到顯式 STALE_ANCHOR 告警。
- 回歸測試:構造 anchor 截止於 msg K、DB head 在 msg K+M(M>0)的 session,斷言 provider 組裝的 prompt 要嘛包含 K+1..K+M 的內容,要嘛包含 STALE_ANCHOR reminder;**不得**只注入截止於 K 的 anchor 而無任何補償。
- 不得以「預設信 anchor」或「靜默拿第一個可用快照」作為修法(= silent fallback,違反天條)。
- 修正後,本類「AI 對已完成工作回報未開始」的反事實陳述率歸零。

## 7. 關聯 issue

- `bug_20260529_toolcall_duplicate_apply_patch_retry.md`:同一個 llmserver session 稍早觀察到的 toolcall 重複/重試雜訊。兩者都指向「長 session 下 context/runtime 協調」的脆弱性,但**root cause 不同**(那個是 toolcall dispatch 重試,本 issue 是 narrative anchor 同步)。
- `bug_20260530_narrate_then_stall_regression.md`(前端 tool-call 渲染):同屬「使用者感知的 agent 狀態 ≠ 真實狀態」家族,但層次不同(那是前端渲染,本 issue 是模型可見 context)。

## 8. 偵查方法論註記(供制度改善)

本 issue 的攔截完全依賴 code-thinker SSOT 紀律:「涉及狀態語意時,先親眼讀磁碟真實實作,不憑 anchor / 印象下結論」。若無此紀律,AI 會直接複述過時 anchor。建議把「長 session 回報進度前,先以 git/磁碟 SSOT 交叉驗證 anchor」固化為 orchestrator 的硬性 checkpoint,在系統層護欄(§5)落地前先以行為紀律補位。
