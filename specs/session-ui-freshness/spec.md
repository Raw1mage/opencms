# Spec: session-ui-freshness

## Purpose

使 UI 對使用者誠實陳述「這塊 session-scoped 資料最後一次被 server 確認是幾秒前」，
並在超過閾值時**顯式降級**（標示 stale、收合 card、灰化 elapsed timer）——
而不是把資料裝成實時的模樣。

Freshness 由資料自己的時間戳決定，**不由 SSE 連線 health 代理**。

---

## Requirements

### Requirement: R1 — Per-data freshness tracking

每筆受保護的 session-scoped store entry 在 client reducer 寫入時
**附加 `receivedAt: number`（ms since epoch, client wall-clock）**。

受保護範圍（§Scope IN）：
- `State.session_status[sid]`
- `State.active_child[sid]`
- `State.session_monitor[sid]`

#### Scenario: R1.S1 — Event 抵達更新 store entry
- **GIVEN** store entry `session_status[sid]` 目前 `receivedAt = T0`
- **WHEN** client reducer 在 wall-clock `T1` 處理 `session.status` event（針對 sid）
- **THEN** store entry `session_status[sid].receivedAt === T1`
- **AND** server payload 欄位（`state`、`updatedAt`、...）按 event 內容更新
- **AND** `T1 > T0`（monotonic within single client）

#### Scenario: R1.S2 — Entry 首次建立
- **GIVEN** store entry `active_child[sid]` 不存在
- **WHEN** client reducer 在 wall-clock `T` 處理 `session.active-child.updated` event 寫入新 entry
- **THEN** 新 entry `receivedAt === T`

#### Scenario: R1.S3 — Server payload 與 client clock 分離
- **GIVEN** event payload 含 server timestamp `updatedAt = Ts`
- **WHEN** client 在 `Tc` 收到並寫入 store
- **THEN** entry `updatedAt === Ts`（原樣保留）
- **AND** entry `receivedAt === Tc`（client 自己戳）
- **AND** 兩個 field 不互相覆蓋

---

### Requirement: R2 — UI freshness-based degradation

UI 元件讀 `receivedAt` + 當下時間 + 閾值，決定 render fidelity。

閾值分兩段：
- **soft threshold**（`ui_freshness_threshold_sec`，預設 15s）→ 顯示 stale badge / "updated N ago"
- **hard threshold**（`ui_freshness_hard_timeout_sec`，預設 60s）→ card 灰化 / 收合 / 隱藏

#### Scenario: R2.S1 — 新鮮資料正常 render
- **GIVEN** entry `receivedAt = T`, now = `T + 5s`, soft=15s, hard=60s
- **WHEN** UI memo 計算 fidelity
- **THEN** render 如常，不顯示 stale hint

#### Scenario: R2.S2 — 超過 soft threshold → stale hint
- **GIVEN** entry `receivedAt = T`, now = `T + 20s`, soft=15s, hard=60s
- **WHEN** UI memo 計算 fidelity
- **THEN** render 時顯示 "updated 20s ago" / stale badge
- **AND** 資料內容照常顯示（不隱藏）

#### Scenario: R2.S3 — 超過 hard timeout → 降級
- **GIVEN** entry `receivedAt = T`, now = `T + 75s`, soft=15s, hard=60s
- **WHEN** UI memo 計算 fidelity
- **THEN** card 灰化或收合（依元件設計）
- **AND** elapsed timer 停止跳秒（或加 "stale" 前綴）

#### Scenario: R2.S4 — `useFreshnessClock()` 驅動重算
- **GIVEN** 任意 freshness-aware memo 訂閱 `freshnessNow` signal
- **WHEN** `useFreshnessClock()` 每 1s 推進 `freshnessNow`
- **THEN** memo 自動重算、render 結果根據最新 now 更新
- **AND** 未訂閱 `freshnessNow` 的 component 不受影響

---

### Requirement: R3 — PromptInput 不受連線狀態 gate

Prompt send 透過 REST API queue 到 server，與 SSE 連線無關。

#### Scenario: R3.S1 — SSE 斷線時仍可送
- **GIVEN** 當下 SSE 連線處於任何狀態（connected / disconnected / reconnecting）
- **WHEN** 使用者在 PromptInput 按 Enter 送訊息
- **THEN** REST call `POST /session/:id/message` 被發出
- **AND** PromptInput 不因 SSE 狀態顯示 disabled / blocked

