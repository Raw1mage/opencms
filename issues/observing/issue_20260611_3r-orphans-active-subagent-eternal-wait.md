# BR: 3R 重啟時若 subagent 仍在活動，parent session 永久等待且無「子代理已死」知覺

- **Date**: 2026-06-11
- **Severity**: High（會讓 main agent 卡死在無限等待，需人工介入）
- **Status**: OBSERVING — 2026-06-11 3R 即時驗證通過：派長跑子代理（sleep 300）→ 3R 殺 daemon → 重啟後 parent **未**永久等待——`PendingSubagentNotice appended`（debug.log seq 25277）+ `auto-resume: parent runloop enqueued`（seq 25291）+ registry 清空。本次子代理在新 daemon 下被續跑並留下 terminal finish=stop，故依死亡窗校正照實回報 `status=success`（inline result 明述 sleep 被 3R 攔腰打斷）；`worker_dead` 分支（子代理死前無 terminal finish）本輪未觸發，留 soak 觀察。Exit → closed/: 後續 3R 均無 parent eternal-wait，且任一次真實 worker_dead 案例正確回報。
- **Area**: subagent lifecycle / restart orchestration / PendingSubagentNotice pipeline

---

## 摘要

當使用者觸發 3R（rebuild + reinstall + restart，走 `restart_self` → `/api/v2/global/web/restart`）時，**若當下有 subagent（task worker）正在活動**，daemon 會 self-terminate、gateway 重新 spawn 一個全新 daemon。被殺掉的舊 daemon 內部負責「偵測子代理結束 → 投遞 `PendingSubagentNotice` 給 parent」的那條 detached 背景流程也隨之死亡。重啟後**沒有任何機制 reconcile 這個孤兒狀態**，於是：

- 子代理進程已死（被舊 daemon 一起帶走，或變成孤兒被 reap）。
- Parent session 仍停在「等待子代理回報」的期待態。
- 因為 notice 永遠不會被 append，parent 的 continuation 永遠等不到完成事件 → **永遠的執行等待，且毫無「子代理已死」的知覺**。

---

## 復現步驟

1. Main agent 透過 `task()` dispatch 一個 subagent，subagent 進入執行（`SessionActiveChild` 被 set）。
2. 在 subagent 還在跑時，觸發 3R（`restart_self`，或使用者要求重啟讓 code 變更生效）。
3. Daemon self-terminate、gateway respawn 新 daemon。
4. 觀察 parent session：UI 仍顯示子代理 busy / parent 仍在等待，但子代理進程實際已不存在。
5. 永遠不會收到 `PendingSubagentNotice`（success / worker_dead / silent_kill 都不會來）。Parent 卡死。

---

## Root cause 分析（system-first / boundary-first）

### 邊界 1：`SessionActiveChild` 狀態是 in-memory，重啟即蒸發

`packages/opencode/src/tool/task.ts:460-499`

```ts
function createActiveChildState() {
  const data: Record<string, SessionActiveChildState | undefined> = {}
  return data
}
// activeChildState() 走 Instance.state(...) 或 module-level fallback
export namespace SessionActiveChild {
  export function set(parentSessionID, activeChild) {
    if (activeChild === null) delete activeChildState()[parentSessionID]
    else activeChildState()[parentSessionID] = activeChild
    await Bus.publish(SessionActiveChildEvent, { parentSessionID, activeChild })
  }
}
```

此狀態純記憶體（`Instance.state` / module fallback），不落盤。daemon 一死整份消失；新 daemon 起來時是空的，**不知道曾有 parent 在等子代理**。

### 邊界 2：投遞 notice 的 watchdog + completion pipeline 跑在 daemon 行程內，被一起殺掉

`packages/opencode/src/tool/task.ts:2148-2340`

- `task()` 採 **STUB-RETURN FLIP（R1）**：tool 立即回 `dispatched` stub，真正等待子代理結束的邏輯被 detach 成一個 background promise（`void (async () => { ... })()`，2293 起）。
- 該背景流程 `Promise.race([run.done, watchdogCompletion])`，結束後才會經由
  `disk-terminal → task.completed → pending-notice-appender → system-prompt addendum`（2289-2291 註解所述）把 `PendingSubagentNotice` 投到 parent。
- 這整條 detached promise、`watchdogTimer`（`setInterval`）、worker 進程全都活在**舊 daemon 行程**裡。3R 殺掉舊 daemon = 殺掉這整條投遞鏈。**沒有任何一端會在重啟後重新觸發投遞。**

### 邊界 3：重啟後的 orphan recovery 不涵蓋 active-child 期待

`packages/opencode/src/tool/task.ts:441-457`（orphan recovery scan）只處理 task worker registry（`registryPath()`）的孤兒回收，掃完即 `unlink(registryPath())`。它**不會**為「parent 仍在等子代理、但 notice 永遠不會來」這種情況補投一個 terminal notice（例如合成一筆 `worker_dead` / `silent_kill`）。`SessionActiveChild` 在新行程是空的，也沒有 reconcile 來源。

### 結論

3R 在「subagent 活動中」這個時間窗，會切斷唯一一條把子代理終局狀態回報給 parent 的路徑，且重啟後缺少 reconcile。Parent 因此停在期待態無限等待——這正是「毫無已死的知覺」的成因：notice pipeline 是 parent 唯一的死亡感知通道，而它被連根帶走了。

---

## 觀測證據需求（修復前須補的 checkpoint）

- [ ] 重啟前 dump `SessionActiveChild.list()`，確認有 active entry。
- [ ] 重啟後新 daemon boot 時 log `SessionActiveChild.list()`（預期為空）。
- [ ] 確認 parent session 的 `info.json#pendingSubagentNotices` 在重啟後是否仍缺對應 notice。
- [ ] 確認舊 worker 進程在 daemon 死後的去向（被 reap / 變孤兒）。

