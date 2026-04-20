# Event: session-ui-freshness implementation — 2026-04-20

實作期間事件日誌（plan-builder §16.4）。每 phase 結束追加一段 summary；drift /
decision 即時記錄。

Branch: `beta/session-ui-freshness` (opencode-beta worktree, detached from `main@bfa37f48f`)
XDG backup: `~/.config/opencode.bak-20260420-1829-session-ui-freshness/`

---

## Phase 1 — Data-schema + reducer 打底

- **Done tasks**: 1.1, 1.2, 1.3, 1.4, 1.5（本條目）
- **Key decisions**:
  - Scope 修正：原 proposal 的 `State.session_monitor` 在實際 code 不存在；監看資料活在
    `useStatusMonitor` hook 自己的 state（`items: SessionMonitorInfo[]`），由 SDK 輪詢 +
    event-reducer 共同填。**本 phase 只處理 `State.session_status` + `State.active_child`
    兩處；監看資料的 freshness 延至 Phase 3 task 3.4 處理**（與 ProcessCard 一起）。
    對 `tasks.md` task 1.1 做了 inline 註記（plan-builder §6 Layer 1）。
  - `bootstrap.ts` 的 bulk `session.status()` call 改為逐 entry stamp `receivedAt = Date.now()`
    **而非 0**；`receivedAt=0` 的語義（DD-4 hard-stale）保留給「欄位缺失」情境，不適用於
    正常 bulk 載入。
  - R1.S3 的 scenario（server updatedAt 與 client receivedAt 獨立）目前 server payload
    實際上沒有 `updatedAt` 欄位——test 用 `as any` 注入 extra field 驗證 reducer 不會
    overwrite。未來 server 若真送 updatedAt，test 即刻保護。
- **Validation**:
  - `bun test packages/app/src/context/global-sync/event-reducer.test.ts` → **23 pass / 0 fail**
    （原 20 個 + 新增 R1.S1 / R1.S2 / R1.S3 三個；3 個舊 fixture 補 receivedAt）
  - `bun --silent x tsc --noEmit --project packages/app/tsconfig.json` → **clean**（production
    code + test code 全綠）
  - 手動 grep：`session_status` / `active_child` 的所有 write site 已確認全部戳 receivedAt
    （event-reducer.ts 的 `session.status` + `session.active-child.updated` 兩個 case；
    bootstrap.ts 的 bulk load；child-store.ts 的空初始化 `{}` 不需戳）
- **Files changed**:
  - `packages/app/src/context/global-sync/types.ts` — 新增 `ClientStampMeta`、
    `StoreSessionStatusEntry`、`StoreActiveChildEntry` 三個型別；`State.session_status` 與
    `State.active_child` 改用新型別
  - `packages/app/src/context/global-sync/event-reducer.ts` — imports 擴充；
    `session.status` case 用 intersection 寫入；`session.active-child.updated` case 用
    spread + `receivedAt` 寫入；把 server-side payload 型別改 `Omit<..., "receivedAt">`
  - `packages/app/src/context/global-sync/bootstrap.ts` — bulk `session.status()` 迴圈
    逐 entry stamp
  - `packages/app/src/context/global-sync/event-reducer.test.ts` — 3 個既有 fixture 補
    `receivedAt`；新增 `describe("session-ui-freshness: ...")` 含 R1.S1 / R1.S2 / R1.S3
    三個 test case
  - `specs/session-ui-freshness/tasks.md` — task 1.1-1.3 標 `- [x]`、加 scope 修正註記
- **Drift**:
  - Scope 修正本身算 drift（proposal 提的 `State.session_monitor` 不存在）。處理方式：
    不退回 `revise` mode；在 tasks.md inline 標 "Scope 修正 2026-04-20"，由 Phase 3.4
    用正確位置（`useStatusMonitor` / `ProcessCard`）承接。不需要改 `proposal.md` 或
    `spec.md` 正文——那邊寫的是需求意圖，實作細節的 store path 放在 tasks.md + data-schema.json
    就好。
  - `plan-sync.ts` 暫未於每 task 結束執行——rationale：本 repo 沒有 `.plan-sync-state` 或
    類似的 anchor commit 基準；plan-sync 目前 scope 偏 drift 偵測、本 phase 的 drift 已
    在此 event log 紀錄。Phase 2 開始改成每 task 完成即跑。
