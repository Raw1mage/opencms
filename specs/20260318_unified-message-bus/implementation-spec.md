# Implementation Spec

## Goal

建立 DDS 風格 Topic/Subscription Message Bus：Publisher 選 topic 發布，輸出端自主訂閱。修復前端 directory routing drop，整合 debugCheckpoint，使所有事件走統一管道。

## Scope

### IN
- Phase 1: 修復前端 directory routing drop（broadcast-first）
- Phase 2: 後端 subscriber infrastructure + subscriber 集中註冊
- Phase 3: debugCheckpoint 整合 + Bus.debug API
- Phase 4: LLM rotation 事件統一 + GlobalBus / TuiEvent 清理

### OUT
- SSE transport 層不改（Hono streamSSE）
- solid-js store 機制不改
- session/message/permission 等已正常事件不動
- Log.create()（operational logging）保持獨立
- Rpc worker 通訊機制不改
- 事件持久化 / replay
- 外部 message broker

## Assumptions

- webapp 的 children store 在同一時間最多 1-3 個 directory，broadcast 成本可忽略
- debugCheckpoint 的 `OPENCODE_DEBUG_LOG` gate 繼續作為 debug subscriber 的開關
- 前端 global-sdk.tsx 的 event coalescing 邏輯不需要改動
- 沒有 subscriber 時 dispatch 是 O(1) no-op，不影響效能
- Publisher 可同時 publish 多個 topic 實現多元輸出

## Stop Gates

- Phase 1 部署後必須驗證：session/message 事件不 regress + rotation 事件到達 card
- Phase 2 的 subscriber API 設計需要 review 後才進入 Phase 3
- 如果 broadcast-first 對效能有可量測影響（>5ms per event），需回退到修復 directory normalization

## Critical Files

### 核心改動
- `packages/opencode/src/bus/index.ts` — Bus.publish subscriber dispatch + Bus.debug API
- `packages/opencode/src/bus/bus-event.ts` — BusEvent.define（topic 定義，保持不變）
- `packages/opencode/src/bus/global.ts` — 降級為 SSE transport subscriber

### 新建
- `packages/opencode/src/bus/subscribers/debug-writer.ts` — debug.log subscriber
- `packages/opencode/src/bus/subscribers/tui-toaster.ts` — TUI toast subscriber

### Compatibility Wrappers
- `packages/opencode/src/util/debug.ts` — debugCheckpoint thin wrapper

### 前端
- `packages/app/src/context/global-sync.tsx` — broadcast-first routing
- `packages/app/src/context/global-sdk.tsx` — SSE event 解析
- `packages/app/src/context/global-sync/event-reducer.ts` — 已有 handler
- `packages/app/src/context/global-sync/types.ts` — LlmHistoryEntry 型別

### 前端 subscriber（component-level）
- `packages/app/src/pages/session/session-status-sections.tsx` — LLM card subscriber

### 事件定義
- `packages/opencode/src/session/llm.ts` — rotation 事件
- `packages/opencode/src/account/rate-limit-judge.ts` — ratelimit 事件
- `packages/opencode/src/cli/cmd/tui/event.ts` — TuiEvent 重構

