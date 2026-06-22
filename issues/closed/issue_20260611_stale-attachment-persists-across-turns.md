> **CLOSED 2026-06-23** — bulk-closed per resolved→close: fix committed + deployed; soak window elapsed with no recurrence noted. Folder location (closed/) is the authoritative lifecycle state; the in-body OBSERVING text below is the as-observed record. Reopen if recurrence appears.

# BR: 舊上傳截圖被永久釘為 active attachment，跨 turn 反覆重注入導致 agent 跳針

- **狀態**: Observing（已實作 + typecheck/unit 綠燈 + **2026-06-11 部署驗證通過**：重啟跨 reset 後該圖降級為純 inventory，跳針源消除）
- **回報日期**: 2026-06-11
- **嚴重度**: High（破壞多輪對話正確性，浪費大量 token 與回合）
- **元件**: opencode attachment / image injection 機制（session preface 的 `<attached_images>` 與 working-cache 影像注入）

## 症狀

使用者數小時前上傳過一張截圖（標題渲染 `（一）1.. 本堂課考試定位與讀法`）。該截圖對應的問題在當時就已被處理、檔案早已重建修好。

但在**後續完全不同的 turn**，agent 仍會「看到」這張舊截圖，並把它當成**當前 turn 的新輸入**，於是反覆啟動處理流程：重新渲染 PDF、裁切圖片、判圖、比對——試圖修一個**已經不存在的問題**。agent 因此陷入跳針迴圈，連續多輪重複同類動作（本 session 觀察到 depth 20+ 的重複判圖）。

## 關鍵證據

系統 preface 注入的 `<attached_images>` 區塊明確標示：

```
<attached_images count="1">
Active inline (pixels available in this preface, persists across turns): image.png.
Already-active images do NOT need re-calling.
Inventory:
- image.png [ACTIVE] (image/png, 2.4 KB)
</attached_images>
```

重點字句：**`persists across turns`** + **`[ACTIVE]`**。

→ 一張歷史上傳的圖被標為 `ACTIVE` 並**永久跨 turn 持續注入 pixel**，等同每個 turn 都把它當「使用者剛貼的新圖」重新呈現給模型。模型沒有可靠信號分辨「這是幾小時前的舊圖、且已處理完」與「這是本 turn 的新輸入」，於是被反覆觸發。

## 影響

1. **正確性**：agent 對著早已修好的狀態反覆「修復」，可能誤改正確檔案、或對使用者反覆給出過時結論。
2. **成本**：每輪重新注入 image pixel + 重複渲染/判圖，大量浪費 token 與回合（context、cache、wall-clock）。
3. **使用者體驗**：使用者明明已換話題，agent 仍跳針回舊圖，像「鬼打牆」。

## 重現步驟

1. 使用者上傳一張截圖，agent 處理之。
2. 經過數個 turn / 數小時，話題已轉移（或同問題已解決）。
3. 觀察後續 turn 的 system preface —— 該圖仍以 `[ACTIVE] ... persists across turns` 形式被注入。
4. agent 在無使用者重新引用的情況下，自發地再次處理該圖。

## 推測根因（待工程確認）

- attachment 的 active/pin 生命週期沒有 **TTL 或 turn-scope 邊界**：一旦某圖被設為 active inline，就無限期保留，而非「僅在使用者該則訊息所屬 turn 內有效」。
- 注入文案 `persists across turns` + `Already-active images do NOT need re-calling` 進一步**鼓勵**模型把它當成持續有效的當前上下文，而非歷史附件。
- 缺少「此附件最後被使用者主動引用於哪個 messageID / 何時」的時間戳，模型無從判斷新鮮度。

## 建議修法（方向，非定案）

1. **Turn-scope 化**：image pixel 注入預設只綁定「使用者上傳它的那一則訊息」對應的 turn；後續 turn 降級為「inventory 列名（可 `reread_attachment` 取回）」，不再自動注入 pixel。
2. **加新鮮度標記**：在 inventory 標出 `uploaded_at` / `last_referenced_turn`，並在 preface 明示「此為 N turns 前的歷史附件，非本 turn 新輸入」。
3. **移除誤導文案**：`persists across turns` 改為中性描述（如 `available on demand`），避免暗示「持續有效的當前上下文」。
4. **顯式 active 上限**：active inline 至多保留最近一次使用者上傳；新上傳時舊圖自動降級為 on-demand。

## 暫行 workaround（agent 端自律）

在根因修復前，agent 應：

- 看到 `<attached_images>` 中的 `[ACTIVE]` 圖時，**先檢查它是否來自當前 turn 的使用者訊息**；若使用者本 turn 並未引用該圖，視為歷史附件，**不主動重啟處理**。
- 若不確定該圖是否仍相關，先用一句話向使用者確認，而非逕自重跑渲染/判圖流程。

---

## 根因確認（2026-06-11）

