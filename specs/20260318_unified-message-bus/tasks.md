# Tasks

## 1. Fix Directory Routing Drop (Phase 1)

- [ ] 1.1 修改 `global-sync.tsx` event listener：directory routing 改為 broadcast-to-all-children
- [ ] 1.2 移除 `global-sync.tsx` 中的 toast message 解析 hack（`message.includes("->")` 區塊）
- [ ] 1.3 驗證 `rotation.executed` 事件通過 broadcast 到達 `event-reducer.ts` 的 case handler
- [ ] 1.4 驗證 `ratelimit.detected` / `ratelimit.cleared` / `llm.error` 也能正確到達
- [ ] 1.5 驗證 session.created / message.updated 等事件不 regress
- [ ] 1.6 Build + deploy + 實機測試 LLM 狀態 card 顯示 rotation chain

## 2. Subscriber Infrastructure (Phase 2)

- [ ] 2.1 擴展 `Bus.publish()` 支持 topic-level subscriber dispatch
- [ ] 2.2 新建 `packages/opencode/src/bus/subscribers/` 目錄
- [ ] 2.3 實作 `debug-writer.ts`：訂閱事件 + OPENCODE_DEBUG_LOG env gate + 寫 debug.log
- [ ] 2.4 實作 `tui-toaster.ts`：訂閱需要 toast 的事件 + 呼叫 TUI toast API
- [ ] 2.5 GlobalBus 改為 Bus 的 wildcard subscriber（SSE transport adapter）
- [ ] 2.6 前端 webapp toaster 改為 subscriber 模式（global-sync.tsx 訂閱特定 topic）
- [ ] 2.7 前端 LLM card 改為 subscriber 模式（component mount 時訂閱 rotation/ratelimit）
- [ ] 2.8 實作 `OPENCODE_LOG_LEVEL` env 讀取（0=off, 1=quiet, 2=normal, 3=verbose，預設 2）
- [ ] 2.9 各 subscriber 加入 logLevel filter（debug writer >= 1, toaster >= 2, card >= 1）
- [ ] 2.10 向下相容：`OPENCODE_DEBUG_LOG=1` 映射為 `LOG_LEVEL=1`
- [ ] 2.11 驗證 logLevel=0 時所有 subscriber skip
- [ ] 2.12 驗證無 subscriber 變更的事件行為不變（regression check）

## 3. debugCheckpoint Integration (Phase 3)

- [ ] 3.1 定義 `DebugCheckpointEvent` topic（schema: scope, message, payload）
- [ ] 3.2 新增 `Bus.debug(scope, message, payload?)` API（語法糖 → publish DebugCheckpointEvent）
- [ ] 3.3 debug-writer subscriber 訂閱 DebugCheckpointEvent
- [ ] 3.4 修改 `debugCheckpoint()` 為 thin wrapper 呼叫 `Bus.debug()`
- [ ] 3.5 驗證 debug.log 輸出格式與現有 debugCheckpoint 相容
- [ ] 3.6 遷移 `llm.ts` 中的 debugCheckpoint 呼叫到 Bus.debug
- [ ] 3.7 遷移 `rate-limit-judge.ts` 中的 debugCheckpoint 呼叫
- [ ] 3.8 遷移 `processor.ts` 中的 debugCheckpoint 呼叫
- [ ] 3.9 驗證 `OPENCODE_LOG_LEVEL=0` 時 debug writer skip

## 4. Event Unification + Cleanup (Phase 4)

- [ ] 4.1 `llm.ts` handleRateLimitFallback 移除 triple call → 單一 Bus.publish(RotationExecuted)
- [ ] 4.2 清理 11 個 GlobalBus.emit 直接呼叫站點（改走 Bus.publish）
- [ ] 4.3 TuiEvent.ToastShow 從獨立事件改為 tui-toaster subscriber 訂閱
- [ ] 4.4 移除前端 `global-sync.tsx` 中的 toast 解析 hack（Phase 1 殘留）
- [ ] 4.5 移除 7+ 個直接 Bus.publish(TuiEvent.ToastShow, ...) 呼叫
- [ ] 4.6 End-to-end 測試：一次 publish → debug.log + toast + card 同時更新
- [ ] 4.7 驗證 TUI toaster 和 webapp toaster 行為一致
