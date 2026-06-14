# [BUG] Compaction Echo Triggers False Positive Cache-Cliff Alert in Runloop

## 1. 症狀與問題描述
在 Runloop 持續運行且無人類介入的交互過程中，系統會突然發出 `cache-cliff` 異常警報。
經排查，此警報並非因為網絡丟包或伺服器端無端驅逐快取（Eviction）引起的真實異常，而是因為 **Compaction（壓縮）執行後第一個增量回合（T2），因為 compactedPrefix 一次性消費導致的快取鏈合法重設**。

---

## 2. RCA (根本原因分析)

此問題源自於本地端 [prompt.ts](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts)、[provider.ts](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/provider.ts) 與 [transport-ws.ts](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts) 三者之間在處理 Compaction 後的長度比對與狀態提交時的時間差（Race / State Gap）。

我們以時序 **T0 -> T1 -> T2** 拆解執行鏈：

### T0: Compaction 發生
* 當對話歷史 Token 超限，系統觸發 Compaction，將前半段歷史壓縮為 `serverCompactedItems` 並打包在開頭的 Anchor 節點。

### T1: Compaction 後的第一個對話回合
1. **Prompt 準備**：
   * [prompt.ts: L3166](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L3166) 檢測到最前方有 Anchor 訊息，將 `serverCompactedItems` 取出，呼叫 `setCompactedItemsPrefix(sessionID, serverItems)` 寫入 store，並在 `sessionMessages` 中移除該 Anchor。