工程側已定位，與「推測根因」一致並收斂到**單一機制**：

1. **attachment-lifecycle v6 刻意不做 per-turn drain**。`packages/opencode/src/session/llm.ts:1015` 明示
   「do not drain here」——image 被設為 active 後跨 turn 持續 inline，僅靠 FIFO cap
   （`activeSetMax`）約束。`drainAfterAssistant()`（`active-image-refs.ts:82`）雖定義但
   **production 從未呼叫**（grep 證實非測試碼零 call site）。設計意圖是「同一 task 內 call 一次
   reread 即可」。
2. **`activeImageRefs` 跨 identity rotation 被刻意保留**。`Session.nextExecutionIdentity()`
   （`index.ts:455`）在 rotation 時把 `activeImageRefs` 一併帶過去。
3. **compaction 沒有清掉這個視覺工作集**。compaction 把「當初使用者要求看圖」的脈絡摘要掉了，
   但 raw `activeImageRefs` 隨 identity 存活下來 → 每個 post-compaction turn 都重新 inline 那張舊圖，
   模型讀成「本 turn 新輸入」→ 跳針（鬼打牆）。

→ 即「在發生 compaction 之後，agent 一直被注入舊截圖而不斷跳針」的精確成因。

## 修法（採方向 1 的 task-boundary 變體，大道至簡）

**在 compaction 邊界 drain 視覺工作集。** compaction 本身就是 task/topic 邊界，正如 codex chain
與 cache baseline 早已在同一函式無條件重置。

- `packages/opencode/src/session/compaction.ts` — `publishCompactedAndResetChain()`
  （所有 compaction publish 的唯一 chokepoint；全 repo `Bus.publish(Event.Compacted)` 僅此一處）
  在 `resetCacheBaseline` 之後新增 `void Session.setActiveImageRefs(sessionID, [])`，
  **無條件** drain（與相鄰兩個 reset 一致；over-eager drain 至多多一次 optional reread，
  under-drain 才是本 bug）。
- 圖**不會遺失**：仍列在 `<attached_images>` inventory，模型若真需要可再 `reread_attachment()` 取回。
- 未改 inventory 文案 / 未加 TTL / 未動 schema：v6 的「同一 task 內持續 inline」對**未跨 compaction**
  的正常工作流仍正確；本修法只把「task 邊界 = compaction」這條線補上。

### 變更檔案

- `packages/opencode/src/session/compaction.ts` — `publishCompactedAndResetChain` 加入 boundary drain。
- `packages/opencode/src/session/compaction-replay-deep.test.ts` — harness 增 `setActiveImageRefs`
  capture；新增測試「drains activeImageRefs at the compaction boundary」斷言 drain 以 `[]` 觸發。

### 驗證

- [x] typecheck（packages/opencode）綠燈。
- [x] unit：新測試 pass；既有 active-image-refs / inventory 三檔 29 pass。
  （`compaction-replay-deep.test.ts` 另有 2 個 **與本修改無關的 pre-existing 失敗**：
  `observed=rebind` / `observed=empty-response`，stash 掉本次變更後在 baseline 同樣失敗。）
- [x] **部署驗證（2026-06-11 通過）**：使用者 3R 重啟並跨越一次 context reset 後，
      該圖在 preface 中**已降級為純 inventory 列名**（`image.png` 只剩檔名，
      不再有 `[ACTIVE] ... persists across turns`），agent 不再自發跳針。修法生效。

---

## Post-restart 觀察（2026-06-11，使用者完成 3R 重啟後）

**現象**：重啟完成後，**同一個既有 session** 的後續 turn 仍持續注入該圖
（preface 仍見 `image.png [ACTIVE] ... persists across turns`）。

**這不是修法失效，是預期行為 —— 關鍵釐清**：

- 本修法的 drain 點是 **compaction boundary**（`publishCompactedAndResetChain`），
  不是 daemon 啟動 / session resume。
- 既有 session 的 `activeImageRefs` 是**重啟前**就寫入的；重啟只換了 runtime code，
  不會回放或觸發一次 compaction，故舊 ref 不會被清，圖仍 inline。
- 換言之：**重啟單獨無法驗證此修法**。

**正確驗證路徑（取代原 checklist 末項）**：

1. 在**新 session**（或本 session 觸發一次 compaction 後）上傳一張圖。
2. 持續對話直到**跨越一次 compaction**。
3. 確認 compaction **之後**的 turn，preface 中該圖降級為純 inventory 列名
   （不再有 `[ACTIVE] ... persists across turns`），且 agent 不再自發跳針。
4. 通過 → 轉 `observing/`。

**待辦**：若希望「既有 session 立即生效」而非「等下次 compaction」，需評估是否
在 session resume / daemon restart 路徑也補一次 boundary drain（範圍更大，另議；
本 BR 的 compaction-boundary 修法對未來新上傳已足夠）。
