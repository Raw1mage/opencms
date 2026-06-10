# BR: task() dispatch-first 契約被打破 — worker 在 dispatch 返回前猝死時回了同步「completed successfully」

- **Date**: 2026-06-11
- **Severity**: Medium（誤導 orchestrator 的回合語氣；與 content-filter false-success 同源症候，但獨立於 status 映射）
- **Status**: Open — 待定位（症狀已知，回覆分支來源未確認）
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

## 待定位（誠實標註）

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
