> **CLOSED 2026-06-23** — bulk-closed per resolved→close: fix committed + deployed; soak window elapsed with no recurrence noted. Folder location (closed/) is the authoritative lifecycle state; the in-body OBSERVING text below is the as-observed record. Reopen if recurrence appears.

# BR: 重啟 / session resume 不清既有 session 的 active image ref（drain 只綁 compaction boundary）

- **狀態**: OBSERVING — fix 已隨 2026-06-11 3R 部署；母 BR（stale-attachment）部署驗證通過（重啟跨 reset 後 active image 降級為純 inventory）。soak 期間 restart/resume 後不再出現 stale active image 即可轉 closed/
- **回報日期**: 2026-06-11
- **嚴重度**: Medium（既有 session 內無法立即解除 stale image；需被動等下一次 compaction）
- **元件**: opencode session lifecycle — `activeImageRefs` drain 時機（compaction vs resume/restart）
- **關聯**: issue_20260611_stale-attachment-persists-across-turns.md（母 BR；本 BR 為其 post-restart 觀察抽出的獨立子問題）

## 背景

母 BR（stale-attachment-persists-across-turns）的修法：在 compaction chokepoint
`publishCompactedAndResetChain()`（`packages/opencode/src/session/compaction.ts`）
之後 `void Session.setActiveImageRefs(sessionID, [])`，於 **compaction boundary** 無條件 drain
既有 session 的 active image refs。

該修法對「跨越一次 compaction 之後的新上傳」是正確且足夠的。

## 本 BR 的症狀

使用者完成 3R 重啟後，**同一個既有 session** 的後續 turn **仍持續注入**那張 stale 截圖
（preface 仍見 `image.png [ACTIVE] ... persists across turns`），agent 仍可能被其觸發。

實測時序：
1. 既有 session 內某 turn 已把某圖寫入 `activeImageRefs`。
2. 使用者觸發 3R 重啟（daemon rebuild + restart，部署母 BR 修法）。
3. 重啟後續 turn，preface 中該圖**仍是** `[ACTIVE] ... persists across turns`。

## 根因

drain 的**唯一觸發點是 compaction boundary**。但 daemon restart / session resume
**不會回放也不會觸發一次 compaction**：

- 既有 session 的 `activeImageRefs` 是重啟前就持久化的 session state。
- 重啟只替換 runtime code，不重跑 compaction，故舊 ref 不被清，圖續 inline。
- 因此：**重啟單獨無法清除既有 session 的 stale active image**，必須被動等到該 session
  下一次自然觸發 compaction 才會生效。

換言之，母 BR 修法存在一個**生效延遲缺口**：對「正在進行、尚未跨 compaction 的長 session」，
即使部署了修法、即使重啟，stale image 仍會纏住到下一次 compaction。

## 影響

- 長 session（遲遲未觸發 compaction）內，已部署的修法**對既有 stale ref 無感**。
- 使用者體感「重啟也沒用」，誤以為修法失效（實際是生效時機不涵蓋 resume/restart 路徑）。
- 母 BR 描述的跳針風險在這段空窗期仍存在。

## 重現步驟

1. 在一個 session 上傳一張圖，使其進入 `activeImageRefs`。
2. 在**未觸發 compaction** 的情況下，請使用者 3R 重啟 daemon。
3. 觀察重啟後 turn 的 preface —— 該圖仍為 `[ACTIVE] ... persists across turns`。

## 建議修法（方向）

於 **session resume / daemon restart 路徑**補一次 boundary drain，使既有 session 重啟後立即清乾淨，
而非僅依賴 compaction boundary：

1. **Resume-time drain（首選）**：session 自 persisted state 載入 / resume 時，
   無條件 `setActiveImageRefs(sessionID, [])`（與 compaction-boundary drain 同語意，
   over-eager 至多多一次 optional reread，安全）。
2. **Restart-time sweep**：daemon 啟動時對所有 persisted sessions 一次性 drain active image refs。
3. 與母 BR 修法並存：compaction boundary 管「session 進行中跨 task 邊界」，
   resume/restart 管「跨進程生命週期」，兩者互補覆蓋完整。

### 風險評估

