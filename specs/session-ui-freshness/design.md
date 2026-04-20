# Design: session-ui-freshness

## Context

2026-04-20 RCA（`docs/events/event_2026-04-20_frontend_oom_rca.md` I-4）
確認原 commit `2fa1b0b2d` 的 frontend 部分方向錯誤——把 SSE 連線 health
當 data freshness 的代理。該實作已整塊 revert 到 `2fa1b0b2d~1` 狀態
（merge `490783777`），但被 revert 掉的 UX 顧慮（「資料看起來正常卻其實已過時」）
本身是合法的，需要用**正確方向**重寫。

本 spec 的正確方向：每筆 session-scoped 資料在 client reducer 寫入 store 時
附加 `receivedAt` 時間戳；UI 依 `receivedAt` 計算 freshness 決定 render fidelity；
完全不碰 SSE 連線狀態、不追蹤連線統計、不向 UI 暴露 connectionStatus signal。

## Goals / Non-Goals

### Goals

- 資料 freshness 從「資料自己」長出來，與連線層解耦
- UI 在資料過時時**顯式降級**（而非靜默誤導使用者）
- `PromptInput` 不因連線問題 block（REST send 有自己的 queue 語義）
- 整套行為可由 feature flag 一鍵開關、Rollout 安全
- 不引入任何新的 server-side 變更（純 client 改動）

### Non-Goals

- 讓使用者感知連線健康本身（連線狀態是 SSE 層內部實作細節）
- 重寫 SSE reconnect 邏輯（EventSource 原生重連就夠用）
- 補齊 gateway / daemon 的 heartbeat 機制（兩件獨立 plan）
- TUI 端的 stale-data 處理（另開 plan）
- 處理 client↔server schema/version handshake（I-9 獨立 plan）

## Decisions

### DD-1 · Inline `receivedAt` field (not wrapper) · 2026-04-20
Store entry shape 改造採 **inline**：原物件直接加 `receivedAt: number` 欄位，
型別上用 `ServerPayload & { receivedAt: number }` 表達 client-side 擴充。

**Rationale**：只有少數 freshness-aware UI memo 會讀 `receivedAt`；
若採 wrapper（`{ value, receivedAt }`），所有 consumer（幾十個 call site）
都要改 `.value` 存取，ROI 負面。Inline 讓既有 call site 無痕相容，
額外 `receivedAt` 欄位只影響真正關心 freshness 的 UI。

**Trade-off 接受**：client store entry 型別與 server payload 型別不再 identity；
以 TypeScript intersection type 命名（如 `StoreSessionStatusEntry = ServerSessionStatus & ClientStampMeta`）
讓型別意圖清楚。

### DD-2 · Single `useFreshnessClock()` signal · 2026-04-20
建立一個全域共用的 `freshnessNow` signal，由 `useFreshnessClock()` helper
以 1 秒間隔 `setInterval` 推進。所有 freshness-aware memo 訂閱同一個 signal。

**Rationale**：避免每個 component 各自 `setInterval` 造成 tick 不一致 + 重複 timer。
單一 clock 在 N 個 entry 下只有 N-1 次 memo 重算的 cost，不會因元件數線性放大 timer。

**Tick interval = 1s**：Sub-second 解析度對 UX 無意義（人眼不會察覺 500ms 差異）；
比 1s 快會造成 render storm。

### DD-3 · Threshold 從 `/config/tweaks/frontend` 讀 · 2026-04-20
不在程式碼 hardcode 閾值。改讀 tweaks.cfg：

- `ui_session_freshness_enabled` · boolean · default `0`
- `ui_freshness_threshold_sec` · int · default `15`
- `ui_freshness_hard_timeout_sec` · int · default `60`

透過 `packages/app/src/context/frontend-tweaks.ts`（既有 infra）暴露給 UI。

**Rationale**：符合 `feedback_tweaks_cfg.md`；不同部署場景（弱網、VPN、移動端）
可個別 tuning；A/B test 時不必改 code。

### DD-4 · Missing / invalid `receivedAt` → instant-stale · 2026-04-20
遵守 AGENTS.md 第一條「禁止靜默 fallback」。`receivedAt` 為 `undefined`、
`NaN`、`Infinity`、負數或非 number → 視為 `0`（立即過期），UI 顯示 hard-stale。
`NaN`/`Infinity` 額外觸發 rate-limited `console.warn`。

**Rationale**：如果 `receivedAt` 遺失，預設當成 fresh 會讓使用者看到
「資料看起來正常但 UI 其實不知道該資料的新舊」——正是本 plan 要避免的。
保守方向是寧可誤報 stale，不可誤報 fresh。

### DD-5 · Feature flag `ui_session_freshness_enabled`（預設 0） · 2026-04-20
整套行為由 flag 控制。Flag=0：`receivedAt` 仍寫入 store（cost 忽略），
但所有 UI memo bypass freshness 計算、render 結果 byte-equivalent 於
`2fa1b0b2d~1` baseline。Flag=1：所有 Scenario 2.x / 5.x 行為啟動。

**Rationale**：給 Rollout 保險，異常可一鍵回退（改 `/etc/opencode/tweaks.cfg` 即可，
不需要重新 deploy）。Rollout 穩定後在後續 amend 移除 flag + 死碼。

### DD-6 · `connectionStatus` signal 徹底移除 · 2026-04-20 （使用者拍板）
完全刪除連線狀態在 client-side 的所有對外 surface：

- `globalSDK.connectionStatus()` export
- `GlobalConnectionStatus` type
- `useConnectionStatusToast`
- `connectionAuthorityReady` memo
- PromptInput 的 `authorityBlocked` / `connectionState` memo 與相關 effect

