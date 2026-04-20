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

- [x] 1.1 `packages/app/src/context/global-sync/types.ts` 擴充 `StoreSessionStatusEntry` + `StoreActiveChildEntry`，加 inline `receivedAt: number`（intersection `ServerPayload & ClientStampMeta`）。**Scope 修正 2026-04-20**：原 proposal 列的 `State.session_monitor` 不存在——監看資料實際位於 `useStatusMonitor` hook，留待 Phase 3 task 3.4 連同 `ProcessCard` 一併處理。Typecheck 曝光 5 個需補戳點（bootstrap.ts:260, event-reducer.ts:243, event-reducer.test.ts:223/270/651）由 1.2-1.4 覆蓋。 [R1, DD-1, DD-8, CMP C1.2]
- [x] 1.2 `event-reducer.ts` — `session.status` + `session.active-child.updated` 兩個 handler 寫入時戳 `receivedAt = Date.now()`；`monitor.*` 路徑 scope 修正延至 Phase 3.4 處理（監看資料不在 State 裡） [R1.S1, R1.S2, R1.S3, DD-1, CMP C1.1]
- [x] 1.3 初始化路徑：`child-store.ts` 用 `{}` 空 map 初始化（無 entry 即無 `receivedAt` 負擔）；`bootstrap.ts` 的 bulk `session.status()` call 改用 per-entry stamp `receivedAt = now`（**not 0**；`receivedAt=0` 是為「entry 存在但時間戳缺失」保留的 instant-stale 語義，正常 bulk 載入要當 fresh） [R5, DD-4, CMP C1.2]
- [x] 1.4 新 test 併入 `event-reducer.test.ts` — 覆蓋 R1.S1 / R1.S2 / R1.S3；確認 `receivedAt` 被寫入、server-side 額外 timestamp 不被覆蓋；順手修 3 個既有 fixture。23 pass / 0 fail，typecheck clean [R1]
- [x] 1.5 phase summary 寫入 `docs/events/event_2026-04-20_session_ui_freshness_implementation.md`（建檔；日期用實際開工日而非 handoff placeholder）

## 2. useFreshnessClock helper + FrontendTweaks signals

- [x] 2.1 新檔 `packages/app/src/hooks/use-freshness-clock.ts` — 單一 `setInterval(1000)` + module-level Solid signal `freshnessNow`；附 dev console helper + test stop/inject helpers [R2.S4, DD-2, CMP C1.3]
- [x] 2.2 `frontend-tweaks.ts` 暴露 `uiFreshnessEnabled()` / `uiFreshnessThresholdSec()` / `uiFreshnessHardTimeoutSec()`；FrontendTweaks interface 加三欄 + defaults 加三值 [R6, DD-3, DD-5, CMP C1.4]
- [x] 2.3 `packages/opencode/src/config/tweaks.ts` 新增 `SessionUiFreshnessConfig` + defaults + parser；soft >= hard 的 clamp（soft = hard - 1） [DD-3, DD-5, CMP C2.1]
- [x] 2.4 `server/routes/config.ts` 回應 + zod schema 加三欄（route reads from `Tweaks.sessionUiFreshness()`） [CMP C2.2]
- [x] 2.5 `templates/system/tweaks.cfg` 加新區段 + 3 key 註解 + 預設值 [CMP C2.3]
- [x] 2.6 擴充 `packages/opencode/test/config/tweaks.test.ts` — 新 8 個 freshness 測試（defaults / flag / soft range / hard range / soft>=hard clamp / soft==hard clamp / coexist）。25 pass / 0 fail
- [x] 2.7 擴充 `packages/opencode/test/server/frontend-tweaks-route.test.ts` — 新 2 個 freshness 測試（defaults in response / overrides surface）。4 pass / 0 fail

## 3. UI freshness consumption