---

## 建議修復方向（待設計，勿直接實作）

> 遵守天條：不得新增 silent fallback；以下偏向「顯式 reconcile + 投遞 terminal notice」。

1. **持久化 active-child 期待**：把 `SessionActiveChild` 的關鍵欄位（parentSessionID、childSessionID、toolCallID、dispatchedAt）落盤（類似 task worker registry），讓重啟後可被掃描。
2. **重啟 boot-time reconcile**：新 daemon 啟動時，對每個持久化的 active-child 期待檢查子 session 是否已有 terminal finish；
   - 若子 session 有 terminal finish → 補投對應 `PendingSubagentNotice`（success/error）。
   - 若子進程已不存在且子 session 無 terminal finish → 合成 `worker_dead`（或新 status，如 `daemon_restarted`）投給 parent，讓 parent 明確得知「子代理在重啟中夭折」。
3. **restart 前主動結算**：`/web/restart` 在 self-terminate 前，對所有 active child 主動投遞一筆 terminal notice（fail-fast、顯式），而不是讓它們靜默消失。
4. （可選）新增 `PendingSubagentNotice.status = "daemon_restarted"`，讓 orchestrator 能分辨「因 3R 而死」與一般 crash，並據此決定是否 redispatch。

---

## 相關程式碼錨點

- `packages/opencode/src/tool/task.ts:460-499` — `SessionActiveChild` in-memory state
- `packages/opencode/src/tool/task.ts:441-457` — orphan recovery（不涵蓋 active-child）
- `packages/opencode/src/tool/task.ts:2148-2340` — proc-watchdog + detached completion（STUB-RETURN FLIP R1）
- `packages/opencode/src/bus/subscribers/pending-notice-appender.ts` — 投遞 notice 到 parent info.json
- `packages/opencode/src/session/prompt.ts:118` — `renderNoticeAddendum`（system-prompt addendum）
- `packages/opencode/src/server/routes/global.ts:517-630` — `/web/restart`（self-terminate 路徑）
- `packages/mcp/system-manager/src/index.ts:1978-2050` — `restart_self` shim

---

## 修復（2026-06-11）

**採用方向 2（boot-time reconcile）+ 復用既有 pipeline，未新增子系統。**

關鍵理解：在 **R1 STUB-RETURN FLIP** 之下，parent 的 tool part 在 dispatch 當下就已被
寫成 `completed`（dispatched stub），所以原本的 `recoverOrphanTasks()`（只處理仍為
`running` 的 part）對活動中的 subagent **形同空轉**——它唯一做的是清掉 registry。Parent
真正的續行訊號是 `TaskCompletedEvent → pending-notice-appender → 投遞 notice + auto-resume`
這條鏈，而它整條活在舊 daemon 裡、隨 3R 一起死，**重啟後沒有任何一端會重新觸發**。

**修法**：`running-tasks.json` registry 本來就持久化了 reconcile 所需的全部欄位
（parentSessionID / childSessionID / parentMessageID / toolCallID / registeredAt），
因此**不需**另外落盤 `SessionActiveChild`。讓 `recoverOrphanTasks()` 在重啟時，對每個
orphan **重新 publish `TaskCompletedEvent`**，由既有的 `pending-notice-appender`
同時完成「append `PendingSubagentNotice` 到 parent info.json」+「auto-resume parent
runloop」。Parent 因此明確收到 `[subagent … finished status=worker_dead …]` 並續行。

死亡窗校正：reconcile 前先讀子 session 的 disk truth（最後一則 assistant 的 `finish`）。
若子代理在舊 daemon 死前其實已寫入 terminal finish → 照實回報 success/error/…（連 success
的最近 assistant 文字一併以 inline result 帶回）；否則（無 terminal finish＝被攔腰打斷）
→ `worker_dead` / finish `worker_exited`。冪等：notice 以 `jobId=toolCallID` latest-wins；
若 crash 前 notice 已投遞，該 registry entry 早已被 `registryRemove` 移除，不會重投。

未採新 `daemon_restarted` status（BR 列為「可選」）：復用既有 `worker_dead` 即可讓 parent
「得知子代理已死 + 解除無限等待」，零 schema/SDK 變更，符合 MVC／大道至簡。

### 變更檔案

- `packages/opencode/src/tool/task.ts`
  - 新增純函式 `classifyOrphanFinish(childFinish)` — disk `finish` → {status, finish} 分類。
  - `recoverOrphanTasks()`：不再 gate 在 `part.state.status === "running"`；改為對每個 orphan
    讀子 session disk truth → 標記 part（legacy 路徑仍保留，純 UI 美觀）→ **publish
    `TaskCompletedEvent`** 走 canonical 投遞鏈。
- `packages/opencode/src/tool/task-orphan-classify.test.ts` — `classifyOrphanFinish` 單元測試
  （interrupted→worker_dead；死亡窗 stop/error/length/canceled/rate_limited/quota_low 正確保留）。

### 驗證

- [x] typecheck（packages/opencode）綠燈。
- [x] unit：`task-orphan-classify.test.ts` 3 pass / 10 expect。
- [ ] **部署驗證（待使用者 3R）**：依「觀測證據需求」逐項——重啟前 dump `SessionActiveChild.list()`
      有 active entry；重啟後新 daemon log `orphan reconciled via task.completed notice`；
      parent info.json#pendingSubagentNotices 出現對應 `worker_dead` notice；parent runloop
      auto-resume 並於下一輪 system-prompt 看到 `[subagent … finished status=worker_dead …]`。
      此項通過後本 issue 轉 `observing/`。
