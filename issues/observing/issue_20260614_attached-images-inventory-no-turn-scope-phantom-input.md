# BR: `<attached_images>` inventory 無 turn 歸屬信號，被模型誤讀為本輪新上傳（幻影附件回歸）

- **狀態**: OBSERVING — 修法走「方向 1+2+4 疊加」：inventory builder 由訊息位置+role 推得當前 turn（last user message），逐張標 `[THIS TURN]` 或 `— earlier, N turn(s) ago, not this turn`，並加頂層 `TURN SCOPE` 指令明示歷史附件清單非本輪輸入、未被本輪引用前不主動處理。無需 timestamp（純位置）。role 缺失的 legacy caller 維持原輸出（向後相容）。Fix commit `f8ff57395`（builder + 3 個新單元測試，共 12 pass）。已 `webctl.sh restart` 部署（binary 含新 TURN SCOPE/earlier 字串）。Observing since 2026-06-15。**Exit → closed/**：跨一次 compaction 後純文字 turn，真實 agent session 不再把歷史 `image.png` 誤判為本輪新上傳，soak 數日無復發。**Regress → open**：模型再次對非本輪附件自發「先看你貼的圖」。

  原始：Open（root cause 已定位到 inventory builder，修法待工程決議；非前兩個 observing BR 的未部署，而是它們修法已生效後暴露的**新缺口**）
- **回報日期**: 2026-06-14
- **嚴重度**: High（破壞多輪對話正確性；模型對著早已不存在的「使用者新上傳」自發啟動處理流程）
- **元件**: opencode attachment-lifecycle — `<attached_images>` inventory builder（`packages/opencode/src/session/attached-images-inventory.ts`）+ preface 組裝（`llm.ts`）
- **關聯**:
  - `issues/observing/issue_20260611_stale-attachment-persists-across-turns.md`（母 BR；修「pixel 跨 turn 重複注入」）
  - `issues/observing/issue_20260611_restart-resume-not-draining-active-image.md`（resume drain 子 BR）
  - **本 BR 是上兩者修法部署後仍殘留的獨立缺口** —— 它們修掉了 `[ACTIVE]` pixel 注入，但沒修 inventory **裸列名本身**的語意缺陷。

## 症狀

跨多個完全不同的 turn（使用者該輪是**純文字、未附任何圖**），模型仍「看到」一張歷史上傳的 `image.png`，並把它當成**本輪使用者剛貼的新輸入**，於是開頭就回「先看你貼的圖」、自發啟動判圖/處理流程——對著一個使用者本輪根本沒有引用的附件動作。

實測（本 session `ses_1491aa8feffeJQOpbvWKaFmfjk`，2026-06-14）：

1. 16:41 一次 `compaction observed=cache-aware kind=narrative success=true`。
2. 其後某 turn，使用者問「你畫了什麼插圖？」（純文字）。
3. 模型開頭：「先看你貼的圖」——把記憶中的 `image.png` 誤當本輪輸入。
4. 使用者明確指出「我剛才沒有貼圖」。

## 關鍵證據（冒煙的槍）

### 證據 A — live session state 的 activeImageRefs 是空的（前案 drain 已生效）

daemon `debug.log`（`bus.session.updated`，session `ses_1491aa8feffeJQOpbvWKaFmfjk`）：

```json
"execution": {
  "activeImageRefs": [],
  "recentEvents": [
    ... {"ts":1781426504035,"kind":"compaction","compaction":{"observed":"cache-aware","kind":"narrative","success":true}}
  ]
}
```

→ `activeImageRefs:[]`：母 BR 的 compaction-boundary drain（`compaction.ts:225`）與 resume drain（`index.ts:875`）**都已在 running code 並生效**。pixel 不再被注入。

### 證據 B — 但 preface 的 inventory 仍注入該圖的裸列名（無 `[ACTIVE]`）

同一輪 system-reminder 實際內容：

```
<attached_images count="1">
IMPORTANT: filesystem tools ... To view an image listed below, call reread_attachment() ...
Inventory:
- image.png (image/png, 41.6 KB)
</attached_images>
```

對照證據 A：`activeImageRefs` 空 → inventory 走 `activeNames.length === 0` 分支 → **沒有 `[ACTIVE]` 標記、沒有 pixel**，但**列名仍在**。

### 證據 C — inventory builder 對「圖屬於哪個 turn / 是否本輪使用者引用」零信號

`packages/opencode/src/session/attached-images-inventory.ts:38-89` `buildAttachedImagesInventory()`：

```ts
for (let mi = messages.length - 1; mi >= 0; mi--) {
  for (const part of msg?.parts ?? []) {
    if (part.type !== "attachment_ref") continue
    if (!part.filename) continue
    if (!part.mime?.startsWith("image/")) continue
    if (!part.repo_path && !part.session_path) continue
    if (seen.has(part.filename)) continue
    seen.add(part.filename); ordered.push(part)       // ← 收錄「整段 session 史」的每張圖
  }
}
```

→ inventory 收錄的是**全 session 歷史**所有 image attachment_ref，**不分這張圖是這一輪使用者貼的、還是幾十輪前貼的**。列名行 `- ${filename} (${describePart})` 也**不帶** uploaded_at / last_referenced_turn / 「N turns ago」任何新鮮度或歸屬標記。

`llm.ts:982-985` 註解明寫設計意圖：

```
// v5 inventory: built from ALL image attachment_refs, regardless
// of whether they're in the active set this turn.
```

## 根因（causal chain）

1. 母 BR + 子 BR 修法只 drain `activeImageRefs`（控制 **pixel 注入**），但 `<attached_images>` **inventory 列名來源是整段訊息史**，與 `activeImageRefs` 無關 → drain 清不掉 inventory。
2. inventory 的非-active 分支只是「降級為純列名」，但**純列名本身沒有 turn 歸屬 / 新鮮度信號**。對模型而言，preface 裡出現 `<attached_images count="1"> ... image.png` 與「使用者本輪剛上傳一張圖」在版面上**難以區分**。
3. compaction 把「當初使用者要求看這張圖」的對話脈絡摘要掉了；摘要後模型失去「這圖是舊任務的」這個語境，preface 又持續呈現該圖列名 → 模型把它重建為「本輪新輸入」→ 開頭「先看你貼的圖」的幻影。
4. ∴ 症狀從「pixel 跳針」（母 BR，已修）退化成「**列名幻影**」（本 BR，未修）——更隱蔽，因為沒有 `[ACTIVE]`、沒有 pixel，純靠列名誤導。

## 與前兩 BR 的差異（為何是新 BR 而非回歸）

| 面向 | 母 BR / 子 BR（observing） | 本 BR |
|---|---|---|
| 載體 | `activeImageRefs` → pixel 重複注入 | inventory 裸列名（無 pixel） |
| 修法狀態 | 已部署且**已生效**（證據 A：refs 空） | 未修 |
| drain 能否解決 | 能（已證） | **不能**（inventory 不讀 activeImageRefs 來決定收錄誰） |
| 誤導強度 | `[ACTIVE] ... persists across turns` 強暗示 | 純列名弱暗示，但 compaction 後語境喪失即足以誤導 |

## 建議修法（方向，非定案）

1. **inventory turn-scope 化（首選）**：列名標註該圖的來源 turn / 相對新鮮度，例如
   `- image.png (image/png, 41.6 KB) — uploaded 30+ turns ago, not referenced this turn`。
   讓模型有客觀信號分辨歷史附件 vs 本輪新輸入。
2. **本輪上傳 vs 歷史分區**：inventory 拆兩段——「本輪使用者新附 (this turn)」與「歷史可 reread (earlier)」，只有前者暗示「需立即處理」。
3. **compaction 後抑制**：若該圖的引用脈絡已被 compaction 摘掉且 N turns 未被使用者重新引用，inventory 預設摺疊（保留「有 K 張歷史圖，可 reread」一行），不逐張列名。
4. **文案中性化**：inventory 頂部 IMPORTANT 區塊明示「以下為歷史附件清單，非本輪新上傳；除非使用者本輪引用，否則不要主動處理」。

## 暫行 workaround（agent 端自律）

- 看到 `<attached_images>` 列名時，**先檢查使用者本輪訊息是否真的附了圖 / 引用了圖**；若本輪是純文字，視為歷史附件，**不主動啟動判圖/處理**，更不要說「先看你貼的圖」。
- 不確定時用一句話向使用者確認，而非逕自處理。

## Next Session Checklist

- [ ] 確認 `buildAttachedImagesInventory` 的 `InventoryMessageLike` 是否能取得每張圖的來源 messageID / timestamp（turn-scope 化的前置資料是否齊全）。
- [ ] 決定修法走 1（標註新鮮度）還是 2（分區）還是 3（compaction 後摺疊）——三者可疊加。
- [ ] 補單元測試：歷史圖在非本輪引用時，inventory 應帶「earlier / not this turn」信號（對照 `attached-images-inventory.test.ts`）。
- [ ] 驗證：跨一次 compaction 後，純文字 turn 的 preface 不再讓模型誤判為本輪有新圖。

## 環境

- session: `ses_1491aa8feffeJQOpbvWKaFmfjk`（happy-engine），version `0.0.0-main-202606102347`
- 證據檔: `~/.local/share/opencode/log/debug.log`（`bus.session.updated` for ses_1491…，`activeImageRefs:[]` + recentEvents）
- 相關 commit: `2df7bb5eb`（v7 consume-on-use）、`496042d01`（resume drain）、`3069b6e23`（compaction-boundary drain）——皆已在 running code，本 BR 缺口在其覆蓋範圍**之外**。
