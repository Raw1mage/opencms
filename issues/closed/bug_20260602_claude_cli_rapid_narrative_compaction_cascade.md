# Bug: claude-cli 短時間內反覆 narrative compaction(每 1.5–7.8 分鐘一次)— prompt 卡在 200K B-threshold + prompt-cache 每隔一輪崩回 33204 floor 的雙重迴圈

- **Date**: 2026-06-02
- **Severity**: High(長 session 在 claude-cli 上每幾分鐘就 narrative compaction 一次:每次重寫 anchor = 冷 prefix + 重算;且 cache_write 以 1.25× 計費反覆重寫 ~165K → 又慢又貴。使用者主動回報「太頻繁、不太對」)
- **Component**:
  - claude-cli context 路徑:`prompt.ts` 的 claude cold-compaction gate(DD-16)+ `tweaks.ts` 的 claude-cli `bCompactTokens=200_000`
  - **(待證)** `provider-claude/convert.ts` 的 `cache_control` breakpoint 擺放 — 對話區 cache 每隔一輪沒被命中
- **Status**: CLOSED — RCA finalized; fixed by DD-18..DD-22 context-preface/cache-breakpoint changes and deployed.
  - ⚠️ §3.x「斷點數 1 vs 2」與 §11.3 早期版本是**錯/不完整的 RCA**(那支 2-斷點修法已部署仍 thrash,實證推翻)。**真因見 §12**:opencms 把 ephemeral context preface 當普通 user 訊息插在最後一則前,且 `applyConversationCacheBreakpoint` 沒跳過它 → 第二斷點落在會移位的 preface → 無穩定 read-hit → 對話退回 system floor(31953)冷重寫。官方 `TF5` 的 `f()` 會 `while skip api_system` 注入訊息,opencms 漏了這個 skip。
  - 修法(§12.修法):preface 標 `contextPreface` + convert 跳過(鏡像官方 `f()`)。**§11.2 anchor undercount、§11.4 ABC 校準是獨立的另案,不在本修法。**
  - 與 `bug_20260602_codex_lastinputlength_premature_advance_chain_reset`(codex,已修)不同 provider、不同路徑。

---

## 1. 症狀

長 session 切到 claude-cli 後,**narrative compaction 每 1.5–7.8 分鐘就觸發一次**,遠超合理頻率。每次 compaction 重寫 anchor → 新 prefix → cache 冷掉重算。

## 2. 證據(ses_17c309bc9ffe6YdSYqxKpgyZKA,claude-cli `claude-cli-subscriptio…`,2026-06-02 15:04–19:27,166 turns)

### 2.1 compaction 頻率(權威:DB `summary=1` anchor)
切到 claude-cli 後共 **11 次** narrative compaction。相鄰間隔(分鐘):
```
83.9, 3.9, 1.5, 4.5, 65.0, 31.1, 5.9, 144.2, 4.1, 7.8
```
其中數段是 **1.5 / 3.9 / 4.1 / 4.5 / 5.9 分鐘**連發 — 不是 200K context 自然長滿該有的節奏。

### 2.2 token 形態(smoking gun:cache 每隔一輪崩回 33204)
連續 claude-cli turn(時間遞減):
```
19:27:08  inp=2  cr=197201  cw=2294    prompt=199497   ← 暖:讀 197K
19:26:59  inp=2  cr= 33204  cw=165822  prompt=199028   ← 冷:cr 崩回 33204,重寫 165K
19:26:50  inp=2  cr=194255  cw=2946    prompt=197203   ← 暖
19:26:40  inp=2  cr= 33204  cw=162895  prompt=196101   ← 冷
19:26:34  inp=2  cr=192761  cw=1494    prompt=194257   ← 暖
```
- **prompt 穩定貼在 ~190–200K**,正好是 claude-cli 的 `bCompactTokens=200K`。
- **cache_read 每隔一輪在 ~194K(暖)↔ 精確 33204(冷)之間跳**;冷的那輪 **cache_write 噴到 160–166K**(=把對話區整段重寫進 cache,1.25× 計費)。
- `inp≈2`:整個 ~200K prompt 幾乎全走 cache(讀或寫),未快取輸入趨近 0。