- drain 是冪等的清空操作；圖不會遺失（仍列於 `<attached_images>` inventory，
  可 `reread_attachment()` 取回）。over-drain 成本僅一次 optional reread。
- resume-time drain 範圍比 compaction-boundary 大，需確認不會誤清「使用者剛上傳、
  session resume 當下仍想 inline」的合法情境 —— 建議只清「非當前 turn 來源」的 ref，
  或接受「resume 後一律 on-demand」語意（與母 BR 的 turn-scope 化方向一致）。

## 暫行 workaround

- 修法部署後，要驗證 stale image 解除，**不能只靠重啟**；需在該 session 跨越一次 compaction，
  或開新 session。
- agent 端：見 `[ACTIVE]` 圖且非當前 turn 使用者引用時，視為歷史附件，不主動重啟處理（同母 BR）。

---

## 修法（2026-06-11，採方向 1「Resume-time drain」的 lazy 變體）

**關鍵安全前提**：`activeImageRefs` 在 production **只由 `reread_attachment`（`addOnReread`）填充**，
**從不由 upload 填充**（`addOnUpload` 全 repo 非測試碼零 call site，grep 證實）。因此 active set
裡的每一筆都是 agent 在**先前某 turn 主動選擇 inline** 的圖——不存在「使用者剛上傳、resume 當下
仍需 inline」的合法情境（BR 風險評估列的疑慮在此前提下不成立）。⇒ resume drain **無條件安全**：
頂多多一次 optional `reread_attachment`，圖仍在 `<attached_images>` inventory。

**未採方向 2（boot-time 全 session sweep）**：與既有設計衝突——orphan recovery 刻意是
`O(running tasks)` 而非 `O(all sessions)`，不在 boot 掃全部 persisted sessions。改採 **lazy
per-session**：在 session 第一次被觸碰時（重啟後的第一個 turn）才 drain，`O(touched sessions)`。

**落點**：`Session.pinExecutionIdentity()`（`packages/opencode/src/session/index.ts`）——
這是每個 processor turn 起點的通用 chokepoint（user-message persist / processor / prompt 各路徑
都會呼叫），且在該 turn 的 preface 組裝**之前**執行。以一個 module-level `Set<string>`
（`resumeImageDrainSeen`，隨 process 生死）保證**每 session 每 daemon 生命週期最多 drain 一次**：

```
const resumeDrain = shouldResumeDrainImages(resumeImageDrainSeen, sessionID, current?.execution?.activeImageRefs)
resumeImageDrainSeen.add(sessionID)            // 不論結果都標記 seen → 至多檢查一次
if (resumeDrain) await setActiveImageRefs(sessionID, [])
```

→ 重啟後**第一個 turn 即生效**（preface 不再出現該圖的 `[ACTIVE] ... persists across turns`，
降級為純 inventory 列名），不必被動等下一次 compaction。與母 BR 的 compaction-boundary drain
**互補**：compaction 管 in-process task 邊界，resume drain 管 cross-process 生命週期邊界。

### 變更檔案

- `packages/opencode/src/session/active-image-refs.ts` — 新增純函式 `shouldResumeDrainImages(seen, sessionID, refs)`
  （`!seen.has(id) && (refs?.length ?? 0) > 0`）。沿用本檔「schema-agnostic 純 helper、免起 Session 即可單測」慣例。
- `packages/opencode/src/session/index.ts` — `pinExecutionIdentity` 接入 lazy resume drain（module-level seen-set + 純 helper 決策）。
- `packages/opencode/src/session/execution-identity.test.ts` — `shouldResumeDrainImages` 單元測試
  （first-touch drain / once-only / 空集 no-op / add-after-check 契約三連觸發 `[true,false,false]`）。

### 驗證

- [x] typecheck（packages/opencode）綠燈。
- [x] unit：execution-identity + active-image-refs 共 29 pass。
- [ ] **部署驗證（待使用者 3R）**：在一個**既有、activeImageRefs 非空且未跨 compaction** 的 session 上
      觸發 3R；重啟後該 session 的**第一個** turn 之 preface 確認該圖已降級為純 inventory 列名
      （不再 `[ACTIVE] ... persists across turns`），agent 不再自發跳針。通過後轉 `observing/`。
