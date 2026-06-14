# Bug: codex transport `lastInputLength` 在送出請求時無條件推進 → abort turn 後與 `lastResponseId` 脫鉤 → 下一輪 `length_not_grown` 強制 chain reset → 自我製造 cache cliff

- **Date**: 2026-06-02
- **Severity**: Medium-High(走 send-watchdog `ws_send_timeout` 這條**不經 `doInvalidate`** 的窄 abort 路徑時,短暫失敗 turn 會被轉成一次「整包重送」的 cache cliff。實測 session ≤3/13 cliff 為**上界**——待 §6 log 坐實,其中部分可能是 `doInvalidate` 無鏈重送而非本機制;但仍為**完全可控**的我方 bug)
- **Component**: `packages/provider-codex/src/transport-ws.ts`(WS delta 模式的 chain 狀態管理)
- **Severity (revised post-W4)**: **Low–Medium** — 修法已部署運作,W1 forensic JSONL 實測 phantom `length_not_grown` = **0**(見 §10)。bug 真實存在(code 推理 + reviewer §9 核實),但活觸發面窄、修後未再出現。
- **Status**: CLOSED — observing soak accepted; commit-on-completion fix deployed with forensic validation showing no phantom length_not_grown.
  - **Observing since**: 2026-06-02 部署
  - **Exit → closed/**: soak 數日,長 codex session 持續 phantom length_not_grown=0(`ws-chain.jsonl` 監看)
  - **Regress → open**: 出現 `length_not_grown` 且 `now≈prev`(非 shrink)= phantom 復發
  - **DD-1 誠實邊界**:W1 與 W3 同時 land,無同一指標的 pre-fix baseline;證據為「修後 phantom 類為空」的結構性證明,非實測 N→0 差值。

---

## 1. 症狀

使用者回報:codex 的 **cache cliff 頻率很高**。session `ses_17c309bc9ffe6YdSYqxKpgyZKA`(warroom,gpt-5.5,2026-06-01 23:31 → 06-02 01:52,467 turns,跨 3 個訂閱帳號輪替)。每次 cliff = 一個 turn 的 `cache_read` 從 ~120K 崩到 anchor floor(24064)或 0,該 turn 付全額未命中的 ~120K input 重送。

**先澄清使用者的原始疑慮(已排除)**:cliff **不是**「我們的 prefix 自己每 turn 變動把 cache 弄破」。三個獨立鐵證:
- cliff 底部**永遠精確落在 24064**(9 次、橫跨 3 帳號、2.5 小時)。prefix 若會變,連 24064 都不會命中。
- cache **安然穿過午夜**(00:00:04 / 00:00:10 cr 仍 ~130K),連 `environment_context` 的 `current_date` 翻日都沒破 cache。
- 每次 cliff **下一個 turn(~8 秒)就重建回 ~118K**——被破壞的 prefix 不可能自己長回來。

→ prefix byte-stable。問題在 **chain(`previous_response_id`)被 reset**,不在 prefix。

## 2. 證據(ses_17c309bc9ffe6YdSYqxKpgyZKA)

- 全 session cache 命中率 **95.2%**(cache_read 53.9M vs uncached input 2.7M / 467 turns)→ cache 系統本質健康,cliff 是 2.8% 的尖刺,不是普遍失效。
- 全 session **13 次真 cliff**(已排除空 turn 誤判);**11 個無 completion 的空 turn**(5 個 compaction anchor、5 個真 abort、其餘邊緣)。
- **abort turn 的下一個 real turn**:**3/5 變 cliff、2/5 仍 warm**。非確定性 → 取決於下一輪 array 有沒有長過 `lastInputLength`,正是 `length_not_grown` 的指紋。
- 跨午夜逐 turn(business 帳號,無 compaction、無 rotation):
  ```
  23:59:36 cr= 24064  ← cliff(chain 掉)
  23:59:44 cr=117760  ← 下一 turn 即重建
  00:00:04 cr=130048  ← 跨午夜,cache 未掉
  00:01:36 cr=136704
  00:02:13 cr= 24064  ← 又一次 cliff
  00:02:33 cr=117760  ← 又是一 turn 重建
  ```

## 3. Root cause(機制鏈,§3.4 server-evict 段為待證)

[transport-ws.ts:369](../packages/provider-codex/src/transport-ws.ts#L369):
```js
state.lastInputLength = fullInputLength   // ① 在「組請求時」無條件設定,先於 turn 是否成功
```
但 [transport-ws.ts:565](../packages/provider-codex/src/transport-ws.ts#L565) `state.lastResponseId = responseId` **只在 `response.completed` 時**更新,並在 [line 566-570](../packages/provider-codex/src/transport-ws.ts#L566) 才把 `{lastResponseId, lastInputLength}` **成對** persist 到 disk。

delta 守門在 [transport-ws.ts:356](../packages/provider-codex/src/transport-ws.ts#L356):
```js
if (lastLen > 0 && wsBody.input.length > lastLen) {  // 嚴格長大才沿用 chain
  wsBody.input = wsBody.input.slice(lastLen)          // 送 delta
} else {
  chainResetReason = `length_not_grown(...)`           // 否則砍 chain、整包重送
  delete wsBody.previous_response_id
  state.lastResponseId = undefined
  invalidateContinuationFamily(sessionId)
}
```

**脫鉤機制**(⚠️ 經 §9 review 修正:只在 abort **不經 `doInvalidate`** 時成立):
1. turn N 送出時 ① 把 `lastInputLength` 推進到 N 的 `fullInputLength`(= L_N)。
2. turn N **中途失敗**且該路徑**沒有呼叫 [`doInvalidate()` L475](../packages/provider-codex/src/transport-ws.ts#L475)** → `lastResponseId` 停在 N-1、`lastInputLength` 留 L_N。
   - ⚠️ **絕大多數 abort 路徑會走 `doInvalidate`**(`doInvalidate` 同時清掉 `lastResponseId` **與** `lastInputLength`):onclose-while-streaming(= ws_truncation,[L649](../packages/provider-codex/src/transport-ws.ts#L649))、onerror([L623](../packages/provider-codex/src/transport-ws.ts#L623))、idle timeout、`response.failed`/`incomplete`、server error frame、`previous_response_not_found`。這些下一輪 `lastResponseId===undefined` → 不設 `previous_response_id` → 走「**無鏈整包重送**」,**不是** `length_not_grown`。初版把 ws_truncation/rate-limit/server burp 列在這裡是**錯的**。
   - ✅ **真正命中本機制的窄路徑**:send-watchdog **`ws_send_timeout`**([L436–447](../packages/provider-codex/src/transport-ws.ts#L436))——先 `state.status="failed"` 再 `ws.close()`,使 onclose 的 `status==="streaming"` 守門([L648](../packages/provider-codex/src/transport-ws.ts#L648))為假 → **跳過 doInvalidate** → 留下幻影 L_N。另有 WS-reuse `catch{}`([L844](../packages/provider-codex/src/transport-ws.ts#L844));使用者中斷視 WS 是否隨後 close 而定,不確定。
3. 此刻狀態不一致:`lastResponseId` 對應 N-1 的長度,但 `lastInputLength` 已是 L_N(幻影,從未被 completion 確認)。
4. turn N+1:N 沒 commit,陣列長度 ≈ L_N。delta 檢查 `input.length(L_N) > lastLen(L_N)` → **不成立** → `length_not_grown` → **chain reset → 整包重送 → cache cliff**。
   - 若 N+1 夾帶 retry/Continue item 而長過 L_N → 走 delta(warm)。**§2 的 2/5 warm 反而佐證了這條窄機制**:若 abort 一律清鏈早該 5/5 cliff,有 2 次 warm 代表那 2 次保住了鏈(非-doInvalidate 路徑)。
   - ⚠️ 但 `length_not_grown` 與「無鏈重送」在 `cache_read` 上**長得一樣**(都崩 24064),所以「3/5 cliff 屬於本機制」是**未經 WS log 證實的歸因上界**,部分可能其實是 doInvalidate 無鏈路徑。
5. (待證)另有 ~3 次 cliff 落在 mid-stream(23:59 / 00:02 / 01:16),非 abort、非 compaction → 可能 codex server 真 eviction,**或**我方 cache-cliff 偵測器(prompt.ts)自己 invalidate。無 WS log 無法分離。

**核心**:`lastInputLength` 與 `lastResponseId` 在語意上是一對(server 在 `responseId` 之後的狀態 = 吃了 `lastInputLength` 個 item)。① 把它**獨立於 `lastResponseId` 提早設值**,破壞了這個配對 —— disk 那層(line 568)成對寫是對的,是 in-memory 這層提早設值闖的禍。

## 4. 13 次 cliff 成因分解(本 bug 只涵蓋第 2 列)

| 成因 | 次數 | 可控性 | 機制 |
|---|---|---|---|
| compaction 重寫 anchor | 5 | ✅ 另案 | narrative compaction 換新 prefix → codex 必冷(多半 item-count 350 在 context 才 ~140K/240K 時就觸發) |
| **abort → `length_not_grown` 自我 reset** | **≤3(上界)** | ✅ **本 bug** | 僅 send-watchdog `ws_send_timeout` 等**不經 `doInvalidate`** 的路徑;與「無鏈重送」cache_read 同形,需 §6 log 分離 |
| mid-stream 真 chain loss | ~3 | ❌ 待證 | 真 server eviction 或偵測器自我 invalidate(需 WS log) |
| 早期 warm-up / 邊緣 | ~2 | — | |

## 5. 提議修法(治本,低風險)

把 `lastInputLength` 改成**只在 `response.completed` 時、與 `lastResponseId` 成對 commit**:

- 移除 [line 369](../packages/provider-codex/src/transport-ws.ts#L369) 的無條件 `state.lastInputLength = fullInputLength`。
- 在 completion handler([line 565](../packages/provider-codex/src/transport-ws.ts#L565) 附近)設 `state.lastInputLength = fullInputLength`(`fullInputLength` 在 closure scope),再 persist。

**為何安全**:
- delta 計算(line 356)讀的是「上一個成功 turn」的 `lastInputLength`(改後不變,正確)。
- 唯一行為變化:**失敗 turn 不再推進 `lastInputLength`** → 短暫 abort 後,N+1 的陣列(含 N 嘗試送的 item + retry)會長過「上一個成功長度」→ delta 正常沿用 → **不再強制 reset**。
- compaction 後 array 縮短 → 仍 < 上一個成功長度 → `length_not_grown` 照常 reset(預期的 compaction cliff,**不受影響**)。
- 首 turn(`lastInputLength` undefined)→ `lastLen>0` false → 全量送,首次 completion 設值。不受影響。
- ⚠️ **走 `doInvalidate` 的 abort 路徑此修法不改變任何行為**(它們本就清空兩欄、無鏈重送)→ 本修法能消掉的 cliff 數比「3 次」更受限,實際覆蓋率須待 §6 log 看 `chainResetReason=length_not_grown` 的出現次數才知。

## 6. 待坐實 / evidence gap(必做,否則 §3.4 永遠是假設)

`[CODEX-WS] REQ / CHAIN / USAGE`([line 392](../packages/provider-codex/src/transport-ws.ts#L392) / [573](../packages/provider-codex/src/transport-ws.ts#L573) / [584](../packages/provider-codex/src/transport-ws.ts#L584))全走 `console.error` → daemon stderr → **無人接收、未落地**。所以本 session 的 transport 真相(每 turn `delta=?` / `chainResetReason=?` / `cached_tokens=?`)已滅失。

**建議**:把這幾行 `[CODEX-WS]` 落地到檔案(或轉成結構化 telemetry / recentEvents)。下個長 codex session 即可:
- 直接看 `chainResetReason=length_not_grown` 出現次數 → 坐實本 bug 修法的覆蓋率。
- 分離 §3.4 的 mid-stream cliff 到底是 server evict(`hasPrevResp=true` 但 server 回 cached=0)還是我方 invalidate(`hasPrevResp=false`)。

## 7. 不在本 bug 範圍(另開/另查)

- **compaction 佔 5/13**:最大宗。需先用 §6 的 log 確認是 item-count(350)還是 token 觸發,才決定調門檻或改 anchor-preserving。**勿在坐實前先動 compaction 核心路徑。**
- **mid-stream ~3/13**:待 §6 log 分離 server-evict vs 偵測器自我 invalidate 後再判。

## 8. Related

- `prompt.ts` cache-cliff 偵測器(`deriveObservedCondition`,line ~637)— planned/unplanned 分類器(commit b58867e69)成功擋掉 2026-05-19 的 compaction cascade;本 bug 是它**上游**的 chain reset 源,偵測器管不到。
- MEMORY: `project_cache_cliff_detection.md`(分類器)/ `project_overflow_replay_path_c_toolchain.md`(compaction 邊界)。
- 2026-05-19 incident ses_1c875cc15ffe5ds18JVdNAT4e6(cascade 原型,已被分類器修掉)。

---

## 9. 核實回覆(reviewer, 2026-06-02)

逐行對著 [transport-ws.ts](../packages/provider-codex/src/transport-ws.ts) 拆解過。**根因方向與行號定位正確、修法可行;但 §3 中段的 abort 歸因被高估——報告漏掉了 `doInvalidate()`。** 細節:

### 9.1 完全屬實(行號/程式碼/脫鉤事實)

- [L356](../packages/provider-codex/src/transport-ws.ts#L356) 嚴格長大守門、[L369](../packages/provider-codex/src/transport-ws.ts#L369) 無條件且**先於 stream 啟動**同步推進、[L565–570](../packages/provider-codex/src/transport-ws.ts#L565) 只在 `response.completed` 成對 commit——三處引用**精確**。
- 補兩個機制成立的必要前提(報告沒寫但都成立):
  - in-memory `state` **跨 turn 持存**:[getSession L91–108](../packages/provider-codex/src/transport-ws.ts#L91) 用 `sessions` Map 快取,只在 miss 才讀 disk → L369 的 mutation 確實活到下一 turn。
  - 下一輪 `previous_response_id` **來自 `state.lastResponseId`**:[L833–835](../packages/provider-codex/src/transport-ws.ts#L833)。
- 故「L369 把 `lastInputLength` 獨立於 `lastResponseId` 提早推進 → 脫鉤」這個**核心事實為真**。

### 9.2 關鍵反證:漏掉 `doInvalidate()` → §3 step 2 的觸發清單大半不成立

[`doInvalidate()` L475–479](../packages/provider-codex/src/transport-ws.ts#L475) **同時清掉 `lastResponseId` 與 `lastInputLength`**,而它被掛在**絕大多數** abort 路徑上:

- `ws.onclose` while streaming(= **ws_truncation**)→ [L649](../packages/provider-codex/src/transport-ws.ts#L649)
- `ws.onerror`(server burp/斷流)→ [L623](../packages/provider-codex/src/transport-ws.ts#L623)
- idle timeout([L404](../packages/provider-codex/src/transport-ws.ts#L404))、`response.failed`([L613](../packages/provider-codex/src/transport-ws.ts#L613))、`response.incomplete`([L603](../packages/provider-codex/src/transport-ws.ts#L603))、server error frame([L539](../packages/provider-codex/src/transport-ws.ts#L539))、`previous_response_not_found`([L513](../packages/provider-codex/src/transport-ws.ts#L513))、probeFirstFrame timeout([L709–711](../packages/provider-codex/src/transport-ws.ts#L709))

這些清完後,下一 turn `lastResponseId===undefined` → [L833](../packages/provider-codex/src/transport-ws.ts#L833) **不會**設 `previous_response_id` → 走「無鏈整包重送」,**不是** `length_not_grown`。**§3 step 2 親口列的 `ws_truncation`/rate-limit 斷流/server burp 這三種,恰好都被 `doInvalidate` 攔截,走不到本 bug 指控的那條機制。**

機制**只在不經 doInvalidate 的少數路徑**才真正成立,而報告 §3 清單裡沒列它們:

- **send watchdog `ws_send_timeout`**([L436–447](../packages/provider-codex/src/transport-ws.ts#L436)):先 `status="failed"` 再 `ws.close()` → onclose 的 `status==="streaming"` 為假 → **不** doInvalidate → `lastResponseId` 留 N-1、`lastInputLength` 留幻影 L_N。**這才是教科書級觸發點。**
- WS reuse 的 `catch {}`([L837–844](../packages/provider-codex/src/transport-ws.ts#L844))。
- 使用者中斷:請求 stream 只有 `start`、**無 `cancel()` handler**([L396](../packages/provider-codex/src/transport-ws.ts#L396) 已確認),是否清狀態端看 WS 是否隨後 close 命中 onclose——不確定。

### 9.3 §2 的 2/5 warm 反而佐證了修正後的窄機制

若 abort 一律清鏈,abort→下一輪應是 **5/5 cliff**。實測有 **2 次 warm**,代表那 2 次 abort **保住了鏈**(正是非-doInvalidate 路徑),下一輪 array 長過 L_N → delta。3/5 cliff = 同家族但 array 沒長大 = `length_not_grown`。**資料簽名與「send-watchdog 家族」自洽,卻與 §3 聲稱的 ws_truncation 觸發源矛盾。**

### 9.4 修法評估:正確、低風險(認同)

把 L369 移進 completion handler、與 `lastResponseId` 成對 commit——對它**真正能涵蓋的**路徑是對的:失敗 turn 不再推進 `lastInputLength` → 使其 track「上一個**成功** turn」→ 夾帶 retry item 而長大的下一輪自然 `>` 而續用 delta。§5 安全性分析(compaction 縮短照常 reset、首 turn 不受影響)成立。**唯一要補:對 doInvalidate 那批路徑此修法不改變任何行為**(它們本就無鏈),故能消掉的 cliff 數比「3 次」更受限。

### 9.5 與 §6 evidence gap 同源(這是最關鍵的一點)

「無鏈整包重送(doInvalidate)」與「`length_not_grown`(phantom)」在 cache_read 上**長得一模一樣**(都崩到 24064)。沒有 WS log 就無法分離,所以**把這 3 次全歸給 `length_not_grown` 是未經 log 證實的歸因**,而 `doInvalidate` 的存在讓「其實是無鏈路徑」的機率明顯上升。

→ **建議落地順序不變但理由更強**:先做 §6 的 `[CODEX-WS]` log 落地(尤其 `chainResetReason=length_not_grown` 的**出現次數**),再決定是否上 §5 修法。目前連「這 3 次是不是 `length_not_grown`」都還沒坐實。

### 9.6 建議對原文的修訂

- §3 step 2 觸發清單:刪掉/降級 `ws_truncation`/rate-limit/server burp(它們走 doInvalidate),改列 **send-watchdog `ws_send_timeout`** 為主觸發點,並補一句「依賴 abort 路徑**不經** `doInvalidate`」。
- §1/§4 把「abort → length_not_grown 佔 3」改為**待 §6 log 坐實的上界**(實際 ≤3,其中部分可能是無鏈路徑而非 length_not_grown)。

---

## 10. W4 部署後實測 (2026-06-02, OBSERVING)

修法 + W1 JSONL 部署運作中。`~/.local/state/opencode/codex/ws-chain.jsonl` 實測:

- **258 req-events / 4 sessions**(含一個 207-turn 重 session,正是原 RCA session family `…xKpgyZKA`)。
- `resetClass` 分佈:`none`=511、`chainless`=22、**`length_not_grown`=2**。
- 2 筆 `length_not_grown` 皆 **合法 compaction-shrink**(`prev=292→now=4`、`prev=220→now=4`,陣列崩到 narrative anchor)→ **phantom / ws_send_timeout 殘餘 = 0**。
- `chainless`=22 是 `doInvalidate` 路徑(DD-6 範圍外,符合預期,修法本就不動)。

**判讀**:修法後在重 session 中,`length_not_grown` 只剩合法 compaction 邊界,**未見任何 phantom 自製 reset**。即時行為驗證通過 → 移 `observing/` soak。
**caveat(DD-1)**:無同指標 pre-fix baseline(W1/W3 同時 land);此為「phantom 類為空」的結構性證明,非 N→0 差值。
