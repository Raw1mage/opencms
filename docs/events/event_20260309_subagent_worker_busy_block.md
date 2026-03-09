# Event: Subagent worker_busy blocking fix

Date: 2026-03-09
Status: In Progress

## 需求

- 修復呼叫 subagent 時被 `worker_busy` 阻斷的問題。
- 釐清目前 task/subagent dispatch 在 cms 的阻塞來源與正確容錯策略。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/**`
- 必要時 `/home/pkcs12/projects/opencode/packages/app/**`
- 對應 event / architecture sync 記錄

### OUT

- 不做與 subagent dispatch 無關的 workspace/product feature 擴充
- 不修改未經證據支持的 worker lifecycle 設計

## 任務清單

- [x] 找到 `worker_busy` 來源與觸發條件
- [x] 評估是否屬於 worker pool / task dispatch / UI handling 問題
- [x] 實作最小安全修復
- [x] 驗證 subagent 呼叫不再被同類阻斷

## Debug Checkpoints

### Baseline

- 主代理呼叫 subagent 時遭遇 `worker_busy` 阻斷。

### Execution

- 定位到 `packages/opencode/src/cli/cmd/session.ts` 的 worker 子程序本身是單工設計：若同一 worker 在 `activeRun` 尚未結束時再收到第二個 `run`，就會主動回傳 `error: "worker_busy"`。
- 問題不在子程序，而在 `packages/opencode/src/tool/task.ts` 的父層 dispatch：
  - `getReadyWorker()` 只挑選 `!busy` worker
  - 但 `dispatchToWorker()` 是在 `await getReadyWorker()` 之後才把 `worker.busy = true`
  - 因此若兩個 subagent dispatch 併發進來，可能同時拿到同一個 idle worker，形成 double-dispatch race，最後由子程序回報 `worker_busy`
- 修正方式：
  - 在 `task.ts` 引入 `Lock.write(...)`
  - 新增 `assignWorker(...)`，把「選 worker + 檢查 abort + 標記 busy」收斂到同一個 critical section
  - `dispatchToWorker()` 改為透過 `assignWorker(...)` 取 worker，避免同一個 idle worker 被兩個併發 dispatch 同時拿走
  - 另補上 early-failure release：若 worker 已被保留但在真正寫入 `run` 前就失敗/abort，會釋放 `busy` 並補回 standby

### Validation

- `bun run --cwd packages/opencode typecheck` ✅
- `bun test --cwd packages/opencode test/util/lock.test.ts test/process/supervisor.test.ts` ✅
- Architecture Sync: Verified (No doc changes)
  - 本次修正僅是 subagent worker assignment race 的並發保護，未改變 task/subagent/runtime 的 architecture boundary。