**Rationale**：本 plan 的核心主張就是「連線健康與 UI 完全解耦」。保留任何
internal diagnostic signal 等於留著誘惑，讓未來某個 commit 又把它接進 UI
（正如 `2fa1b0b2d` 那樣）。根除比圍堵徹底。

如未來真需要 SSE telemetry / debug，另起 `observability-connection-metrics` plan
走 backend event log，不經 client UI 層。

### DD-7 · `ProcessCard.elapsed` 語義澄清（不改型別名） · 2026-04-20
原 `ProcessCard.elapsed` 欄位語義改為 "time since last daemon confirmation"
（即由 `receivedAt` 計算得出，而非從 `startedAt` 無條件 tick）。
**保留欄位名 `elapsed` 不改名**，避免 call site 連鎖修改。

**Rationale**：欄位名改動需要觸及 `monitor-helper.ts` / `session-side-panel.tsx` /
`tool-page.tsx` 所有 call site；語義澄清在 design.md + code comment 記錄即可。
若未來欄位有第三種語義（例如 backend 送的 true elapsed），屆時再命名區分。

### DD-8 · 不引入 `value` wrapper 也不引入 `meta` sub-object · 2026-04-20
與 DD-1 呼應。`receivedAt` 就是 store entry 的 top-level 欄位，
**不**包成 `entry.meta.receivedAt` 這類階層。

**Rationale**：`meta` sub-object 只有一個欄位時是過度設計；未來若需要 `meta.source`、
`meta.schemaVersion` 等多個 meta 欄位，再以 `revise` / `extend` mode 重構。

---

## Risks / Trade-offs

| Risk | Impact | Mitigation |
|---|---|---|
| `useFreshnessClock` 每秒重算 N 個 freshness memo，大 session 造成 jank | 中 | Memo 只依賴 `receivedAt` 與 `freshnessNow` 兩個訊號；Solid 的 fine-grained reactivity 只對「落入新 threshold bucket」的 entry 觸發 re-render |
| Feature flag=0 但 `receivedAt` 仍寫 store → 無謂 memory overhead | 低 | 每個 entry 多 8 bytes；1000 entries = 8KB；可忽略 |
| Rollout 期間 `/config/tweaks/frontend` 未更新 → 舊 client 讀不到 key | 中 | `frontend-tweaks.ts` 對 missing key 走預設值（既有 infra 行為）；不破壞 |
| Clock skew（客戶端時間跳動、系統時間被改） | 低 | `receivedAt` 完全 client-local，跨 session 不比較；tab 睡眠時 `Date.now()` 準確恢復 |
| DD-6 決策反覆 → 連線層重新暴露 signal → 倒退 `2fa1b0b2d` | 中 | design.md 明文禁止；`specs/architecture.md` 新增「UI freshness contract」段作為長期 guardrail |
| 刪除 `authorityBlocked` 後發現某個 edge case 真的需要 block | 中 | Scenario 3.2 明確指出 permission / question pending 仍 block（不同機制）；其他 edge case 走 revise mode 明確補 Requirement |
| 使用者抱怨「15s 才開始標 stale 太慢」 | 低 | 閾值在 tweaks.cfg 可改；無需 rebuild |

---

## Critical Files

### Client-side（本 plan 改動）

- `packages/app/src/context/global-sync/types.ts` — store entry 型別加 `receivedAt`
- `packages/app/src/context/global-sync/event-reducer.ts` — event handler 寫入時戳 `receivedAt = Date.now()`
- `packages/app/src/context/global-sync/child-store.ts` — 初始化路徑同步（若有）
- `packages/app/src/context/global-sdk.tsx` — 移除 `connectionStatus` signal（DD-6）
- `packages/app/src/components/prompt-input.tsx` — 移除 `authorityBlocked` / `connectionState` memo（DD-6）
- `packages/app/src/pages/session.tsx` — `activeChildDock` memo freshness-aware
- `packages/app/src/pages/session/session-side-panel.tsx` — process-card freshness-aware
- `packages/app/src/pages/session/tool-page.tsx` — process-list freshness-aware
- `packages/app/src/pages/session/monitor-helper.ts` — `ProcessCard.elapsed` 語義改從 `receivedAt` 算
- `packages/app/src/context/frontend-tweaks.ts` — 暴露 3 個新 tweak key
- `packages/app/src/hooks/use-freshness-clock.ts` — **新檔**，DD-2 helper

### Server-side（配合新增 tweak key；純 config 面）

- `packages/opencode/src/config/tweaks.ts` — 加 3 個新 key 的 parser + 預設值
- `packages/opencode/src/server/routes/config.ts` — `/config/tweaks/frontend` response 加 3 個新欄位
- `templates/system/tweaks.cfg` — 加 3 個新 key 的說明 + 預設值

### Test / docs

- `packages/app/src/pages/session/__tests__/freshness-*.test.tsx`（新）— R1 ~ R6 scenario coverage
- `docs/events/event_2026-04-21_session_ui_freshness_implementation.md`（實作啟動日開）
- `specs/architecture.md` — 新增「UI freshness contract」段

---

## Open Questions

1. ~~**DD-6 最終方向**~~ → 已拍板完全刪（2026-04-20）
2. **Rollout flag retirement trigger**：當 R1 ~ R6 的 acceptance tests 全綠 + 手動驗收通過即進入 amend 移除 flag 與死碼（不綁定時間窗）。使用者 2026-04-20 確認。
3. **UI 視覺設計**：stale badge / card 收合 / 灰化的具體 UI 風格——Phase 3 實作時與 Tailwind 風格表對齊，必要時 invoke `frontend-design` skill。