### 高頻遷移檔案（debugCheckpoint 前 10 名）
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` — 89 calls
- `packages/opencode/src/provider/provider.ts` — 29 calls
- `packages/opencode/src/account/index.ts` — 17 calls
- `packages/opencode/src/session/processor.ts` — 15 calls
- `packages/opencode/src/cli/cmd/tui/util/clipboard.ts` — 15 calls
- `packages/opencode/src/plugin/gemini-cli/plugin/request.ts` — 13 calls
- `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx` — 13 calls
- `packages/opencode/src/session/llm.ts` — 11 calls
- `packages/opencode/src/cli/cmd/tui/app.tsx` — 11 calls
- `packages/opencode/src/tool/task.ts` — 8 calls

### 高頻遷移檔案（Bus.publish 前 5 名）
- `packages/opencode/src/tool/task.ts` — 19 calls
- `packages/opencode/src/server/routes/tui.ts` — 11 calls
- `packages/opencode/src/session/index.ts` — 9 calls
- `packages/opencode/src/session/processor.ts` — 8 calls
- `packages/opencode/src/session/llm.ts` — 6 calls

### 遷移範圍彙整
- 總計：713 呼叫點 / 96 唯一檔案
- Bus.publish: 152 calls / 37 files
- debugCheckpoint: 432 calls / 41 files
- BusEvent.define: 65 calls / 28 files
- Bus.subscribe: 41 calls / 16 files
- GlobalBus.emit: 11 calls / 6 files
- TuiEvent.ToastShow: 12 calls / 6 files

## Structured Execution Phases

### Phase 1: Fix Directory Routing Drop（立即可做）

修改 `global-sync.tsx` 的 event listener：
1. 將 directory exact-match routing 改為 broadcast-to-all-children
2. 移除 toast message 解析 hack（不再需要）
3. 驗證 rotation.executed 事件到達 event-reducer → llm_history → card

預期結果：LLM 狀態 card 開始顯示 rotation chain。

### Phase 2: Subscriber Infrastructure（架構擴展）

1. 擴展 `Bus.publish()` 支持 topic-level subscriber dispatch（除了現有 instance subscriber）
2. 新建 `packages/opencode/src/bus/subscribers/` 目錄
3. 實作 `debug-writer.ts` subscriber：訂閱事件，env gate 控制 debug.log 輸出
4. 實作 `tui-toaster.ts` subscriber：訂閱需要 toast 的事件
5. GlobalBus 改為 Bus 的 wildcard subscriber（SSE transport）
6. 前端 webapp toaster 改為 subscriber 模式（在 global-sync.tsx 訂閱特定 topic）
7. 前端 LLM card 改為 subscriber 模式（在 component mount 時訂閱 rotation/ratelimit topic）
8. 實作 `OPENCODE_LOG_LEVEL` env（0=off, 1=quiet, 2=normal, 3=verbose，預設 2）
9. 各 subscriber 加入 logLevel filter（debug writer >= 1, toaster >= 2, card >= 1）
10. 向下相容 `OPENCODE_DEBUG_LOG=1` → `LOG_LEVEL=1`
11. 驗證無 subscriber 變更的事件行為不變

### Phase 3: debugCheckpoint Migration（漸進遷移）

1. 定義 `DebugCheckpointEvent` topic（schema: scope, message, payload）
2. 新增 `Bus.debug(scope, message, payload?)` — 語法糖，內部 publish DebugCheckpointEvent
3. debug-writer subscriber 同時訂閱 DebugCheckpointEvent
4. debugCheckpoint 函數改為 thin wrapper 呼叫 Bus.debug
5. 高頻呼叫站點（llm.ts、rate-limit-judge.ts、processor.ts）逐批驗證
6. 保留 `OPENCODE_DEBUG_LOG` gate（subscriber 內部）
7. 驗證 debug.log 輸出格式相容

### Phase 4: Event Unification + Cleanup（最終清理）

1. `llm.ts` handleRateLimitFallback 移除 triple call → 單一 Bus.publish(RotationExecuted)
2. 清理 11 個 GlobalBus.emit 直接呼叫（改走 Bus.publish）
3. TuiEvent.ToastShow 從獨立事件改為 tui-toaster subscriber 訂閱
4. 清理前端 toast message 解析 hack
5. End-to-end 測試：一次 publish → debug.log + toast + card 同時更新（透過各自 subscriber）

## Validation

### Phase 1 驗證
- 觸發 rate limit rotation → LLM 狀態 card 顯示 rotation chain 條目
- 觸發 rate limit rotation → webapp toast 仍然顯示
- 開啟 session → 訊息正常載入（regression check）
- 切換 session → session list 正常更新（regression check）

### Phase 2 驗證
- debug-writer subscriber 訂閱事件 → 自動寫 debug.log（OPENCODE_DEBUG_LOG=1）
- tui-toaster subscriber 訂閱事件 → TUI toast 顯示
- webapp toaster subscriber → webapp toast 顯示
- LLM card subscriber → card history 更新
- 無 subscriber 變更的事件 → 行為與現有相同

### Phase 3 驗證
- `Bus.debug("scope", "msg", payload)` → debug.log 寫入，格式與 debugCheckpoint 相容
- `OPENCODE_DEBUG_LOG=0` → debug writer skip，其他 subscriber 不受影響
- 遷移後的呼叫站點行為不變

### Phase 4 驗證
- handleRateLimitFallback 中只有一次 Bus.publish 呼叫
- rotation 事件同時被 debug writer、toast、card subscriber 收到
- GlobalBus.emit 直接呼叫歸零
- TuiEvent.ToastShow 獨立 publish 歸零

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts (proposal.md, design.md, spec.md) before coding.
- Build agent must materialize runtime todo from tasks.md.
- **Phase 1 可立即執行**，不需要等其他 phase 的設計確認。
