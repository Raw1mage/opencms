# Proposal: session-ui-freshness

## Why

2026-04-20 RCA（`docs/events/event_2026-04-20_frontend_oom_rca.md` I-4）確認：

- 原本 commit `2fa1b0b2d` 嘗試處理「UI 顯示的 session 狀態 stale」這個合法 UX 顧慮，但方向錯——把「SSE 連線 health」當「資料 freshness」的代理。
- 在有 proxy / keepalive idle-timeout 的網路（cms.thesmart.cc 正是如此），SSE 每 ~250ms flap 是常態；原設計把瞬斷當成值得 UI 反應的事件，造成 toast / memo 風暴 → 瀏覽器 OOM。
- 2026-04-20 已把 `2fa1b0b2d` 的 8 個 frontend 檔案退到 parent 狀態 + 刪除 2 份錯方向的 event docs。Backend 的 subagent continuation 相關改動保留不動。
- **結果**：stale UI detection 這個需求現在完全沒處理（回到 `2fa1b0b2d` 之前的 UX 弱點）。需要用正確方向重寫。

## Original Requirement Wording (Baseline)

（整理自 `2fa1b0b2d` 作者與 2026-04-20 對話中重新確認的使用者需求）

> 使用者在弱網路 / SSE 斷斷續續的情境下，UI 會顯示**過時但看起來正常**的資料：
> - Active-child card 還顯示「subagent running」→ 其實 server 早清掉
> - Process-card elapsed timer 繼續跳秒 → 其實 daemon 已不知道這個 session
> - Prompt-input 還讓使用者送訊息 → 可能送進一個 server 已不管的 session
> - Session status 顯示「running」→ 其實是幾秒前的舊狀態
>
> UI 說出的話要跟 server 實際狀態同步，或至少在不同步時顯式標出「這是 N 秒前的資料」，不能看起來像實時。

## Requirement Revision History

- 2026-04-20: initial draft created via plan-init.ts（作為 `2fa1b0b2d` 錯方向實作的替代）
- 2026-04-20: **decision locked** — store entry 型別改造採 inline（原物件加 `receivedAt` 欄位），非 wrapper（`{ value, receivedAt }`）。理由：只有少數 freshness-aware UI memo 會讀 `receivedAt`，大多數 consumer 不在乎；inline 讓現有 call site 不用改。缺點（client store entry 型別 ≠ server payload 型別）以 TypeScript 交集型別 `ServerPayload & { receivedAt: number }` 表達。

## Effective Requirement Description

1. **資料 freshness 由資料自己的 timestamp 決定，不由連線狀態決定。** 每筆受保護的 session-scoped 資料（`session_status`、`active_child`、`session_monitor` entries 等）在 store 裡夾一個 `receivedAt` 欄位，記錄該筆資料最後一次被 server 事件 / API 回應寫入的 wall-clock 時間。
2. **超過閾值的資料在 UI 要顯式降級（不是隱形刪除）。** 例如 "Running · 30s ago" 或把 active-child card 收合 + 顯示 "stale"。閾值可配置，預設 15 秒。
3. **Prompt input 不再因為連線狀態被 block。** 送訊息本來就透過 REST API 送（會 queue 到 server），沒有「連線不通就不能送」的語義。輸入只在真正該 block 的情況下（permission request pending、question request pending）才 block，與連線健康解耦。
4. **Client 端徹底移除 connection state machine。** 不存在 `connected / reconnecting / degraded / resyncing / blocked` 這類對外的信號。`globalSDK.connectionStatus()` 這個 API 面消失（或降級成 internal diagnostic only，不參與 UI render）。
5. **連線層只剩「收 event 就寫 store」一條邏輯。** SSE 斷了 → EventSource 內建自動重連（或 gateway 送 `retry:` hint）。Client 不追蹤連線狀態、不算統計、不觸發 UI。
6. **後續改進 (OUT OF SCOPE)**：
   - Server 側定期送 heartbeat event（例如 session idle 時每 10 秒 re-emit session.status）讓 receivedAt 自然保持新鮮 → 減少 UI 降級誤判。
   - Gateway 送 SSE heartbeat (`:\n\n`) + `retry:` 欄位 → 降低 browser 感知到的斷線頻率。
   - 這兩點屬 gateway 與 daemon 的優化，獨立 plan 處理。

