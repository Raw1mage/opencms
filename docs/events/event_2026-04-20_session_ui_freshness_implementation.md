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
