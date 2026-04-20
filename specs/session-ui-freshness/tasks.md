# Tasks: session-ui-freshness

Canonical execution checklist。每個 task 對到 spec 的 Requirement + C4/IDEF0 的 module。進入 `implementing` 後由 TodoWrite 逐 phase 載入（plan-builder §16.1）。

**Task state 約定**（plan-builder §16.2）：

| 標記 | 意義 |
|---|---|
| `- [ ]` | pending（可接手） |
| `- [~]` | in_progress（每批至多一個） |
| `- [x]` | completed |
| `- [>]` | 委派 subagent |
| `- [!]` | blocked（行尾註明原因） |
| `- [?]` | 需使用者決策 / 核准 |
| `- [-]` | 取消 / 廢止（`~~title~~ cancelled: reason`） |

---

## 1. Data-schema + reducer 打底（Phase 1 + Phase 2）

- [ ] 1.1 `packages/app/src/context/global-sync/types.ts` 擴充 `StoreSessionStatusEntry` / `StoreActiveChildEntry` / `StoreMonitorEntry`，加 inline `receivedAt: number`（intersection type `ServerPayload & ClientStampMeta`） [R1, DD-1, DD-8, CMP C1.2]
- [ ] 1.2 `packages/app/src/context/global-sync/event-reducer.ts` — `session.status` / `session.active-child.updated` / `monitor.*` / 任何 session-scoped event handler 寫入時同步 `receivedAt = Date.now()` [R1.S1, R1.S2, R1.S3, DD-1, CMP C1.1]
- [ ] 1.3 `packages/app/src/context/global-sync/child-store.ts` 等初始化路徑：新建 entry 時 `receivedAt` 預設 `0`（讓 R5 instant-stale 自動啟動） [R5, DD-4, CMP C1.2]
- [ ] 1.4 新 test `packages/app/test/event-reducer-freshness.test.ts`（或併入既有 `event-reducer.test.ts`）— 覆蓋 R1.S1 / R1.S2 / R1.S3，確認 `receivedAt` 被寫入且 server `updatedAt` 不被覆蓋 [R1]
- [ ] 1.5 phase summary 寫入 `docs/events/event_2026-04-21_session_ui_freshness_implementation.md`（建檔）

## 2. useFreshnessClock helper + FrontendTweaks signals

- [ ] 2.1 新檔 `packages/app/src/hooks/use-freshness-clock.ts` — 單一 `setInterval(1000)` + shared Solid signal `freshnessNow`（module-level singleton，非 per-caller） [R2.S4, DD-2, CMP C1.3]
- [ ] 2.2 `packages/app/src/context/frontend-tweaks.ts` 暴露三個新 signal：`uiFreshnessEnabled()`、`uiFreshnessThresholdSec()`、`uiFreshnessHardTimeoutSec()`；fetch fail 時走預設值 (0, 15, 60) [R6, DD-3, DD-5, CMP C1.4]
- [ ] 2.3 `packages/opencode/src/config/tweaks.ts` 新增三個 key parser + 預設值 + INV clamp（range 1..3600 soft / 1..86400 hard；flag 限 0/1） [DD-3, DD-5, CMP C2.1]
- [ ] 2.4 `packages/opencode/src/server/routes/config.ts` — `GET /config/tweaks/frontend` response 加三欄位（遵守 `data-schema.json#TweaksFrontendResponse`） [CMP C2.2]
- [ ] 2.5 `templates/system/tweaks.cfg` 加三個 key 的註解 + 預設值（註解帶 `ui_freshness_*` 前綴說明） [CMP C2.3]
- [ ] 2.6 新 test `packages/opencode/test/config/tweaks-freshness.test.ts` — defaults / overrides / invalid range clamp 至少 5 個 assertion
- [ ] 2.7 新 test `packages/opencode/test/server/frontend-tweaks-freshness-route.test.ts` — verify response shape 含三欄位

## 3. UI freshness consumption

