# BR: task() dispatch-first 契約被打破 — worker 在 dispatch 返回前猝死時回了同步「completed successfully」

- **Date**: 2026-06-11
- **Severity**: Medium（誤導 orchestrator 的回合語氣；與 content-filter false-success 同源症候，但獨立於 status 映射）
- **Status**: Fixed (uncommitted) — 2026-06-11 修復落地，待 commit；見文末「Resolution」
- **Area**: task tool dispatch path / STUB-RETURN FLIP (R1) / worker 生命週期
- **拆出自**: `issues/subagent-content-filter-false-success.md` 的 Bug 2（主檔 Bug 1=content_filter status 已修，commit `3e2263bec`）

---

## 摘要

`task()` 採 **STUB-RETURN FLIP（R1）**：正常路徑下，tool 立即回一段
`Subagent <id> dispatched (jobId=…). Running in background.` 的 stub
（`packages/opencode/src/tool/task.ts:2670` 一帶），真正等待子代理結束的邏輯被 detach 成背景 promise。

但在 content-filter BR 的來源 session（parent `ses_14ceb2fceffehTP6rE3wuUb65y`）觀察到：**第二次 dispatch
的 tool result 直接回傳同步完成語氣的字串**（近似 `Subagent ses_14c650a03ffe… completed successfully.`），
而非標準的 `dispatched (jobId=…) Running in background`。高機率成因：worker 在 dispatch 返回前就已死亡
（content-filter 幾秒內擊殺），dispatch 路徑撞上「已終結 / 已 resolve」的 worker/run 狀態時，走了**錯誤的回覆分支**，
把它當成同步完成回報。

影響：orchestrator 收到「completed successfully」語氣，會誤以為子代理已正常交付（與 Bug 1 的 false-success
不同層：Bug 1 是 status 枚舉 fall-through；本 Bug 是 dispatch 路徑根本沒回 stub）。

---

## 復現

1. 對 coding subagent dispatch 一份會在數秒內被 provider content filter 擊殺的 prompt
   （content-filter BR 的 prompt 可直接重放）。
2. 連續第二次 dispatch（worker 復用、且子代理近乎即時死亡）。
3. 觀察 `task()` tool result：預期 `dispatched (jobId=…)`，實際出現同步「completed successfully」語氣。

---

## 定位結果（2026-06-11 驗證）

**Bug 確認真實存在。** 「completed successfully」字串的真正產生點與汙染路徑：

1. **字串產生點**：`packages/opencode/src/bus/subscribers/task-worker-continuation.ts:95`
   — `enqueueParentContinuation` 在 `input.ok === true` 時，把 task tool part 的 state 改寫為
   `{ status: "completed", output: "Subagent <id> completed successfully." }`，並以
   `Session.updatePart` **覆寫磁碟上的 tool part**（原註解自稱「UI-only subscriber」，但它改的是
   持久化 message part，不只 UI）。
2. **觸發鏈**：worker 端 `packages/opencode/src/cli/cmd/session.ts:285` 在 `SessionPrompt.loop`
   正常返回時一律送 `{type:"done", ok:true}` —— **content-filter 擊殺也算正常返回**（loop 不 throw），
   所以 ok=true → host 端 `task.ts:1147` 發 `TaskWorkerEvent.Done` → subscriber 覆寫 output。
3. **汙染回 LLM 的路徑**：`packages/opencode/src/session/message-v2.ts:1107` 重放 transcript 時取
   `part.state.output` 作為 tool result 文本。dispatch stub（`task.ts:2670`）雖然在當輪正確回傳，
   但 stub 寫進 part 後**隨即被 subscriber 覆寫**；子代理在數秒內死亡時，覆寫往往趕在 parent
   下一輪 prompt 組裝之前完成，於是 LLM 在重放中看到的 tool result 是
   「Subagent … completed successfully.」而非 dispatch stub。
4. **與 Bug 1 的正交性確認**：Bug 1 修的是 `task.ts:2619` 的 `content_filter` status 映射
   （pending-notice 通道）；本 Bug 在 `TaskWorkerEvent.Done` 通道，**完全不經過** resolvedStatus
   判定 —— worker ok=true 一律寫「completed successfully」，content-filter 子代理同樣中招。

修正方向（更新）：

- `task-worker-continuation.ts` 不應覆寫 tool part 的 `output` 文本——R1 之後 tool result 的
  唯一語義是「dispatched stub」；終局結果只能走 `task.completed → pending-notice` 通道。
  覆寫如需保留（sidebar 清狀態），只改 `status`/`time`，output 保留原 stub 文本。
- 或者：在覆寫時尊重 `metadata.dispatched === true`，dispatched part 永不改寫 output。