#### Scenario: R3.S2 — Permission / question pending 時仍 block（既有行為）
- **GIVEN** 當前 session 有 pending permission 或 pending question
- **WHEN** 使用者嘗試送訊息
- **THEN** PromptInput 顯示既有 pending 狀態、block send
- **AND** block 理由完全與連線無關

---

### Requirement: R4 — Connection-state signal 徹底退場

`globalSDK.connectionStatus()` signal / `GlobalConnectionStatus` type / 相關 toast / memo
**完全移除**（DD-6，使用者 2026-04-20 拍板）。SSE 底層仍自動重連，只是不再向 UI 層暴露狀態。

#### Scenario: R4.S1 — Grep 檢查無殘留
- **GIVEN** 本 plan 完成
- **WHEN** 在 `packages/app/src/` 跑 `grep -r 'connectionStatus\|authorityBlocked\|connectionState'`
- **THEN** 不應有任何 match（除了本 plan 的 docs / 刪除說明）

#### Scenario: R4.S2 — SSE 底層重連如舊
- **GIVEN** SSE 連線斷開
- **WHEN** EventSource 自動重連（瀏覽器原生行為）
- **THEN** 重連完成後 event handler 繼續收 event、繼續寫 `receivedAt`
- **AND** 無任何 UI 層 signal 被觸發

---

### Requirement: R5 — Missing / invalid receivedAt → instant-stale

遵守 AGENTS.md 第一條「禁止靜默 fallback」（DD-4）。

#### Scenario: R5.S1 — receivedAt undefined
- **GIVEN** store entry `receivedAt === undefined`
- **WHEN** freshness memo 計算 fidelity
- **THEN** 視為 `receivedAt = 0`（立即過期）
- **AND** UI 顯示 hard-stale（不是 fresh）

#### Scenario: R5.S2 — receivedAt 非 finite number
- **GIVEN** store entry `receivedAt = NaN` 或 `Infinity`
- **WHEN** freshness memo 計算 fidelity
- **THEN** 視為 `receivedAt = 0`
- **AND** console.warn 記錄一次（rate-limited per entry id, ≤1/min）

---

### Requirement: R6 — Feature flag 控制 rollout

整套新行為由 tweaks.cfg key `ui_session_freshness_enabled` 控制（DD-5）。

#### Scenario: R6.S1 — Flag = 0（預設）
- **GIVEN** `ui_session_freshness_enabled = 0`
- **WHEN** client 啟動
- **THEN** `receivedAt` 欄位仍被寫入 store（cost 忽略）
- **AND** UI memo 一律當成 fresh、不顯示任何 stale hint
- **AND** UI 行為等同 `2fa1b0b2d~1` 的 baseline（byte-equivalent render）

#### Scenario: R6.S2 — Flag = 1
- **GIVEN** `ui_session_freshness_enabled = 1`
- **WHEN** client 啟動
- **THEN** 所有 freshness-aware memo 啟動
- **AND** Scenario R2.Sx / R5.Sx 行為生效

---

## Acceptance Checks

- [ ] **Automated**：`test-vectors.json` 列出 R1.S1 / R2.S1~S3 / R5.S1~S2 / R6.S1~S2 的具體 input/output 並由 `packages/opencode/test/` 或 `packages/app/test/` 對應測試覆蓋
- [ ] **Manual**：`flag=0` 下 session.tsx / session-side-panel / tool-page / prompt-input 的 render 與 baseline pixel-diff 無差異
- [ ] **Manual**：`flag=1` 下模擬「session.status 寫入後 server 沉默 30s」情境（手動 kill SSE），UI 於 15s 內顯示 "updated 15s ago"，60s 後降級
- [ ] **Grep**：`packages/app/src/` 無 `connectionStatus` / `authorityBlocked` / `connectionState` 殘留
- [ ] **Docs**：`docs/events/event_2026-04-21_*.md` 開實作事件檔；`specs/architecture.md` 新增「UI freshness contract」段

---

## Traceability

| Spec Requirement | proposal.md § | tasks.md Phase (planned) |
|---|---|---|
| R1 Per-data tracking | Effective Req 1 | Phase 1 + Phase 2 |
| R2 UI degradation | Effective Req 2 | Phase 3 |
| R3 PromptInput 解耦 | Effective Req 3 | Phase 4 |
| R4 Connection signal 退場 | Effective Req 4, 5 | Phase 4 |
| R5 No silent fallback | Constraints | Phase 1 + Phase 3 |
| R6 Feature flag | Constraints + Phase 5 | Phase 5 |
