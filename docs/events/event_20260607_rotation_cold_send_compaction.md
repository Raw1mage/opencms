# Event: rotation_cold_send_compaction

## 需求

- 21:44 一個明顯的 cache cliff（`190k → 0k`）來自 rate-limit **rotation**（codex：`yeatsraw@thesmart.cc → ncu`，rate limit exceeded）。
- rotation 本來就會失去 cache（換到全新 cold 帳號），因此不應該無條件「全量傳送」。應改為「有條件全量傳送」：context 夠大時先做 compaction（保留 tail）再送出。

## 根因(RCA)

- runloop 每輪送出前**已有**正確的判斷式：`deriveObservedCondition` 的 predicted-cache-miss trigger（[prompt.ts](../../packages/opencode/src/session/prompt.ts) 約 940 行）—
  `predictedCacheMiss === "miss" && ctxRatio > cacheLossFloor && predictedUncached >= minUncachedTokens → "cache-aware"`。
- 但 rate-limit rotation 的 re-send 發生在 `processor.process` 的 retry 迴圈裡（換帳號後直接 `continue` 重打 `LLM.stream(streamInput)`，沿用同一份 full message array），**繞過了 runloop 的送出前 compaction 檢查**。
- 結果：full 190k 對 cold 帳號全量重送（cacheRead=0）= cache cliff；provider-switched/narrative compaction 只在「下一輪」才跑，為時已晚。
- 一句話：送出前的檢查存在且正確，rotation 這條捷徑跳過了它。

## 範圍(IN/OUT)

- IN: 把「cache 已（將）失效時是否值得 full cold send」的決策集中到 compaction decision layer；rotation 路徑改為呼叫該決策層。
- OUT: 不動 same-account cache-cliff 的 anti-cascade 規則（[prompt.ts:783-846](../../packages/opencode/src/session/prompt.ts)，2026-05-19 codex 37 連環 compaction 事故的修法）；不新增 bespoke 門檻。

## Key Decisions

- **中控責任層**：決策邏輯只放一處 —— 新增 `SessionCompaction.shouldCompactOnPredictedCacheLoss({ currentInputTokens, cacheRead, window })`（[compaction.ts](../../packages/opencode/src/session/compaction.ts)），沿用既有 `Tweaks.compactionSync()` 的 `cacheLossFloor`(0.5) + `minUncachedTokens`(40k)。
- `deriveObservedCondition` 的 predicted-cache-miss 分支改為**委派**給該 predicate（行為不變，既有測試 233-268 續綠）。
- `processor.ts` 在 3 個 rotation 落點（pre-flight / temporary-error / rate-limit-retry）換帳號後呼叫 `shouldDeferColdResend()`（cacheRead=0，因 rotation 必為 cold），門檻成立則 `return "compact"` 改走 runloop compaction（narrative，保留 tail）→ 下一輪送出縮小後的 prompt 給新帳號。門檻不成立則維持原本 `continue` 全量重送（夠小）。
- **不會重現 cascade**：codex compaction 後 ≈ aCompactTokens(50k)/272k ≈ 18% < cacheLossFloor，再次 rotation 不會再觸發；外加 runloop `consecutiveCompactions>=3` backstop。

## Verification

- `bun run --cwd packages/opencode typecheck`：5 個錯誤皆 pre-existing（`freerun/runtime/engine.ts`、`llm.ts`，未改動），本次 3 檔 0 error。
- `bun test packages/opencode/test/session/compaction.test.ts`：36 pass / 2 fail；2 fail 為 baseline 既有（cache-cliff classification 測試隔離問題，stash 比對 31 pass/2 fail 確認）。新增 5 個 `shouldCompactOnPredictedCacheLoss` 單測全綠（含 codex rotation cold-send 案例）。
- 部署：需 `system-manager:restart_self` 後才生效（尚未部署）。
