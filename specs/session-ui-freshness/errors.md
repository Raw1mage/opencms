# Errors: session-ui-freshness

所有在本 plan 範圍內可能發生的 error / warn / reject 條件。AGENTS.md 第一條：
**禁止靜默 fallback**——每條錯誤都必須有明確 user-visible（toast / badge / log）
或 dev-visible（console.warn / throw）的表達。

---

## Error Catalogue

| Code | Layer | Trigger | User / Dev Surface | Recovery | Severity |
|---|---|---|---|---|---|
| `FRESHNESS_INVALID_TIMESTAMP` | client freshness memo (`classifyFidelity`) | Entry's `receivedAt` 為 `undefined` / `NaN` / `Infinity` / 負數 / 非 number | `console.warn('[freshness] invalid receivedAt on entry <id>: value=<raw>')` rate-limited ≤1/min/entry | Treat as `0` → fidelity=`hard-stale`；UI 仍 render（以降級型態）；不 throw | warn |
| `FRESHNESS_TWEAKS_LOAD_FAILED` | `frontend-tweaks.ts` at bootstrap | `GET /config/tweaks/frontend` 網路失敗 / 非 200 / JSON parse fail | `console.warn('[tweaks] freshness keys unavailable, using defaults')`；UI 顯示一次性 toast `"Freshness config not loaded — running with defaults"`（使用者可手動刷新） | 走預設 `{enabled: 0, soft: 15, hard: 60}`；**禁止**預設 `enabled=1`（那會在沒有 server 閾值的情境下秀 stale hint，使用者反而困惑） | warn |
| `FRESHNESS_TWEAKS_OUT_OF_RANGE` | server `tweaks.ts` parser | `ui_freshness_threshold_sec` < 1 or > 3600；`ui_freshness_hard_timeout_sec` < 1 or > 86400；soft >= hard | server log `[tweaks] freshness keys clamped: <details>`；API response 回 clamped 值 | Clamp 到邊界；記錄原始值供 debug | warn |
| `FRESHNESS_TWEAKS_INVALID_FLAG` | server `tweaks.ts` parser | `ui_session_freshness_enabled` 非 `0` / `1` / `true` / `false` | server log `[tweaks] ui_session_freshness_enabled invalid value=<raw>, defaulting 0` | Default `0`；不自動升級到 `1` | warn |
| `CONNECTION_STATUS_RESIDUAL` | build / CI guard（新增） | 任一 `packages/app/src/**/*.{ts,tsx}` 出現 `connectionStatus` / `authorityBlocked` / `connectionState` identifier（非註解 / 非本 plan docs） | CI fail；msg：`DD-6 violation: <file>:<line> references <identifier>` | Block commit；修掉殘留再 retry | error（hard） |
| `CLOCK_JUMP_DETECTED` | `useFreshnessClock` (optional future) | `Date.now()` 在一次 tick 內倒退或前進 > 10min（系統時間被改 / tab 長睡醒） | `console.warn('[freshness] clock jump detected: delta=<ms>ms')`；freshness memo 下一 tick 自然恢復 | 不特別處理（memo 依最新 `Date.now()` 重算即可，hard-stale → fresh 的轉換只需一個 event 到達） | info |

---

## 錯誤分級

- **error (hard / blocks build / throws)**：`CONNECTION_STATUS_RESIDUAL` 屬此類——DD-6 的架構決策，一旦殘留代表 design 被違反。
- **warn**：`FRESHNESS_INVALID_TIMESTAMP` / `FRESHNESS_TWEAKS_LOAD_FAILED` / `FRESHNESS_TWEAKS_OUT_OF_RANGE` / `FRESHNESS_TWEAKS_INVALID_FLAG`——runtime 可繼續，但要留痕供 debug。
- **info**：`CLOCK_JUMP_DETECTED`——觀察用，不觸發任何補償行為。
- **silent（禁止）**：AGENTS.md 第一條 + `feedback_no_silent_fallback.md`。本 plan 範圍內不允許任何「預設成 fresh」或「跳過 classification 而不寫 log」的路徑。

---

## 無聲 fallback 禁令覆核

| 潛在誘惑 | 為何禁止 | 強制面 |
|---|---|---|
| `receivedAt === undefined` 當 fresh | DD-4；R5 設計主旨 | `classifyFidelity` 必須檢查 `isFinite(receivedAt) && receivedAt > 0`，否則走 hard-stale |
| Tweaks endpoint 失敗 → 預設 `enabled=1` | 會在無閾值情境下對使用者顯示不一致的 stale hint | `FRESHNESS_TWEAKS_LOAD_FAILED` 明文規定 fallback 為 `enabled=0` |
| 伺服器 `ui_freshness_threshold_sec` 缺欄位 → 從 response 取 undefined | tweak key 缺失是 config drift，不該靜默取預設並繼續 | server route 在 serialize response 時必須填齊（default-fill），缺則 server 端 log 並用 default |
| `freshnessNow` setInterval 未建 → memo 讀到 `undefined` | DD-2 規定 useFreshnessClock module-level singleton；不存在「沒 tick」情境 | `useFreshnessClock` 的 module-level init 是 side-effect；test setup 必須 import 一次驅動 init |
| DD-6 刪除不乾淨 → 某處殘留 `authorityBlocked` | R4.S1 驗收門檻；會被誤用重新接進 UI | `CONNECTION_STATUS_RESIDUAL` 在 CI pipeline 跑 grep（tasks.md 4.3） |

---

## Error ↔ Requirement Traceability

| Error Code | 觸發的 Requirement |
|---|---|
| `FRESHNESS_INVALID_TIMESTAMP` | R5.S1, R5.S2 |
| `FRESHNESS_TWEAKS_LOAD_FAILED` | R6（與 flag 預設行為掛勾） |
| `FRESHNESS_TWEAKS_OUT_OF_RANGE` | R6（server parser 責任） |
| `FRESHNESS_TWEAKS_INVALID_FLAG` | R6.S1 / R6.S2 之間的 invalid-input 路徑 |
| `CONNECTION_STATUS_RESIDUAL` | R4.S1 |
| `CLOCK_JUMP_DETECTED` | R2.S4（freshnessNow 穩定性觀察） |