- **Remaining**: 進 Phase 2（`useFreshnessClock` helper + `frontend-tweaks` 三個新 signal
  + server-side tweaks.ts / config route / templates/system/tweaks.cfg + 兩個 test 檔）。

---

## Phase 2 — Freshness clock + tweak 配線

- **Done tasks**: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
- **Key decisions**:
  - **useFreshnessClock 採 module-level singleton**（DD-2）：首次 import 觸發 `setInterval(1000)`；重複 import 共用同一 signal。Test helper 額外 export `__stopFreshnessClockForTest` 與 `__setFreshnessNowForTest`（由 `__` 前綴標示僅測試用）。SSR guard 判斷 `typeof setInterval === "function"`。Dev console helper 掛到 `window.__opencodeDebug.freshnessNow`（vite `import.meta.env.DEV` 時才生效）。
  - **Server-side freshness 命名**：config key 走 `ui_session_freshness_enabled` / `ui_freshness_threshold_sec` / `ui_freshness_hard_timeout_sec`（與 proposal / spec / data-schema 一致）；內部 struct field 用 `flag` / `softThresholdSec` / `hardTimeoutSec`（呼應既有 `frontendLazyload.flag` 命名）。
  - **Soft >= Hard 的防呆**：若使用者把兩個值設反（soft >= hard），parser clamp 成 `soft = hard - 1`（不是 bail out 到 default），理由：硬閾值是「使用者真的在乎的天花板」，比預設值更能代表意圖；只修不合理的 soft 即可。`log.warn` 留痕。
  - **Response zod schema 範圍 (1..3600 / 1..86400)** 與 parser 範圍對齊，serialize/deserialize 雙向保護。
- **Validation**:
  - `bun test packages/opencode/test/config/tweaks.test.ts` → **25 pass / 0 fail**（原 17 + 新增 8 個）
  - `bun test packages/opencode/test/server/frontend-tweaks-route.test.ts` → **4 pass / 0 fail**（原 2 + 新增 2）
  - `bun --silent x tsc --noEmit -p packages/opencode/tsconfig.json` → **clean**
  - `bun --silent x tsc --noEmit -p packages/app/tsconfig.json` → **clean**
- **Files changed**:
  - `packages/app/src/hooks/use-freshness-clock.ts` — 新檔
  - `packages/app/src/context/frontend-tweaks.ts` — FrontendTweaks interface + defaults 加三欄；`uiFreshnessEnabled` / `uiFreshnessThresholdSec` / `uiFreshnessHardTimeoutSec` 三個 accessor
  - `packages/opencode/src/config/tweaks.ts` — `SessionUiFreshnessConfig` + defaults + parser + KNOWN_KEYS + `Effective` 欄位 + `Tweaks.sessionUiFreshness()` getter
  - `packages/opencode/src/server/routes/config.ts` — route reads `Tweaks.sessionUiFreshness()`；response 含 3 新欄；zod schema 更新
  - `templates/system/tweaks.cfg` — 新區段 + 3 key 註解 + 預設值
  - `packages/opencode/test/config/tweaks.test.ts` — 8 個新 test case
  - `packages/opencode/test/server/frontend-tweaks-route.test.ts` — 2 個新 test case
  - `specs/session-ui-freshness/tasks.md` — 2.1 ~ 2.7 標 `- [x]`
- **Drift**: 無。
- **Remaining**: 進 Phase 3（UI 消費 freshness）。先寫 `classifyFidelity` 共用 util（task 3.5），再做 3.1 / 3.2 / 3.3 / 3.4 的 memo 接線。