## Scope

### IN
- `packages/app/src/context/global-sync/types.ts`：`State.session_status` / `State.active_child` / `State.session_monitor` 的 entry shape 加 `receivedAt: number`
- `packages/app/src/context/global-sync/event-reducer.ts`：收到對應 SSE event 時自動戳 `receivedAt = Date.now()`
- `packages/app/src/pages/session.tsx`：`activeChildDock` memo 依 `receivedAt` 判斷是否 hide / mark stale
- `packages/app/src/pages/session/session-side-panel.tsx`：process-card 顯示 "updated N ago" 欄位，基於 `receivedAt` 計算；超過 threshold 的 card 降級顯示
- `packages/app/src/pages/session/tool-page.tsx`：同上
- `packages/app/src/pages/session/monitor-helper.ts`：process-card 建構時把 `receivedAt` 帶到 `ProcessCard` 型別
- `packages/app/src/components/prompt-input.tsx`：移除 `connectionState()` / `authorityBlocked()` / force-sync-on-reconnect 相關 memo 與 effect（防禦性清理）
- `packages/app/src/context/global-sdk.tsx`：移除 `connectionStatus` signal 與 `GlobalConnectionStatus` type（如果因先前 revert 而已不存在，則只需確認不要重新引入）
- `/etc/opencode/tweaks.cfg` 新 key `ui_session_freshness_enabled`（預設 0）、`ui_freshness_threshold_sec`（預設 15）、`ui_freshness_hard_timeout_sec`（預設 60）

### OUT
- Gateway 改動（SSE heartbeat、`retry:` 欄位）— 獨立 plan
- Daemon 主動 re-emit 機制（periodic session.status heartbeat）— 獨立 plan
- `connectionStatus` 的 UI 外觀（已決定不做）
- TUI 端的 stale-data 處理（另開 plan）

## Non-Goals

- 讓使用者感知連線狀態本身：**明確不做**。使用者只需要感知「資料新舊」，不需要感知「連線健康」。
- Retry loop 的重寫：本 plan 不動 SSE reconnect 邏輯，只要它別把連線狀態 leak 給 UI。
- 替 `PromptInput` 加新的 "send 不出去" 的錯誤處理：如果 send API call 失敗，原本就有 REST error handling，本 plan 不重寫。

## Constraints

- **禁止靜默 fallback**（AGENTS.md 第一條）：`receivedAt` 遺失 / 格式錯誤 → 視為 `0`（等於立刻過期），UI 顯示最保守的 stale 狀態（不是當作新鮮資料）。
- **Feature flag**：整套行為由 `tweaks.cfg` `ui_session_freshness_enabled=1` 控制。Flag=0 時所有新邏輯繞過、UI 回到 `2fa1b0b2d~1` 的 baseline 行為（INV byte-equivalent）。Rollout 期結束後移除 flag。
- **不得重新引入 `connectionStatus` signal**：若發現之前退回的檔案有殘留 import 或 memo，本 plan 要順手清掉。
- **Threshold 固定從 `tweaks.cfg` 讀，不許 hardcode**：對照 `feedback_tweaks_cfg.md`。
- **Scope 侷限 session-scoped UI**：不擴及 file tree、model selector、provider list 等其他資料 freshness（它們有自己的 refresh 機制，本 plan 不碰）。

## What Changes

### Phase 1 — Data-schema 擴充
- 修改 `types.ts` 的 `State.session_status[sid]` / `State.active_child[sid]` / `State.session_monitor[sid]`，**直接在原物件加 `receivedAt: number` 欄位**（inline，非 wrapper；2026-04-20 使用者拍板）
- Client-side 型別與 server payload 型別分離：server payload 型別維持原狀；client store entry 型別是 `ServerPayload & { receivedAt: number }`
- 同步 `child-store.ts` 等初始化路徑
- 不動 server 端 payload shape；`receivedAt` 完全 client-side 產生

### Phase 2 — Event-reducer 自動戳 timestamp
- `message.part.updated`、`session.status`、`session.active-child.updated`、`monitor.*` 等 session-scoped event handler 在寫入 store 時同步寫 `receivedAt = Date.now()`
- 原本就有的 `updatedAt` 這類 server 時戳保留不動；`receivedAt` 是純 client 側的「我收到資料的時間」

