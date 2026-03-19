# Tasks

> Re-implementation on message-bus-v2 branch (based on clean cms HEAD 3ddde82e82).
> Previous message-bus branch discarded due to incorrect base commits.

## 1. Fix Directory Routing Drop (Phase 1)

- [x] 1.1 修改 `global-sync.tsx` event listener：directory routing 改為 broadcast-first with fallback
- [~] 1.2 移除 `global-sync.tsx` 中的 toast message 解析 hack — 保留，作為 rotation history 的第二來源，直到 rotation.executed 事件確認穩定到達前端
- [x] 1.3 驗證 `rotation.executed` 事件通過 broadcast 到達 `event-reducer.ts` 的 case handler
- [x] 1.4 驗證 `ratelimit.detected` / `ratelimit.cleared` / `llm.error` 也能正確到達 — 使用者確認 error message 透過 toaster 顯示
- [x] 1.5 驗證 session.created / message.updated 等事件不 regress — build + deploy 後功能正常
- [x] 1.6 Build + deploy + 實機測試 LLM 狀態 card 顯示 rotation chain

## 2. Subscriber Infrastructure (Phase 2)

- [x] 2.1 擴展 `Bus.publish()` 支持 topic-level subscriber dispatch（globalSubscriptions）
- [x] 2.2 新建 `packages/opencode/src/bus/subscribers/` 目錄
- [x] 2.3 實作 `debug-writer.ts`：訂閱事件 + OPENCODE_DEBUG_LOG env gate + 寫 debug.log
- [~] 2.4 實作 `tui-toaster.ts` — 功能由 SDK event listener 實現（TUI app.tsx + global-sync.tsx），未抽為獨立 subscriber 檔案
- [x] 2.5 GlobalBus 改為 Bus 的 SSE transport adapter（Bus.publish 內部呼叫 GlobalBus.emit）
- [x] 2.6 前端 event-reducer 已有 rotation/ratelimit/llm.error handler（cms 基礎已有）
- [x] 2.7 前端 LLM card 已有 llm_history store + LlmHistoryEntry 型別（cms 基礎已有）
- [x] 2.8 實作 `OPENCODE_LOG_LEVEL` env 讀取（bus/log-level.ts）
- [x] 2.9 debug-writer 使用 `Bus.subscribeGlobal("*", 1, ...)` logLevel gate
- [x] 2.10 向下相容：`OPENCODE_DEBUG_LOG=1` 映射為 `LOG_LEVEL=1`
- [ ] 2.11 驗證 logLevel=0 時所有 subscriber skip
- [ ] 2.12 驗證無 subscriber 變更的事件行為不變（regression check）

## 3. debugCheckpoint Integration (Phase 3)

- [~] 3.1 定義 `DebugCheckpointEvent` topic — Bus.debug() 內部使用 `"debug.checkpoint"` type，未正式註冊為 BusEvent.define
- [x] 3.2 新增 `Bus.debug(scope, message, payload?)` API
- [x] 3.3 debug-writer subscriber 訂閱所有事件（含 debug.checkpoint）
- [x] 3.4 修改 `debugCheckpoint()` 為 thin wrapper 呼叫 `Bus.debug()`
- [x] 3.5 `util/log.ts` 改用 `Bus.debug()` 取代 `debugCheckpoint()`
- [x] 3.6 `index.ts` 改用 `registerDebugWriter()` 取代 `debugInit()`
- [ ] 3.7 驗證 debug.log 輸出格式與現有 debugCheckpoint 相容
- [ ] 3.8 驗證 `OPENCODE_LOG_LEVEL=0` 時 debug writer skip

## 4. Event Unification + Cleanup (Phase 4)

- [x] 4.1 BusContext envelope 加入 Bus.publish（directory, worktree, projectId, sessionId）
- [x] 4.2 清理 GlobalBus.emit 直接呼叫：config.ts, instance.ts, project.ts (×4), worktree/index.ts (×3), server/routes/global.ts
- [x] 4.3 SSE payload 正規化：server/app.ts 只送 {type, properties, context}
- [x] 4.4 bus-event.ts 移除 Log import（修復 Log→debug→Bus 循環依賴）；新增 bus/sink.ts dependency inversion 徹底消除 Log↔Bus 循環鏈
- [x] 4.5 GlobalBus.emit 直接呼叫剩餘：僅 bus/index.ts 內部（SSE transport，符合設計）
- [~] 4.6 TuiEvent.ToastShow 改為 subscriber 訂閱 — 保留現有機制，功能正常
- [ ] 4.7 End-to-end 測試：一次 publish → debug.log + toast + card 同時更新