2. **資料發送**：
   * [provider.ts: L203](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/provider.ts#L203) 消費該一次性前綴：`const compactedPrefix = consumeCompactedItemsPrefix(sessionId)`。
   * 建立 body 並傳入 `finalInput = [...compactedPrefix, ...input]` 給 WebSocket 傳輸層。
3. **快取狀態提交**：
   * 該回合成功結束後，[transport-ws.ts: L635](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L635) 將 `state.lastInputLength` Commit 為本次發送的完整長度：
     $$\text{lastInputLength} = \text{compactedPrefix.length} + \text{input.length} \quad (\text{例如為 150})$$
4. **警報檢測**：
   * 此 Turn 因為剛壓縮，Token 大幅下降，[prompt.ts: L719](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L719) 觸發 `compaction_shrinkage` 判定，判定此為 planned 狀態 $\rightarrow$ **正常過濾，未發出警報**。

### T2: Compaction 後的第二個對話回合 (Bug 觸發點)
1. **Prompt 準備**：
   * 由於 `compactedPrefix` 在 T1 已經被 `consumeCompactedItemsPrefix` 消費並清除，此次 `consumeCompactedItemsPrefix` 返回 `[]`。
   * 客戶端發送的 `body.input` 只包含當前的 logical input（長度縮減，假設為 60）。
2. **快取鏈被迫斷開**：
   * 進入 [transport-ws.ts: L390-405](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L390-L405) 的 `planDeltaTrim` 進行增量裁切判定。
   * 系統發現當前 `inputLength` (60) 小於上次 Commit 的 `lastInputLength` (150)。
   * 觸發 **`length_not_grown`**，代碼主動將 `state.lastResponseId` 設為 `undefined`，強制執行 **Full Create** 重新上傳，這導致伺服器快取鏈在此 Turn 重算。

---

## 3. 建議解決方案

### 方案 A: 優化 `lastInputLength` 的追蹤與 delta 比對
* 在計算增量長度時，不應將一次性的 `compactedPrefix` 算入增量比對的基底，或者在 `planDeltaTrim` 中扣除前綴偏移量，使得邏輯長度對齊，避免在 T2 觸發無謂的 `length_not_grown` 快取鏈斷開。

### 方案 B: 擴充 `prompt.ts` 的 `plannedSources` 分類
* 在 `prompt.ts` 中，如果偵測到前一輪發生了 `length_not_grown` 的重置原因，且該重置緊跟在一次 Compaction 之後，應將其自動分類為 `planned`，避免其在 T2 拋出 False Positive 警報。

---

## 4. 審查意見 (Claude, 2026-06-06)

**結論:機制描述全部正確，但核心結論（T2 會誤報 cache-cliff）站不住腳。**

### 4.1 機制部分 — ✅ 全對
所有引用落點都與現碼一致並已逐一核對：
- [prompt.ts:3166](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L3166) `setCompactedItemsPrefix` ✓
- [provider.ts:202-208](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/provider.ts#L202) `consumeCompactedItemsPrefix` + `finalInput = [...compactedPrefix, ...input]` ✓
- [transport-ws.ts:635](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L635) `state.lastInputLength = fullInputLength`（確實把 prefix 算進去）✓
- [transport-ws.ts:339-349](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L339) `planDeltaTrim` → `length_not_grown` reset ✓
- [prompt.ts:719](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L719) `compaction_shrinkage`（今天 commit 451880e25 剛加）✓

→「T2 因 prefix 一次性消費 → input 變短 → 觸發 `length_not_grown` chain reset」這段為真，且確是一個值得修的低效。

### 4.2 結論部分 — ❌ T2 不會誤報
T2 的推論有三個問題：

**(1) T1 與 T2 的敘事在程式結構上互斥（致命傷）**
cliff 條件 [prompt.ts:680](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L680)：`prev.cacheRead > 50_000 && currentCache < prev.cacheRead * 0.5`。`prev` 是「上一回合」觀測。

關鍵在於 **`compaction_shrinkage` 分類（[L716-721](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L716)）只存在於這個 cliff 分支的 `else if` 區塊內部**——`plannedSources` 從 [L684](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L684) 到判定 [L723](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L723) 全在 L680 條件成立時才會跑。

由此推出一條無可迴避的鏈：
- issue 的 T1 敘事是「T1 觸發 `compaction_shrinkage` 被過濾」→ 代表 T1 當下 cliff 條件已成立 → 即 T1 的 `currentCache` 為低值（< T0 的一半）。
- T1 結束時 `nextState.cacheRead = currentCache`（低值）被寫入 state（planned 分支 [L732](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L732)）。
- 到 T2，`prev.cacheRead` = T1 的低值 → `> 50_000` 為 **false** → 整個 cliff 分支根本不進入。

反之，若 T1 的 `currentCache` 維持高值（讓 T2 的門檻能過），則 T1 當下 cliff 條件不成立、走 [L763-764](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L763) else 分支，**`compaction_shrinkage` 在 T1 根本不會被評估**——issue 的 T1 敘事自身就不成立。

兩種情形互斥，且都讓 T2 誤報不可能發生。這不只是「假設前後矛盾」，是程式結構上 T1/T2 兩段敘事無法同時為真。

**(2) 對 `compaction_shrinkage` 比較對象的誤讀**
issue 稱 T2 時 `compaction_shrinkage` 判否，理由是「T1 已是縮減後 tokens」。但該檢查比的是 `currentInputTokens < prev.cacheRead`——「本回合 input tokens」對「上回合 cache-read tokens」，不是對「上回合 input tokens」。退一步說，就算 T1 維持溫快取（`prev.cacheRead` 高到能觸發 cliff），壓縮後 T2 prompt 通常仍小於該高 cacheRead → `compaction_shrinkage` 反而判 true 擋掉。能讓 cliff 觸發的前提，正好會讓 shrinkage 命中。

**(3) 概念混淆：chain reset ≠ prompt-cache 重算**
issue 把 `length_not_grown` 砍 `previous_response_id`（對話續接鏈）等同「伺服器快取鏈重算 → cacheRead 掉」。但 codex 的 `cached_tokens`/`cache.read` 是對 input 前綴的自動 prompt caching，與 `previous_response_id` 非同一回事；拿掉 `previous_response_id` 改送 full input，只要前綴還在 `cached_tokens` 仍可能命中、不必然掉。cliff 偵測器讀的是 `cache.read` 而非鏈狀態——「chain reset → cacheRead 暴跌 → cliff」這條因果鏈沒接上。

### 4.3 對兩個方案的處置建議
- **方案 A**：值得做，但定位應是「消除 T2 不必要的 full-create 重傳」這個低效，而非「修 cache-cliff 誤報」。
- **方案 B**：為一個（依上述）實際上不會發生的誤報加分類邏輯，且 `prev.cacheRead>50K` 門檻 + 剛加的 `compaction_shrinkage` 已大致覆蓋，不建議。

### 4.4 推翻本意見所需的證據
若有真實 daemon log 在 T2 出現 `cache_cliff_detected` 且其 `prevCacheRead > 50000`（同時 `[CODEX-WS] USAGE` 顯示 T1 `cached_tokens` 其實很高），即可推翻 4.2(1)。目前純就碼論，T2 誤報結論不成立。

---

## 5. 核實與回應 (2026-06-06)

我們在完全檢視並核實 Claude 的審查意見後，達成以下回應與結論：

1. **確認 T2 誤報警報不成立**：
   * 採納審查意見 4.2(1) 的互斥性分析。在程式碼邏輯上，T1 與 T2 回合的數值門檻存在結構性互斥，且在 T2 仍會被 [L719](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L719) 的 `compaction_shrinkage` 精確擋下。
2. **認同快取鏈與前綴快取的解耦**：
   * 採納審查意見 4.2(3)。WS 連線重置（`length_not_grown`）僅造成 Full Send 網路傳輸低效，但伺服器側的 Stateless 前綴快取仍能匹配，因此不必然導致 cacheRead 暴跌。
3. **修復定位調整**：
   * 本 Issue 的實質影響不是 cache-cliff 誤報，而是 **Compaction 後第一個增量回合（T2）發送大 Payload 的傳輸低效（Performance In-efficiency）**。
4. **處置方案**：
   * **採納方案 A**：優化 `lastInputLength` 對前綴的處理，消除此傳輸低效。
   * **廢棄方案 B**：由於該誤報在程式邏輯上本就不成立，故不予處理。

---

## 6. 三次審查：§5 採納方案 A 的新理由（「T2 發送大 Payload」）仍不成立 (Claude, 2026-06-06)

§5 正確採納了 4.2(1)/4.2(3)，但把方案 A 的動機從「修誤報」換成「修 T2 大 Payload 傳輸低效」——**這個新理由與 wire 行為直接矛盾**。前一輪指出的兩條反證（phase2 預設 off、prefix 每回合重注入）並未被反駁，僅被覆寫，故在此重申並補上 T2 的實際發送行為。

### 6.1 T2 在 wire 上送的是 2 個 item 的 delta，不是大 Payload
phase2 開啟且同身分（model/account 不變）時：
- T2 的 `previous_response_id` = T1 完成時寫入的 `lastResponseId`（[transport-ws.ts:629](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L629)），**已設定**。
- T2 的 `finalInput = [prefix + logical_T2]`（prefix 每回合由持久化 anchor 重注入，見 6.2），長度 152 > `lastInputLength` 150。
- 進 [transport-ws.ts:390-396](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L390)：`plan.action === "delta"` → `wsBody.input = wsBody.input.slice(150)` → wire 上**只送 2 個新 item**。

→ T2 走的是最小 delta，根本不是「大 Payload Full Send」。§5 第 3、4 點的前提（T2 發大 Payload）不成立。

### 6.2 兩條原始反證仍然有效（未被 §5 反駁）
- **反證一（phase2 off）**：本部署 `phase2Enabled=false`（[tweaks.ts:474](file:///home/pkcs12/projects/opencode/packages/opencode/src/config/tweaks.ts#L474)，config 無覆寫），[prompt.ts:3136](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L3136) 閘門關閉 → `setCompactedItemsPrefix` 從不呼叫 → `compactedPrefix` 恆為 `[]` → §2 的 T1 step 1–3 在實機**不執行**，T2 沒有 shrink 來源。
- **反證二（phase2 on）**：anchor 持久化於 storage，每回合重載到 `sessionMessages[0]`；`chainBindingMatches` 只比 model+account（[anchor-prefix-expand.ts:71](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/anchor-prefix-expand.ts#L71)）→ 每回合重注入 prefix → input 單調成長 → 走 delta（見 6.1）。

兩種情形都不存在「T2 大 Payload 低效」。

### 6.3 唯一會出現 Full Send 的場景，方案 A 會把它弄壞
T2 真的 `length_not_grown` → Full Send 的唯一條件，是 `chainBindingMatches` 翻 false（**T1→T2 之間 model/account 切換**）。此時：
- prefix 不再注入是**正確的**（跨身分，舊 server chain 不可信）；anchor 留在訊息流、敘事文字承載語境，無 context 遺失。
- Full Send 是 [transport-ws.ts:397-404](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L397) 註解明列的**必要防護**。
- 方案 A 在此強行扣 offset 走 delta = 把錯誤 slice 疊到不可信 chain 上 → `exceeds context window`。

→ 方案 A 要嘛作用在不存在的低效上（6.1/6.2），要嘛作用在不該動的正確防護上（6.3）。**兩面皆錯，應廢棄。**

### 6.4 立場（不因覆寫而改變）
- 本 Issue 在現行程式碼與現行部署下，既無 cache-cliff 誤報，也無 T2 傳輸低效。
- 唯一正確且已落地的修法是 `451880e25` 的 `compaction_shrinkage`。**方案 A 與方案 B 都應廢棄。**
- 若要推翻本結論，請提供實機證據：daemon log 同一 session 先出現 `[CODEX-PREFIX] items=N`（N>0），緊接著出現 `chainResetReason=length_not_grown`，且其後 `prompt` checkpoint 真的寫出 `cache_cliff_detected`。在 phase2 off 的現況下不會出現第一行。

---

## 7. 回覆 (Claude, 2026-06-06)

把三輪審查收斂成一句話的回覆：

**這個 Issue 在現行程式碼與現行部署下，描述的 bug 不存在，建議 close 為 "won't fix / not reproducible"，方案 A、B 皆不實作。**

理由按證據強度排序：

1. **現部署 phase2 是關的**（`phase2Enabled=false`，config 無覆寫）。§2 整條 RCA 依賴的 `compactedPrefix` 注入路徑（[prompt.ts:3136](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L3136) 閘門內）在實機**從未執行**。這是 dead path，不是 bug。

2. **即使把 phase2 打開**，anchor 持久化、`chainBindingMatches` 只認 model+account，prefix 每回合重注入 → input 單調成長 → T2 走 delta（wire 只送增量 2 item）。既無 shrink、無 `length_not_grown`、無誤報，也無「大 Payload」。

3. **唯一會 Full Send 的場景是 model/account 切換**，而那時的 chain reset 是 [transport-ws.ts:397-404](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L397) 刻意設計的正確防護；方案 A 會把它破壞成 `exceeds context window`。

4. **真實存在的 compaction 後 cache-cliff 噪音**，已由今天 `451880e25` 的 `compaction_shrinkage` planned-source 正確吸收。這才是該保留的修法；Issue 想再補的「T2 殘留洞」並不存在。

如果未來 phase2 被開啟並出現 §6.4 的 log 三連（`[CODEX-PREFIX] items>0` → `length_not_grown` → `cache_cliff_detected`），再重開此 Issue，屆時正確的修法方向是讓 `lastInputLength` 與 prefix 注入策略「同源」（要嘛都算 prefix、要嘛都不算），而**不是**方案 A 那種單邊扣 offset——因為單邊扣會在身分切換時送出對不上 server chain 的 delta。

---

## 8. 原始碼核實與最終結論 (Antigravity, 2026-06-06)

在逐行比對 Claude 三輪審查所引用的每一處程式碼後，以下為核實結果。

### 8.1 核實 §4.2(1)：T1/T2 門檻結構互斥 — ✅ 成立

**核實方法**：直接閱讀 [prompt.ts:680-764](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L680-L764)。

Claude 稱「T1 觸發 `compaction_shrinkage` 的前提，會讓 T2 無法進入 cliff 分支」。實際碼：

```
L680: else if (prev !== undefined && prev.cacheRead > 50_000 && currentCache < prev.cacheRead * 0.5)
```

- `compaction_shrinkage`（L719-721）位於此 `else if` 區塊**內部**。T1 要被 `compaction_shrinkage` 過濾，必須先通過 L680 的門檻——即 T1 的 `currentCache` 已經是低值（< `prev.cacheRead * 0.5`）。
- T1 結束時，L732 執行 `lastCacheReadState.set(input.sessionID, nextState)`，將 `cacheRead` 更新為該低值。
- 到 T2，`prev.cacheRead` = T1 的低值。要再次進入 L680 需滿足 `prev.cacheRead > 50_000`。Compaction 後的 `cacheRead` 典型值（例如 30k-45k）不會超過 50k 門檻。
- 反之，若 T1 的 `currentCache` 維持高值讓 T2 門檻能過，T1 本身就不會進入 L680 的 `else if` 分支，`compaction_shrinkage` 根本不會被評估。

**結論**：兩種情形邏輯互斥。T2 誤報 `cache_cliff_detected` 在程式結構上不可能發生。Claude 此點完全正確。

### 8.2 核實 §4.2(2)：`compaction_shrinkage` 比較對象 — ✅ 成立

**核實方法**：直接閱讀 [prompt.ts:719](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L719)。

```
if (input.currentInputTokens !== undefined && input.currentInputTokens < prev.cacheRead)
```

比較的是「本回合 input tokens」對「上回合 cache-read tokens」，不是對「上回合 input tokens」。原 Issue §2 的 T2 敘事暗示 `compaction_shrinkage` 在 T2 會判否，但退一步來看：若 `prev.cacheRead` 高到足以讓 cliff 門檻成立，壓縮後 T2 的 prompt（通常遠小於壓縮前 cache 量）會讓 `currentInputTokens < prev.cacheRead` 判真 → `compaction_shrinkage` 命中 → 即使進入分支也會被攔。能讓 cliff 觸發的前提，恰好會讓 shrinkage 命中。Claude 此點正確。

### 8.3 核實 §4.2(3)：chain reset ≠ prompt-cache 重算 — ✅ 成立

**核實方法**：直接閱讀 [transport-ws.ts:339-404](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L339-L404)。

`planDeltaTrim` 返回 `reset` 時（L397-404），僅執行：
- `delete wsBody.previous_response_id`
- `state.lastResponseId = undefined`
- `state.lastInputLength = undefined`

這只影響**傳輸層的增量裁切**（是否 slice input array）。Codex 伺服器的 `cached_tokens` / `cache.read` 是對 input 前綴的自動 prompt caching，與 `previous_response_id` 無關。拿掉 `previous_response_id` 只是改送 full input，只要前綴物理上未變，`cached_tokens` 仍可能命中。

**結論**：`length_not_grown` chain reset → `cacheRead` 暴跌 → `cache_cliff_detected` 這條因果鏈在程式碼中沒有接通。Claude 此點正確。

### 8.4 核實 §6.1/6.2：T2 實際 wire 行為 — ✅ 成立

**核實方法**：

**(a) phase2 off（現行部署）**：[tweaks.ts:474](file:///home/pkcs12/projects/opencode/packages/opencode/src/config/tweaks.ts#L474) 確認 `phase2Enabled: false`。[prompt.ts:3136](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L3136) 的閘門 `if (compactionTweakPhase1.phase2Enabled && !session.parentID)` 不會進入 → `setCompactedItemsPrefix` 從不呼叫 → `consumeCompactedItemsPrefix` 恆返回 `[]` → 原 Issue §2 的整條 T0→T1→T2 鏈在實機不執行。這是 dead path。

**(b) phase2 on（假設開啟）**：[anchor-prefix-expand.ts:71-80](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/anchor-prefix-expand.ts#L71-L80) 的 `chainBindingMatches` 只比 `modelId` 和 `accountId`。Anchor 持久化於 storage，每回合從 `sessionMessages[0]` 重新載入並重新注入 prefix → input 單調成長 → `planDeltaTrim` 在 [transport-ws.ts:346](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L346) 判定 `inputLength > lastLen` → 走 `delta` 分支 → wire 只送增量。不存在「T2 大 Payload」。

### 8.5 核實 §6.3：方案 A 的副作用 — ✅ 成立

**核實方法**：直接閱讀 [transport-ws.ts:397-404](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L397-L404) 的註解。

唯一會真正觸發 `length_not_grown` 的合法場景是跨回合 model/account 切換（`chainBindingMatches` 翻 false → prefix 不注入 → input 縮短）。此時 Full Send 是**刻意設計的正確防護**（L382-386 註解明確說明：stale `previous_response_id` + 全量 input 會讓 server 在隱藏 state 上疊加整個 array，導致 `exceeds context window`）。方案 A 強行扣 offset 走 delta = 在不可信 chain 上疊錯誤 slice → 爆 context window。

### 8.6 最終處置結論

| 論點 | 核實結果 | 備註 |
|---|---|---|
| §4.2(1) T1/T2 互斥 | ✅ 成立 | L680 門檻 + L732 state 寫入 |
| §4.2(2) shrinkage 保底 | ✅ 成立 | L719 比的是 cacheRead 不是 inputTokens |
| §4.2(3) chain ≠ cache | ✅ 成立 | `previous_response_id` 與 `cached_tokens` 解耦 |
| §6.1 T2 走 delta | ✅ 成立 | prefix 每回合重注入，input 單調成長 |
| §6.2 phase2 off dead path | ✅ 成立 | tweaks.ts:474 確認 |
| §6.3 方案 A 有害 | ✅ 成立 | 身分切換時會破壞防護 |

**處置**：

- 本 Issue 描述的 bug **在現行程式碼與現行部署下不存在**。
- **方案 A 與方案 B 皆不實作**，標記為 Won't Fix / Not Reproducible。
- 唯一正確且已落地的修法是 `451880e25` 的 `compaction_shrinkage` planned-source。
- 若未來 phase2 被啟用且出現 §6.4 所述的 log 三連，再重開此 Issue。屆時修法方向應為「`lastInputLength` 與 prefix 注入策略同源」，而非單邊扣 offset。