### Phase 3 — UI 消費 freshness
- `activeChildDock` memo 讀 `receivedAt`：`now - receivedAt > threshold` → 顯示 stale badge 或整個 card 收合
- Process-card 的 elapsed 欄位改成 `"updated Ns ago"` 由 `now - receivedAt` 計算；超過 hard timeout → card 變灰或隱藏
- Session-side-panel、tool-page 的 process-list 同步處理
- 新增 `useFreshnessClock()` helper，每秒更新一次 `now` signal 讓所有 freshness memo 自動重算（避免每個 component 自己 setInterval）

### Phase 4 — 拆掉遺留 connection-status 痕跡
- 掃 `packages/app/src/` 確認沒有任何 `connectionStatus` / `authorityBlocked` / `connectionState` 殘留
- Prompt-input 的 keydown handler、form submit handler 確認不再 check connectionState
- 若發現殘留，整塊移除（這是 I-4 revert 的 after-commit 清理）

### Phase 5 — Feature flag + 驗收
- `tweaks.cfg` 加三個新 key
- 建立 fixture：模擬「收到 session.status 後 server 沉默 30 秒」的情境 → UI 應在 15s 後降級
- 對照 flag on/off 的行為差異：flag=0 時所有新欄位存在但不影響 render
- `docs/events/` 紀錄；`specs/architecture.md` 同步（freshness-first UI 原則）

## Capabilities

### New Capabilities
- **Per-data freshness tracking**：每筆 session-scoped 狀態帶 `receivedAt`。
- **Freshness-based UI degradation**：UI 元件依 freshness 決定 render fidelity，與連線狀態完全解耦。
- **`useFreshnessClock()` helper**：共用的每秒 tick 信號，避免多個元件各自輪詢。
- **Tweaks-driven threshold**：門檻可配置、有 fallback 預設值。

### Modified Capabilities
- `session_status` / `active_child` / `session_monitor` store entries：加 `receivedAt` 欄位。
- `ProcessCard` 型別：`elapsed` 欄位的語義重新定義為 "time since last daemon confirmation"，或改名 `updatedAgoSec` 清楚表達。
- `activeChildDock` memo、process-card render：freshness-aware。
- `PromptInput`：確認沒有 connection-status 依賴。

### Retired Capabilities
- `globalSDK.connectionStatus()` export（若還有）
- `GlobalConnectionStatus` type
- `useConnectionStatusToast`
- `connectionAuthorityReady` memo
- PromptInput 的 `authorityBlocked` / `connectionState` memo + 相關 effect

## Impact

- **Code**：§Scope IN 列出的 8 個檔案 + tweaks.cfg template。
- **API 契約**：**完全不動**。server 端 event payload、REST response shape 不變；`receivedAt` 在 client reducer 寫入 store 時才產生。
- **UX**：
  - 正常情況（有新 event 持續到達）：無差別
  - 弱網路 / server 沉默情境：card 顯示 "updated 30s ago" 或收合；而非像 `2fa1b0b2d` 那樣跳 toast 或 block input
  - Prompt input 永遠可送（被 permission / question block 的情境不變）
- **部署**：純 client 改動，backend 0 變更；可和既有 daemon 共存，rollout 風險低。
- **文件**：`specs/architecture.md` 新增「UI freshness contract」段；`docs/events/event_2026-04-21_*.md`（實作啟動時開）。
- **相關 plan**：
  - 獨立：`gateway-sse-heartbeat`（改 `daemon/opencode-gateway.c` 送 `:\n\n` keepalive + `retry:` field）
  - 獨立：`daemon-session-status-heartbeat`（server 定期 re-emit session.status event）
  - 獨立：`client-server-version-handshake`（I-9）
  - 獨立：`test-xdg-isolation`（I-7）
- **相關 memory**：
  - `event_2026-04-20_frontend_oom_rca.md` I-4（RCA 依據）
  - `feedback_repo_independent_design.md`（threshold 走 tweaks.cfg）
  - `feedback_no_silent_fallback.md`（receivedAt 缺失要 explicit）
  - `feedback_tweaks_cfg.md`（新 key 規範）
