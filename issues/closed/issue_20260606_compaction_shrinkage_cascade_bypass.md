# [BUG] `compaction_shrinkage` Fall-Through 可能打開 Compaction Cascade 通道

**報告人**: Antigravity (2026-06-06)
**嫌疑 Commit**: `451880e25` — `feat(session): bypass cache-cliff warning on compaction shrinkage`
**觀察症狀**: Session 跳針（AI 重複 / 記憶錯亂 / session 崩壞），疑似 compaction 連續觸發導致

---

## 1. 症狀描述

使用者在長時間 session 中觀察到：
- Cache cliff 警報持續出現
- 隨後出現 `stream first-chunk timeout after 60000ms`（已另案處理）
- **Session「跳針」**：Agent 卡在 todolist 的某一件事上，反覆宣布「我要做這件事」，跑一段時間後又重複同一個 todolist 宣布「我要做這件事」，然後再跑很久。不斷循環，無法向前推進。
- 此症狀完全符合 **compaction cascade 不斷截斷工作記憶**的模式：每次 compaction 重寫歷史摘要 → AI 失去「我已經做到哪了」的記憶 → 重新讀 todolist → 宣布同一件事 → 執行 → 再次被 compaction → 再次失去進度記憶 → 無限循環。

---

## 2. RCA：`compaction_shrinkage` 的 Fall-Through 行為

### 2.1 相關程式碼

- [prompt.ts:680-765](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L680-L765) — cache cliff 偵測與分類
- [prompt.ts:719-721](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L719-L721) — `compaction_shrinkage` 判定（`451880e25` 新增）
- [prompt.ts:778-866](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L778-L866) — fall-through 後的其他 compaction trigger

### 2.2 正常流程（`451880e25` 之前）

當偵測到真實的 cache cliff（`prev.cacheRead > 50_000 && currentCache < prev.cacheRead * 0.5`）且所有 `plannedSources` 都不匹配時：

```
L680: 進入 else if 分支
  → L684-714: 檢查 planned sources（全部不匹配）
  → L734: 走 else 分支
    → L754: invalidateContinuationFamily(sessionID)  ← chain reset
    → L757: selfInvalidated = true
    → L761: return null                              ← 函數返回，不觸發 compaction
```

**安全性**：真實 server eviction 只做 chain reset，不觸發 compaction，避免了 2026-05-19 事件中記錄的 cascade 問題（37 cascading compactions in 2 hours）。

### 2.3 嫌疑流程（`451880e25` 之後）

`451880e25` 在 L719-721 新增了 `compaction_shrinkage` 判定：

```typescript
// L719-721
if (input.currentInputTokens !== undefined && input.currentInputTokens < prev.cacheRead) {
    plannedSources.push("compaction_shrinkage")
}
```

**問題**：當以下條件同時成立時，真實的 server eviction 會被 `compaction_shrinkage` 誤判為 planned：

1. **真實 cache cliff**：`currentCache < prev.cacheRead * 0.5`（伺服器確實驅逐了快取）
2. **且 `currentInputTokens < prev.cacheRead`**：當前 prompt 的 token 數小於上回合的快取讀取量

第 2 個條件**在長 session 中普遍成立**：
- `prev.cacheRead` 記錄的是上一回合伺服器快取了多少 tokens（例如 200K）
- `currentInputTokens` 是當前即將發送的 prompt 大小
- 如果上回合剛做過 compaction，或者 prompt 經過 anchor 壓縮，`currentInputTokens` 可能只有 80K-120K
- 80K < 200K → `compaction_shrinkage` 被加入 `plannedSources`

一旦 `plannedSources.length > 0`：

```
L680: 進入 else if 分支
  → L719: compaction_shrinkage 加入 plannedSources
  → L723: plannedSources.length > 0 → 進入 planned 分支
    → L732: 更新 state
    → L733: "Do not invalidate — drop was expected. Fall through."
    →→ 不做 chain reset
    →→ 不設 selfInvalidated
    →→ 不 return null
  → 繼續往下 fall through 到 L778-866 的其他 trigger
    → L778-782: paralysisItemThreshold → "overflow"
    → L785: itemOverflowTrigger → "overflow"
    → L846: isOverflow() → "overflow"
    → L860: predictedCacheMiss → "cache-aware"
    → L866: isCacheAware() → "cache-aware"
```

**如果任何一個後續 trigger 命中** → 觸發 compaction → 重寫 anchor → 產生全新的前綴 → 伺服器在高負載時無法快取新前綴 → 再次 eviction → 再次 cache cliff → **cascade 形成**。

### 2.4 Cascade 迴圈

```
Turn N:   server eviction → compaction_shrinkage 誤判 → fall through → overflow trigger → compaction
Turn N+1: 新 anchor 前綴未快取 → server eviction → compaction_shrinkage 誤判 → compaction
Turn N+2: 又是新 anchor → eviction → compaction → ...
```

每次 compaction 都重寫歷史摘要，多次級聯後 AI 的上下文與真實歷史嚴重脫節 → **記憶錯亂 / 跳針**。

---

## 3. 觸發條件

以下條件需**同時成立**：

| 條件 | 說明 |
|---|---|
| 真實 server eviction | `currentCache < prev.cacheRead * 0.5` 且 `prev.cacheRead > 50_000` |
| `currentInputTokens < prev.cacheRead` | 長 session + 經歷過 compaction 壓縮後的 prompt 比快取量小 |
| 後續 trigger 命中 | session 的 token 壓力接近 overflow/cache-aware 門檻 |

