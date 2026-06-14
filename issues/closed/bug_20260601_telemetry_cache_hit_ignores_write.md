# Bug: 遙測 cache-hit % 漏算 cache_write（claude read/write 分離)→ claude session 虛報 ~100% 命中（已修,待部署）+ 該升級成 read/write/fresh 三向 + 淨效益

- **Date**: 2026-06-01
- **Severity**: Medium（不影響功能,但讓使用者誤判快取效益——尤其 cold-regime 看到假的 100% 命中,看不到 write 燒掉的成本。會誤導 cache 策略決策）
- **Component**:
  - `packages/app/src/pages/session/session-telemetry-cards.tsx`（Round / Session telemetry 卡片的 hit% 公式）
  - aggregate pipeline:`runtime-event-service.ts` → `global-sync/types.ts` → `monitor-helper.ts`
- **Status**: CLOSED — fixed by `6a21a3bfe` and deployed via `03e75e459`; enhancement note retained in §4.

---

## 1. 症狀
Round/Session telemetry 卡片:
- 某 cold round 顯示 `Cache hit 0.0%`(這個正確,cold turn read=0)。
- **`Cache hit 100.0% (cumulative)` ← 錯的**。claude cold-regime 有大量 cache_write,累積命中率不該 100%。

## 2. Root cause（已確認）
hit% 分母 = `input + cache_read`,**漏了 `cache_write`**。
- claude read/write **分離計費**:cold turn 把整段 prefix 寫進 cache(`cache_write` 大、`read=0`)——那是「建快取成本」、**不是命中**,卻沒進分母。
- `input` 每輪僅 ~2 tok → 累積分母幾乎全是 read → `hit = Σread/(Σread+Σinput) ≈ 100%`。

## 3. 已修（commit 6a21a3bfe）
- 公式改 `cache_read / (input + cache_read + cache_write)`（round + cumulative 都改)。
- 新增 `cumulativeCacheWriteTokens` 串過 aggregate pipeline（runtime-event-service schema/sumField/output → types → monitor-helper）。
- typecheck 兩 package 乾淨。**待 frontend 重建(3R)生效。**

## 4. ENHANCEMENT（另開,選做）:單一 hit% 不完整,該顯示 read/write/fresh + 淨效益
read 和 write **不對稱**(read 0.1x 省、write 1.25x 比沒快取還貴),單一命中率藏起了 write 成本。建議卡片改顯示:
```
Cache  read 0% / write 99% / fresh 1%        (三向佔比,合計 100%)
淨效益  read×0.9 − write×0.25  = -XXk tok     (負值 = 快取在虧)
```
- 對 cold-regime 才有診斷力:會直接顯示「目前快取策略在省還是在虧」。
- 損益平衡:write 平均要被讀 ≥ ~0.28 次才回本;常閒置 + 5min cache → write 常過期未讀 → 淨虧。
- 這個淨效益儀表,正是評估 `enhancement_20260601_claude_1h_cache_ttl.md`（改 1h cache）是否真划算的工具。

## 5. 驗收
- 修法部分:cold-heavy session(如 ses_18d7f02e)部署後 cumulative hit% 從 100% 掉到反映真實的低值。
- enhancement:三向佔比合計 100%、淨效益對 cold session 為負、對 warm session 為正。

## 6. Related
- `enhancement_20260601_claude_1h_cache_ttl.md`（這個遙測是評估該改動的儀表）