- [x] 3.1 `session.tsx` — `activeChildDock` memo 接 `classifyFidelity()`；dock 物件新增 `fidelity` + `receivedAt` 欄位；onInvalid 接 `createRateLimitedWarn` 寫 console.warn（≤1/min/sessionID）。render-side 視覺套色/收合留待 PromptInput 消費端處理 [R2.S1/S2/S3, R6.S1/S2, R5, CMP C1.5]
- [x] 3.2 `session-side-panel.tsx` — process-card 容器套 opacity（stale=0.75 / hard-stale=0.4）+ italic "updated Ns ago" badge；hard-stale 的 elapsed timer 凍結（改 return ""）；invalid receivedAt 走 createRateLimitedWarn [R2.S2/S3, R5, CMP C1.6]
- [x] 3.3 `tool-page.tsx` — 套與 3.2 同模式的 fidelity memo + opacity + stale badge + elapsed 凍結 [R2.S3, DD-7, CMP C1.7]
- [x] 3.4 `monitor-helper.ts` — `EnrichedMonitorEntry` + `ProcessCard` 都加 optional `receivedAt`；`buildProcessCards` 取每個 group entries 的最大 `receivedAt` 當 card.receivedAt；`useStatusMonitor` 在 poll result 到達時對每個 item 戳 `receivedAt = Date.now()`（`StampedMonitorItem` 型別）。原 SessionMonitorInfo[] 透過 spread 自動帶入 receivedAt 到 EnrichedMonitorEntry [DD-7, CMP C1.8]
- [x] 3.5 新檔 `packages/app/src/utils/freshness.ts` 含 `classifyFidelity()` + `createRateLimitedWarn()`；單一 source of truth；R5 檢查（undefined / NaN / Infinity / negative / 0 → hard-stale）+ flag=0 bypass 全涵蓋。新 test `freshness.test.ts` 18 pass / 0 fail [R5.S1/S2, DD-4, DD-5]
- [x] 3.6 R2.S1-S3 + R5.S1-S2 + R6.S1-S2 的核心邏輯覆蓋於 `freshness.test.ts`（18 pass）。R2.S4 `useFreshnessClock` tick 重算屬 Solid reactive 行為、需 integration 層級 harness，延 Phase 5 手動驗收覆蓋。
- [x] 3.7 phase summary 已 append 到 `docs/events/event_2026-04-20_session_ui_freshness_implementation.md`

## 4. Connection-state coupling 清理（DD-6）

- [x] 4.1 `global-sdk.tsx` — 確認無殘留（2026-04-20 I-4 revert 已徹底移除 connectionStatus signal、GlobalConnectionStatus type、useConnectionStatusToast、connectionAuthorityReady memo）；SSE EventSource 原生 auto-reconnect 保留 [R4, DD-6, CMP C1.10]
- [x] 4.2 `prompt-input.tsx` 本身無 DD-6 殘留；`session-prompt-dock.tsx` 順手接 `activeChild.fidelity`：卡片套 opacity（stale=0.75 / hard-stale=0.4）+ "stale" italic 標籤 + hard-stale 凍結 elapsed timer。這是 Phase 3 的 drift 在 Phase 4 集中處理 [R3.S1/S2, R4, DD-6, CMP C1.9]
- [x] 4.3 Grep audit：`grep -rEn 'connectionStatus|authorityBlocked|connectionState|GlobalConnectionStatus|useConnectionStatusToast|connectionAuthorityReady' packages/app/src/` → **零 match**（R4.S1 PASS） [R4.S1]
- [x] 4.4 Type check：`bun --silent x tsc --noEmit -p packages/app/tsconfig.json` → clean [R4]
- [!] 4.5 PromptInput send-during-disconnect smoke test — 延 Phase 5 手動驗收一併覆蓋（flag=0 + gateway 凍結情境）。REST send path 本 plan 未動、既有 error handling 保留，代碼面無 regression 風險。

## 5. Rollout gate + 驗收 + 文件

- [x] 5.1 Feature flag 路徑驗證：`classifyFidelity` 在 `enabled=false` 時 early-return `"fresh"`，所有消費端 memo 自動 bypass。freshness.test.ts 內 3 個 R6.S1/S2 case 明文覆蓋（包括 flag=0 + invalid receivedAt 仍回 fresh） [R6.S1, DD-5]
- [ ] 5.2 Baseline pixel-diff（post-merge 手動驗收）— `flag=0` 下所有新代碼早退，render 結構與 2fa1b0b2d~1 應為 byte-equivalent。請人工開 webapp（`ui_session_freshness_enabled=0` 設定下）比對 session / side-panel / tool-page 三處畫面確認無視覺差異。使用者沒異常即視為 PASS。[R6.S1]
- [ ] 5.3 「SSE silence 30s」手動驗收（flag=1 開啟前必做）— `ui_session_freshness_enabled=1` 後手動凍結 gateway：(a) 15s 內 process-card 出現 "updated Ns ago" 字樣 + opacity 75%；(b) 60s 後 opacity 40% 且 elapsed 凍結；(c) gateway 恢復後下一個 event 抵達，fidelity 跳回 fresh 視覺恢復。flag 啟用前強制前提。[R2.S2/S3, R2.S4]
- [x] 5.4 `docs/events/event_2026-04-20_session_ui_freshness_implementation.md` — Phase 1~3 summary 已寫入（實作完成後會於 fetch-back 時補 Phase 4/5 段）
- [x] 5.5 `specs/architecture.md` 新增「UI Freshness Contract」段（認定原則 / 授權路徑 / UI consumer 清單 / 禁止事項 / feature flag rollout） [R4, DD-1, DD-6]
- [?] 5.6 `plan-promote --to verified` — **待使用者 5.2 + 5.3 手動驗收 PASS 後執行**

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