## 3. 機制(雙重迴圈;§3 root 段為假設)

**迴圈 A — 200K 門檻 + 快速回填**
1. prompt 漲到 ~200K → 觸發 overflow compaction(claude B-threshold=200K)。
2. compaction 砍到 ~45K(telemetry 見 post-compaction `currentInputTokens≈44–50K`, ctxRatio≈0.16–0.18)。
3. **~3 分鐘內 context 又回填到 200K**(19:19:41 compaction → 19:22:21 已 189K = 約 145K/3min,推測大量 tool output 灌入)。
4. 再次 overflow → 回到 1。

**迴圈 B — cache thrash 餵 cold-compaction gate**
1. cache_read 每隔一輪崩回 33204 → `cacheReadFraction ≈ 33204/200068 ≈ 0.166`。
2. `prompt.ts` 的 claude cold-compaction gate(DD-16):`isClaudeContextProvider && promptTotal>bCompactTokens(200K) && cacheReadFraction<0.5` → 回傳 `"cache-aware"` → 又一次 narrative compaction。
3. compaction 重寫 anchor → prefix 又變 → cache 又冷 → 回到 1。

兩個迴圈互相加成:prompt 黏在門檻、cache 又一直半冷,於是 compaction 停不下來。

## 3.x Root cause(**已坐實 — 官方源碼對照,2026-06-02**)

**真因:opencms 只在「最後一則訊息的最後一塊」標單一對話 cache_control 斷點;官方 claude-code 標最後兩個(last + second-to-last,或 pinned fork)。單斷點沒有穩定 fallback → thrash → cache_read 一暖一冷。**

證據(靜態,不需 live token):

