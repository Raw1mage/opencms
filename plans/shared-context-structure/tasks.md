# Tasks: Shared Context Structure

## Phase 1: Shared Context Space — 核心結構與增量更新

- [ ] 1.1 建立 `packages/opencode/src/session/shared-context.ts`
  - [ ] 1.1.1 定義 Space / FileEntry / ActionEntry 資料模型
  - [ ] 1.1.2 實作 Storage 層 CRUD（get / save / delete，key = `["shared_context", sessionID]`）
  - [ ] 1.1.3 實作 `processToolPart()` — per-tool 分支處理 (read/grep/glob/edit/write/bash/task/...)
  - [ ] 1.1.4 實作 `updateFromAssistantText()` — 啟發式萃取 goal / discoveries / currentState
  - [ ] 1.1.5 實作 `deduplicateFiles()` — 同 path 合併，operation 升級
  - [ ] 1.1.6 實作 `consolidate()` — budget 超出時壓縮舊條目
  - [ ] 1.1.7 實作 `updateFromTurn()` — 組合上述步驟的入口函式
  - [ ] 1.1.8 實作 `snapshot()` + `formatSnapshot()` — 產生 `<shared_context>` 文字快照
- [ ] 1.2 修改 `packages/opencode/src/session/prompt.ts`
  - [ ] 1.2.1 在 assistant turn 完成後呼叫 `SharedContext.updateFromTurn()`
  - [ ] 1.2.2 guard：只對 main session（`!session.parentID`）觸發
  - [ ] 1.2.3 guard：`config.compaction?.sharedContext !== false`
- [ ] 1.3 Config
  - [ ] 1.3.1 在 compaction config schema 新增 `sharedContext` (boolean, default true)
  - [ ] 1.3.2 新增 `sharedContextBudget` (number, default 8192)
  - [ ] 1.3.3 新增 `opportunisticThreshold` (number 0-1, default 0.6)

## Phase 2: Subagent 注入 + Idle Compaction（turn 邊界同步）

- [ ] 2.1 修改 `packages/opencode/src/tool/task.ts` — 只做注入（同步）
  - [ ] 2.1.1 在 `Session.create()` 後呼叫 `SharedContext.snapshot(ctx.sessionID)`
  - [ ] 2.1.2 snapshot 非空時，建立 synthetic user message 注入 snapshot + task prompt
  - [ ] 2.1.3 跳過注入若 `params.session_id` 已指定（continuation case）
  - [ ] 2.1.4 task.ts 不做任何 compaction 邏輯
- [ ] 2.2 修改 `packages/opencode/src/session/prompt.ts` — turn 邊界 idle compaction
  - [ ] 2.2.1 在 `updateFromTurn()` 之後，偵測本 turn 是否包含已完成的 task tool call
  - [ ] 2.2.2 若偵測到 task dispatch，呼叫 `SessionCompaction.idleCompaction()`（同步）
- [ ] 2.3 新增 `idleCompaction()` 到 `packages/opencode/src/session/compaction.ts`
  - [ ] 2.3.1 讀取 threshold（`opportunisticThreshold`，default 0.6），threshold >= 1.0 時直接 return
  - [ ] 2.3.2 inspectBudget → 計算 utilization
  - [ ] 2.3.3 utilization < threshold → debugCheckpoint 跳過，return
  - [ ] 2.3.4 utilization ≥ threshold → SharedContext.snapshot() → compactWithSharedContext()
- [ ] 2.4 新增 `compactWithSharedContext()` 到 `packages/opencode/src/session/compaction.ts`
  - [ ] 2.4.1 建立 summary message（mode: compaction, summary: true）
  - [ ] 2.4.2 snapshot 作為 summary content
  - [ ] 2.4.3 auto 模式下建立 continue message
  - [ ] 2.4.4 publish Event.Compacted
- [ ] 2.5 Telemetry
  - [ ] 2.5.1 在 `TaskWorkerEvent.Assigned` 增加 sharedContextInjected / tokens / version
  - [ ] 2.5.2 debugCheckpoint 記錄 idle compaction 結果（skipped/completed）

## Phase 3: Overflow Compaction 整合

- [ ] 3.1 修改 `compaction.ts` 的 `process()`
  - [ ] 3.1.1 在 compaction agent 呼叫前，嘗試 `SharedContext.snapshot()`
  - [ ] 3.1.2 snapshot 非空 → 呼叫 `compactWithSharedContext()`，跳過 LLM call
  - [ ] 3.1.3 snapshot 為空 → fallback 到現有 compaction agent 邏輯（不修改）
  - [ ] 3.1.4 log/debugCheckpoint 記錄路徑選擇
- [ ] 3.2 確認 `prompt.ts` 中 overflow compaction 觸發路徑正確

## Validation

- [ ] V1 手動驗證：main session 多次 tool call 後，`SharedContext.get()` 回傳正確結構
- [ ] V2 手動驗證：dispatch subagent 時，subagent 首條 message 包含 shared context snapshot
- [ ] V3 手動驗證：task dispatch turn 完成後 utilization < 60% → idle compaction 跳過（debugCheckpoint 確認）
- [ ] V4 手動驗證：task dispatch turn 完成後 utilization ≥ 60% → idle compaction 在 turn 邊界同步執行
- [ ] V5 手動驗證：overflow compaction 觸發時使用 shared context 作為 summary
- [ ] V6 確認 `config.compaction.sharedContext = false` 完全停用，回退現有行為
- [ ] V7 確認 shared context 為空時（新 session 首次 turn）不影響任何現有流程
- [ ] V8 確認 `session_id` continuation 不重複注入 shared context
- [ ] V9 確認 shared context budget 生效：超出時 consolidate 正確壓縮
- [ ] V10 確認 `opportunisticThreshold = 1.0` 停用 idle compaction
- [ ] V11 確認 idle compaction 不影響 turn 邊界後的正常流程
- [ ] V12 telemetry 事件包含 shared context 指標