在 **Codex API 高負載 + 長 session** 場景下，三個條件同時成立的概率不低。

---

## 4. 建議修復方向

### 方向 A：planned 分支也做 chain reset + return null（保守修法）

即使 cache drop 被分類為 planned，仍然做 chain reset 以確保下一輪 Full Send。且 `return null` 阻止 fall through。

```typescript
if (plannedSources.length > 0) {
    debugCheckpoint("prompt", "cache_cliff_planned", { ... })
    // 即使是 planned，也做 chain reset 以防是真實 eviction 被誤判
    try {
        const { invalidateContinuationFamily } = await import("@opencode-ai/provider-codex/continuation")
        invalidateContinuationFamily(input.sessionID)
    } catch {}
    lastCacheReadState.set(input.sessionID, nextState)
    return null  // 阻止 fall through，不觸發 compaction
}
```

**優點**：最安全，不可能 cascade。planned 的 drop 本來就不需要後續處理。
**缺點**：如果後續 trigger（overflow 等）本來就該觸發，會被跳過。但 overflow 會在下一回合再次評估到。

### 方向 B：縮窄 `compaction_shrinkage` 的匹配條件

例如額外要求 `anchor.createdAt` 在近期（最近 2 分鐘內有 compaction），而非僅比較 token 數：

```typescript
if (
    input.currentInputTokens !== undefined &&
    input.currentInputTokens < prev.cacheRead &&
    recentAnchor?.createdAt && recentAnchor.createdAt > prev.ts
) {
    plannedSources.push("compaction_shrinkage")
}
```

**優點**：精確區分「剛做過 compaction 的合法縮水」和「server eviction 碰巧 token 較小」。
**缺點**：需要確認 `recentAnchor` 在此上下文中是否已經被計算。

### 方向 C：直接移除 `compaction_shrinkage`

已有 `recent_compaction`（L711-713）覆蓋「剛 compact 過的首回合」，且 L680 的 50K 門檻 + 50% drop 條件本身就夠嚴格。`compaction_shrinkage` 可能是多餘的。

---

## 5. 前例參考

[prompt.ts:543-546](file:///home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts#L543-L546) 記錄的 2026-05-19 事件：

> Incident 2026-05-19: codex server evicted cache under load; old code returned "continuation-invalidated" here → narrative compaction → full resend with new anchor → server evicts again → 37 cascading compactions in 2 hours (ses_1c875cc15ffe5ds18JVdNAT4e6).

該事件的修復正是「cache cliff 只做 chain reset，不觸發 compaction」（L750-761）。`compaction_shrinkage` 的 fall-through 實質上繞過了這個防護。

---

## 6. 待確認事項

- [ ] 是否能從受影響 session 的 daemon log 中找到 `cache_cliff_planned` + `compaction_shrinkage` 連續出現的記錄？
- [ ] 是否能確認 cascade 發生時 `plannedSources` 的實際內容？
- [ ] 修復方向 A/B/C 的選擇需多方共識。

---

## 7. 結案驗證 (2026-06-11)

### 7.1 §6 待確認事項逐項回答

- [x] **daemon log 中 `cache_cliff_planned` + `compaction_shrinkage` 連續出現？** — 否。掃描 `debug.log` + `debug.log.1`（覆蓋 06-10 ~ 06-11），`cache_cliff_planned` 與 `cache_cliff_detected` **均為 0 筆**。無任何現場證據支持 cascade 曾發生。
- [x] **cascade 發生時 plannedSources 內容？** — 不適用（無 cascade 紀錄）。
- [x] **修法方向 A/B/C 共識？** — 均不實作，理由見 7.2。

### 7.2 結構性分析（沿用姊妹 issue 的核實結論）

`issue_20260606_compaction_echo_cache_cliff_false_positive.md` §8.1 已逐行核實的互斥結構同樣封死本 issue 的 cascade 迴圈：

1. Turn N 若真的「誤判 planned → fall through → overflow 觸發 compaction」，L731 已把 `prev.cacheRead` 更新為**低值**（compaction 後典型 30-45K）。
2. Turn N+1 要再次進入 cliff 分支需 `prev.cacheRead > 50_000` — 不成立 → **fall-through 誤判無法連續發生**，cascade 鏈在第二環即斷。
3. 即使 cacheRead 留在高位的邊角情形，compaction cooldown gate（30s）+ overflow 在剛壓縮後不會再命中，連續 compaction 仍被擋。

### 7.3 症狀（跳針）的實際歸因

原始症狀「todolist 跳針循環」在後續已有獨立修復落地：

- `95a3f44d9` — runloop 非生產回合 circuit breaker（連續 3 回合無 tool call + 輸出 < 16 tokens → 強制停止）
- `ebacf170b` — 修掉 empty-"other" re-fire loop
- `9062bd44e` — WS timeout bounded self-healing（消除同期的 cache cliff 來源，見 `issue_20260606_codex_ws_timeout_cache_cliff.md`）

### 7.4 處置

**Close — Not Reproducible / Superseded。** 方向 A/B/C 皆不實作。若未來 daemon log 出現「`cache_cliff_planned (compaction_shrinkage)` → 同 session 30s 後再次 `cache_cliff_planned` → compaction 連發」的實證三連，再重開。