- **opencms**:[`provider-claude/src/convert.ts:236-244` `applyConversationCacheBreakpoint`](../packages/provider-claude/src/convert.ts#L236) — `last.content[last.content.length-1].cache_control = ephemeral()`,**只標最後一則**。4 個斷點 = identity + system-static + tools(3 個穩定 = 33204 floor)+ **1 個 sliding 對話斷點**。
- **官方 cli.js**(`refs/claude-code-npm`,函式 `TF5`):
  ```js
  O = f(H.length-1);            // 最後一則(略過 api_system)
  M = new Set; M.add(O);        // 一定標最後一則
  if (cachingEnabled)
    M.add(Y ? forkPoint : f(O-1)); // 再標「倒數第二則」或 pinned fork
  // → markerCount = 2(tengu_api_cache_breakpoints 遙測)
  ```
  倒數第二則斷點 = **上一輪的「最後一則」**,已被寫進 cache,故本輪**穩定 read-hit**;只有最新一段是 fresh。這正是 Anthropic 防 cache-thrash 的標準慣例。
- **機制**:opencms 單斷點每輪往前滑,沒有「上一輪已落地」的穩定斷點墊背 → 對話區 ~165K 每隔一輪被當未命中重寫(cache_write 165K,1.25× 計費)→ 一暖一冷。冷輪 `cacheReadFraction≈0.166` 再餵 DD-16 cold-gate → narrative compaction(迴圈 B)。

compaction 是**症狀**;真因 = **對話 cache_control 斷點數 1 vs 官方 2**。

### 修法(治本 + 治迴圈)
1. **治本(convert.ts)**:`applyConversationCacheBreakpoint` 改標**最後兩個** user/message 斷點(對齊官方 `TF5`:last + second-to-last),讓上一輪斷點成為本輪穩定 read-hit。注意 4 斷點上限:identity+system+tools 已佔 3,單一對話斷點才不超?→ 需重新分配(官方把對話斷點當主角;可能要讓 system/tools 共用較少斷點)。**這是設計細節,需在 plan 內定。**
2. **治迴圈 B(prompt.ts DD-16 gate)**:cold-compaction gate 加 cooldown / 「剛 compaction 過就跳過」(類比 codex 30s cooldown + selfInvalidated echo),避免拿 provider 層 cache bug 當壓縮訊號自我餵食。

## 4. 為什麼這不是 codex 那支修法能管的
- codex hotfix(`bug_20260602_codex_lastinputlength...`,已 land main 378e238da)修的是 codex WS `previous_response_id` chain 的 send-time 推進 bug,**SS provider**。
- 本 bug 是 **claude-cli(SL provider)** 的 prompt-cache + 200K 門檻 + DD-16 cold-compaction gate,**完全不同路徑**。
- 兩者唯一共通點:都表現為「cache 反覆冷掉」。但成因與修法毫無重疊。

## 5. 提議調查方向(尚未動工)
1. **先量 cache_control**:在 claude native send 路徑記錄每請求的 cache_control 斷點(位置/數量),對齊冷/暖交替,坐實 §3.x。
2. **檢視 cold-compaction gate(DD-16)**:當 cache thrash 是 provider 層 bug 造成時,用 `cacheReadFraction<0.5` 當 compaction 觸發等於「拿 provider bug 當壓縮訊號」→ 製造迴圈 B。考慮:gate 是否該排除「上一輪剛 compaction」或加 cooldown(類比 codex 的 30s cooldown / selfInvalidated echo)。
3. **回填速度**:確認迴圈 A 的 145K/3min 是否真為巨量 tool output;若是,compaction target(~45K)被瞬間灌爆,門檻 200K 對「大輸出工作流」可能需要不同策略。

## 6. 立即緩解(給使用者)
此 session 在 claude-cli 上會持續燒 compaction;若要止血,換 provider 或開新 session 可避開既有 200K-貼著的歷史。修法到位前,長 + 大輸出的 claude-cli session 容易踩到。

## 7. Related
- `bug_20260602_codex_lastinputlength_premature_advance_chain_reset.md`(codex,不同 provider,已修;對照組)
- plan `provider-codex_cache-chain-hotfix`(codex 那支的完整脈絡)
- plan `context_claude-refactor`(claude cold-compaction gate DD-13/14/16 的設計出處)
- MEMORY `project_claude_cli_native_path_not_aisdk`(claude-cli 走 native provider-claude,cache_control 落點在 convert.ts)

---

## 11. 升級:真正主因是 compaction 無效 + ABC 策略建在「1M window」幻覺上 (2026-06-03)

斷點 thrash(§3.x)只是次因。實測 session DB 揭露更根本的兩條:

### 11.1 compaction 效益極差(谷底只到 ~140K,非 target ~50K)
4 次 claude-cli compaction 谷底 promptTotal:228K→125K、200K→135K、201K→147K、201K→153K(平均 **140K**)。從 140K 回填到 200K 只需 +60K → 「<10 分鐘又來一次」。

### 11.2 narrative anchor 無界成長 ~97K(CJK-aware),被 chars/4 驗收放行
anchor 大小單調增:92→114→133→145→154→164→179→186→**191KB**(9.5h)。191KB ≈ **chars/4 估 48K vs CJK-aware 估 97K(2×=CJK 指紋)**。真因:`compaction.ts:4019` `validateAnchorBody` 用 `Math.ceil(body.length/4)` 判 size——把 97K-real anchor 估成 48K < target ceil 55K → **驗收通過**。同類殘留:L1902、L2532。drain gate(L1768)當初已修 CJK-aware,但**寫入驗收這道門被漏掉**。等同 codex 已修 bug([project_compaction_anchor_cjk_token_undercount])的未覆蓋 site,**provider-agnostic**。

### 11.3 ABC 策略建在 1M window 假設(claude-context-policy.ts:58)
`shouldEnrichAnchor` 註解明寫「its **1M window** makes the legacy context-ratio gate (0.4 → 400K) unreachable」→ 才改用絕對 `aFloorTokens=100K`。**[2026-06-03 修正]** Opus 4.8 官方**確實是 1M**(`supports1MContext: true`),策略假設 1M 沒錯;問題是 (i) 本 session 跑 plain `claude-opus-4-8`(**沒帶 `[1m]` 變體**)→ `model.limit.context` 落 200K、1M beta 未啟用;(ii) `bCompactTokens=200K` 是**固定值、不隨 window 縮放**,即使 [1m] 啟用、真實 1M,我們仍硬在 200K compaction → 浪費 800K headroom。後果(在 plain 200K 下):
- **A-tier drain floor 100K = 真實 window 的 50%**(設計時當成 1M 的 10%)。anchor 長到 ~97K 剛好卡在 100K floor 下 → drain 永不觸發。
- **B trigger 200K = 整個真實 window**。
- 兩者疊加:97K anchor(2× 來自 §11.2 低估)＋ aFloor 對 200K 太高 → 工作空間只剩 ~60–100K → 每 ~10 分鐘 compaction。

### 11.4 修法方向(待開 plan)
1. **估算器一致化**:`validateAnchorBody`(L4019)+ L1902/L2532 改 `ToolBudget.estimateTokens`(CJK-aware),對齊 L1768 → anchor 真的壓到 target ~50K。
2. **ABC 重新校準到真實 200K window**(非 1M):aFloor 100K→約 30–40K;B/cache-aware 門檻留足 headroom。先做 1,再用實測決定 2 的數值。
3. 對照 codex 的 aCompactTokens=50K(codex 窗較小已校準)當參考。
**評估**:這是比斷點 plan(provider-claude_conversation-cache-breakpoint)更根本、且 provider-agnostic 的真因;斷點修好 anchor bug 仍在(real overflow 照樣壓、照樣只到 140K)。

---

## 12. RCA 定案(upstream 確認)+ 真修法 (2026-06-03)

§3.x / §11.3 的「斷點數 1 vs 2」是**錯的 RCA**(那支修法 DD-8 已部署仍 thrash,實證推翻)。逐字對照官方 `refs/claude-code-npm` cli.js 後定案:

### 真因:斷點落在「會移位的 ephemeral preface」上,官方會跳過它
- 官方 `TF5` 的索引函式 `f()`:`while(L>=0 && H[L].type==="api_system") L--` —— **放斷點前跳過所有注入的 `api_system` 訊息**(per-turn system-reminder/環境/圖片都包成 `type:"api_system"` via `Y35()`,並用 `isMeta` 標記)。官方斷點永遠落在穩定的真實 user/assistant turn 上。
- opencms:context preface 被當普通 `{role:"user"}` 訊息插在最後一則 user 之前([llm.ts:1170-1172](../packages/opencode/src/session/llm.ts#L1170)),**沒有 api_system/isMeta 標記**;`applyConversationCacheBreakpoint` 直接取 `length-1/length-2`,**沒跳過 preface**。
- → `length-2` 斷點落在 ephemeral preface(每 call 重建、隨對話成長每輪重新插在不同位置)→ 跟上一輪的快取前綴對不上 → 對話無穩定斷點墊背 → 退回 system floor(實測 **31953**)→ 整段 ~160K 對話重寫 = 冷輪(cacheWrite 160–185K)。

### 實證(部署後 13:48-13:53,2-斷點修法已在)
- 45% 冷輪(243/552;貼近門檻區 145/321)。
- preface telemetry **全程不變**(t1Chars=43771 / trailingChars=22357 / inlineImageCount=8 / staticHash 恆定)→ **排除內容變動假說**。
- 冷輪 cacheRead 精確 31953(system 前綴)、cacheWrite 160-185K(全對話重寫)。

### 修法(直接鏡像官方 `f()`,2026-06-03,已實作 + 離線測 12/12)
1. [llm.ts](../packages/opencode/src/session/llm.ts#L1170):preface 訊息加 `providerOptions:{anthropic:{contextPreface:true}}`(opencms 版 api_system 標記)。
2. [convert.ts](../packages/provider-claude/src/convert.ts) `AnthropicMessage` 加 `isContextPreface?`;`convertPrompt` user case 從 providerOptions 帶過去。
3. `applyConversationCacheBreakpoint` 用 `f()` `while(messages[i]?.isContextPreface)i--` 跳過 preface → 兩個斷點落在最後兩則**真實對話** → second-to-last 與上一輪 last 重合 = 穩定 read-hit(官方原意)。

### 方法論教訓
連續推翻自己 3 個假設(T1 內容變動、斷點數、高頻塊毒化),根因是**有疑惑時該先讀 upstream 卻先理論**。官方 `f()` 的 api_system skip 一查就破案。**「有疑惑先讀 upstream」列為硬規矩。**