## 原始待定位記錄（保留，已被上節取代）

- **`"completed successfully"` 這個字面字串不在 `packages/opencode/src/tool/task.ts` 的主回傳路徑**
  （grep 無命中；唯一的 tool return 是 2670 的 dispatch stub）。代表這段同步完成語氣**來自別層**——
  可能是 worker `run.done` 在 dispatch 返回前就 resolve 後、由某個 result 格式化層（system-manager MCP
  task wrapper / 子代理結果回填）所產生，或是 worker 復用時撞上前一個已完成 run 的殘留結果。
- 因此「dispatch 撞上已終結 session 走錯分支」目前是**假設**，需先把那段「completed successfully」字串的
  真正產生點找出來，再判定是 task.ts 內的早返路徑、worker pool 復用競態、還是上層 wrapper。

---

## 相關程式碼錨點（起點）

- `packages/opencode/src/tool/task.ts:2670` — 正常 dispatch stub return（R1）。
- `packages/opencode/src/tool/task.ts:2295` 起 — detached 背景完成 promise（`run.done` vs watchdog race）。
- `packages/opencode/src/tool/task.ts:1391-1414` — `dispatchToWorker` 內 `worker.current` 綁定 + registryAdd；
  worker 復用 / `run.done` 提前 resolve 的競態窗在此一帶。
- `packages/opencode/src/tool/task.ts:741-746` — `CancelByJobIdResult` / `already_terminal`（worker.busy=false
  即視為已終結；同一「已終結」判定可能也影響 dispatch 回覆分支）。
- system-manager MCP task wrapper（`packages/mcp/system-manager/src/index.ts`）— 若同步完成語氣來自上層格式化，起點在此。

---

## 建議方向（待設計）

1. 先 grep 全 repo 定位 `completed successfully` 語氣字串的真正產生點（task.ts 外）。
2. 確認 worker 在 dispatch 返回前死亡時，`run.done` 是否提前 resolve、且其結果被當成同步完成回填。
3. 修正後 dispatch 路徑**恆定回 stub**（dispatched）——子代理終局一律走 `task.completed → pending-notice`
   單一通道（與 3R 孤兒、content-filter 同一條收斂路徑），不得有第二條同步完成回覆分支。

---

## Resolution（2026-06-11）

**修復內容**（`packages/opencode/src/bus/subscribers/task-worker-continuation.ts`）：

1. **Terminal guard**：`enqueueParentContinuation` 在覆寫 tool part 前檢查
   `taskPart.state.status ∈ {completed, error}`（即 R1 stub 已落盤的 terminal part）——
   若已 terminal，**跳過 `Session.updatePart`**，保留 dispatch stub 原文；只記
   `[DISPATCH_FIRST_GUARD]` log。sidebar/process 清理（`SessionActiveChild.set(null)` +
   `ProcessSupervisor.kill`）不受影響，照常執行。
2. **語氣修正**：對仍處 `running` 的 part（pre-R1 殘留路徑），ok=true 的覆寫文本從
   `completed successfully` 改為 `finished. The outcome is delivered separately as a
   pending-notice; do not treat this line as a result.` —— worker ok=true 只代表 loop 返回
   （含 content-filter 擊殺），不代表成功交付。

**回歸測試**（`task-worker-continuation.test.ts`）：新增
`never rewrites a terminal dispatched-stub part's output` —— 模擬 Phase 9 stub 已落盤 →
發 `TaskWorkerEvent.Done`（ok=true）→ 斷言 part output 與 stub 逐字節相同、
不含 `completed successfully`，且 supervisor/activeChild 仍正確清理。**綠**。

**驗證**：
- 套件結果 **3 tests / 3 pass / 0 fail**。
- 原 pre-existing fail（`enqueues parent continuation … on success`）已一併收掉：
  該測試斷言的是 **demotion 前的舊架構**（subscriber 自行 enqueue continuation +
  reconcile todo）。subscriber 早已降級為 UI-only（見原始碼「Demoted to UI-only
  subscriber」註記）——continuation 與 todo reconcile 改由 task tool caller 負責
  （`task.ts` reconcileProgress + done-promise 通道）。測試已改名並改斷言為：
  成功路徑清 supervisor/activeChild，但 **不** enqueue continuation、**不**動 todo。
- Architecture Sync: Verified (No doc changes) —— 修復僅收斂既有 subscriber 的覆寫行為，
  無模組邊界 / 資料流變更；終局結果通道維持 `task.completed → pending-notice` 單一路徑
  （與 specs/architecture.md 既載設計一致）。

**未動範圍**：commit 由使用者決定（修復目前 uncommitted）。