- [ ] 3.1 `packages/app/src/pages/session.tsx` — `activeChildDock` memo 重寫：讀 `receivedAt` + `freshnessNow()` + thresholds，計算 `fidelity ∈ {fresh, stale, hard-stale}`；`flag=0` 早退回 `fresh` [R2.S1/S2/S3, R6.S1/S2, CMP C1.5]
- [ ] 3.2 `packages/app/src/pages/session/session-side-panel.tsx` — process-card render 消費 `fidelity`；`stale` 顯示 `"updated Ns ago"` badge；`hard-stale` 灰化或收合 [R2.S2/S3, CMP C1.6]
- [ ] 3.3 `packages/app/src/pages/session/tool-page.tsx` — process-list elapsed timer 改讀 `receivedAt`；`hard-stale` 停止跳秒 [R2.S3, DD-7, CMP C1.7]
- [ ] 3.4 `packages/app/src/pages/session/monitor-helper.ts` — `ProcessCard` factory 複製 `receivedAt` 並計算 `elapsed = Math.max(0, now - receivedAt)`（語義澄清，欄位名不動） [DD-7, CMP C1.8]
- [ ] 3.5 建立 shared `classifyFidelity(receivedAt, now, soft, hard)` util（單一 source of truth，R5 檢查在這裡做） [R5.S1/S2, DD-4]
- [ ] 3.6 新 test 覆蓋 R2.S1/S2/S3/S4 + R5.S1/S2：freshness boundary、tick 重算、invalid receivedAt → hard-stale
- [ ] 3.7 phase summary（Phase 3 完成後）寫入 event log

## 4. Connection-state coupling 清理（DD-6）

- [ ] 4.1 `packages/app/src/context/global-sdk.tsx` — 移除 `connectionStatus` signal、`GlobalConnectionStatus` type、`useConnectionStatusToast`、`connectionAuthorityReady` memo；SSE EventSource 的原生 auto-reconnect 保留 [R4, DD-6, CMP C1.10]
- [ ] 4.2 `packages/app/src/components/prompt-input.tsx` — 移除 `authorityBlocked()` / `connectionState()` memo + 相關 effect；permission/question pending 既有 block 保留 [R3.S1/S2, R4, DD-6, CMP C1.9]
- [ ] 4.3 Grep audit：`grep -rE 'connectionStatus|authorityBlocked|connectionState' packages/app/src/` 必須為空（除本 plan 的 docs） [R4.S1]
- [ ] 4.4 Type check：`bun run typecheck` 需零新錯（前面 DD-6 的 code 若有別處 import，順手清） [R4]
- [ ] 4.5 新 smoke test：PromptInput 在「SSE disabled」情境下送訊息仍可觸發 `sdk.session.prompt()`（stub REST） [R3.S1]

## 5. Rollout gate + 驗收 + 文件

- [ ] 5.1 Feature flag 路徑驗證：在 `classifyFidelity` 前先檢查 `uiFreshnessEnabled()`，flag=0 時 byte-equivalent 走 baseline [R6.S1, DD-5]
- [ ] 5.2 Baseline pixel-diff：同一 session fixture 在 `flag=0` 與 `2fa1b0b2d~1` commit 下 render 輸出一致（手動，可用 screenshot 比對） [R6.S1]
- [ ] 5.3 「SSE silence 30s」情境手動驗收：開 session → 手動 `sudo kill` gateway → 觀察 15s 出現 stale hint、60s 出現 hard-stale 降級 [R2.S2/S3]
- [ ] 5.4 `docs/events/event_2026-04-21_session_ui_freshness_implementation.md` — 實作完成後 final event entry（含 test results + manual verification outcomes）
- [ ] 5.5 `specs/architecture.md` 新增「UI freshness contract」段（freshness ≠ connection health 原則 + `receivedAt` inline 約定 + `classifyFidelity` 為 single source of truth） [R4, DD-1, DD-6]
- [ ] 5.6 `plan-promote.ts specs/session-ui-freshness/ --to verified --reason "<evidence summary>"` — 全 5 phase 完成、手動驗收 PASS 之後執行

---

## Traceability matrix

| Task | Requirement | Design Decision | C4 Component |
|---|---|---|---|
| 1.1, 1.2, 1.3 | R1 | DD-1, DD-4, DD-8 | C1.1, C1.2 |
| 2.1 | R2.S4 | DD-2 | C1.3 |
| 2.2–2.7 | R6 | DD-3, DD-5 | C1.4, C2.1, C2.2, C2.3 |
| 3.1–3.6 | R2, R5 | DD-4, DD-7 | C1.5, C1.6, C1.7, C1.8 |
| 4.1–4.5 | R3, R4 | DD-6 | C1.9, C1.10 |
| 5.1–5.6 | R6 | DD-5 | (all) |

---

## Delegation hints

- Phase 1 / Phase 2 偏 mechanical file wiring → 可主線單 agent 執行
- Phase 3 UI render 可能適合 `frontend-design` skill 協作（stale badge / card 樣式與 Tailwind 風格對齊）
- Phase 4 grep + delete → 適合 `Explore` subagent 先 pass 一輪列出所有 match
- Phase 5 文件 + 架構同步 → 單 agent
