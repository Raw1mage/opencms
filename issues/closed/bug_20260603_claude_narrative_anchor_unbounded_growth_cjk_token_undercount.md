# Bug: claude narrative anchor 無界成長 → compaction 一直跑但 context 不縮(真因 = `length/4` token 估算嚴重低估 CJK,A-tier `ai_paid` drain gate 永不觸發)

- **Date**: 2026-06-03
- **Severity**: High(claude-cli 長 session 進入「compaction 不停跑、prompt 卡在 ~200K+ 不降」的死亡螺旋;使用者直接回報「不行,一直 compaction,context 一直沒變小」)
- **Component**:
  - `packages/opencode/src/session/compaction.ts` — anchor token 估算 `Math.ceil(body.length / 4)`(L1157 前景 escalation、L1753 背景 A-tier enrichment gate);`shouldEnrichAnchor` 的 `aFloorTokens` 比較
  - 關聯:`context/claude-refactor` DD-23(A/B/C tier 壓縮模型)、narrative cumulative anchor(`anchor[n+1]=anchor[n]+tail`)
- **Status**: CLOSED — fixed, verified, and deployed (2026-06-03, main `3868e9c84`, plan `compaction_anchor-unbounded-growth`)。修法 = 升級**共用** `ToolBudget.estimateTokens` 為 CJK-aware(ASCII byte-identical),anchor enrichment gate 改用它(非 bespoke、非 claude-gated)。**線上即時坐實**:ses_17c309bc9ffe… 部署後 01:56 `compressing latest anchor` 觸發,anchor 106362→22584 token(DB payload 244KB→95KB),prompt 228K→125K。
  - **範圍修正**:此 bug **非 claude 專屬**。受害 session 實為 codex(gpt-5.5,ctx 272K)為主 + claude 混用;部署前 ENRICH-SKIP 多為 `claudePath:false`(codex ratio gate)。真因是共用 chars/4 對 CJK 低估,打掛**所有 provider** 的 anchor gate。標題的「claude」字樣為初診偏窄,實際 provider-agnostic。
  - **與 `bug_20260602_claude_cli_rapid_narrative_compaction_cascade`(斷點 thrash,迴圈 B)是不同真因**:那支是 cache 一暖一冷;本支是 anchor 無界成長(迴圈 A)。兩支均已修+部署。

---

## 1. 症狀

claude-cli 長 session 進入:compaction 反覆觸發,但每次 compaction 後 prompt **沒有變小**,仍貼在 ~200K+,於是立刻再 overflow → 再 compaction → 無限循環。使用者體感:「一直 compaction,context 一直沒變小。」

## 2. 證據(ses_17c309bc9ffe6YdSYqxKpgyZKA,`/home/pkcs12/projects/warroom`,claude-opus-4-8,session DB)

### 2.1 anchor(`summary=1`)payload **單調成長、永不下降**(bytes,chronological)
```
06-02 10:17   94,849
06-02 13:35  135,765
06-02 19:27  183,636   ← 前一支 RCA 的當晚
06-02 23:33  220,592
06-03 00:08  232,275
06-03 00:32  243,217
06-03 00:46  243,586   ← 最新
```
全 session **前 12 大訊息全部是 anchor**;最新 anchor = 單一 `text` part **243,261 bytes**。CJK-heavy → 實際 token ≈ **180–200K**(prompt 量到 cache_write=226K,扣 system ~32K 即 anchor 主體)。

### 2.2 post-compaction prompt 不降
```
00:44:32  ANCHOR
00:44:34  inp=2 cr=0 cw=225,998 prompt=226K  ← compaction 後 2 秒,prompt 仍 226K
00:45:13  ANCHOR
00:45:45  inp=2 cr=31,790 cw=195,671 prompt=227K
```
compaction 砍了訊息「數量」(array 縮成 3 則),但**單一 anchor 訊息就 ~180–200K token**,所以 prompt 砍不下去。

## 3. Root cause(已坐實)

narrative compaction 是 cumulative:`anchor[n+1].body = anchor[n].body + serialize_redacted(tail)`(只增不減)。唯一能**縮小** anchor 的是背景 `ai_paid` A-tier re-summarisation。它的觸發 gate 用 anchor token 數判斷,但 **token 數一律用 `Math.ceil(body.length / 4)` 估算**(compaction.ts L1157、L1753、及全檔 ~15 處):

- 本 anchor:`243,261 / 4 ≈ 60,815` token(估算)。**實際 ~180K**(CJK 約 1–1.5 char/token,`/4` 低估 ~3–4×)。
- 背景 A-tier gate(L1774–1796 `shouldEnrichAnchor`,claude 走 **絕對** `aFloorTokens = aCompactTokens = 100K`):`narrativeTokens(估 60K) > 100K`?**否** → `belowGate=true` → **enrichment 每次都被 skip** → anchor 永不被壓縮 → 持續 narrative append → 無界成長。
- 前景 escalation(L1157–1167)gate = `anchorTokenEstimate >= contextLimit * 0.5`(claude 1M × 0.5 = **500K**):60K(甚至實際 180K)都 < 500K → **永不 escalate**。這條對 claude 200K B-regime 本就 unreachable(L1764–1773 的 DD-23 P4-2 註解已知 ratio gate 不可達,才改用絕對 aFloor;但 aFloor 路徑被 `/4` 低估打掛)。

**淨效果**:anchor 實際早就 >100K(該被 A-tier 壓縮),但 `/4` 估算讓它「看起來」只有 60K < 100K floor → drain 永不跑 → anchor 漲到 ~180–200K 占滿整個 200K B-budget → 每輪 compaction 後 prompt 仍 ~200K+ → 立即 re-overflow → 死亡螺旋。

## 4. 修法方向(待 plan 定案)

1. **治本:anchor gating 改用準確 token 數**,不要 `length/4`。用真實 tokenizer 計數(或 CJK-aware 估算)替換 L1157 / L1753(至少這兩個 gate),讓背景 A-tier `ai_paid` 在 anchor 真的 >aFloor(100K)時就觸發壓縮。
2. **(選配)前景 escalation 門檻**:`contextLimit*0.5`(500K)對 claude 200K B-regime 不可達;改綁 `bCompactTokens` 的分數(如 anchor ≥ 0.5×bCompactTokens=100K 即 escalate),與 aFloor 一致。
3. **驗收**:anchor token 估算誤差(CJK)收斂;長 session anchor 不再無界成長(A-tier drain 會在 ~100K 觸發並壓回);compaction 後 prompt 實際下降。
4. **codex 絕緣**:claude-gated 路徑;codex/copilot 的 ratio gate 與既有 token 估算行為不變(INV-0 守界測試)。

## 5. 立即緩解(給使用者)

既有被毒 session(anchor 已 243KB)**無法自行恢復**(drain gate 因低估而永不觸發)→ **開新 claude-cli session** 是唯一即時止血;新 session anchor 從小起步。修法到位後,新舊 session 的 anchor 都會在 ~100K 被 A-tier 壓回。

## 6. Related
- `bug_20260602_claude_cli_rapid_narrative_compaction_cascade`(斷點 thrash,迴圈 B,已修+部署 2026-06-03;**不同真因**,本支是迴圈 A)
- plan `provider-claude_conversation-cache-breakpoint`(該支的 plan;其 OUT-of-scope 明列「200K B-threshold / 迴圈 A 回填另記」——即本 issue)
- plan `context/claude-refactor`(DD-23 A/B/C tier 壓縮模型出處;L1764–1773 P4-2 註解)
