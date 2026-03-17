# Proposal

## Why

OpenCode 有五套互不相通的訊息機制：

| 機制 | 呼叫點 | 輸出端 | 問題 |
|------|--------|--------|------|
| `Bus.publish()` | 152 (37 files) | SSE → 前端 event-reducer | 依賴 directory routing，會靜默 drop |
| `GlobalBus.emit()` | 11 (6 files) | SSE → 前端 | 跳過 Bus，缺少 zod 驗證 |
| `debugCheckpoint()` | 432 (41 files) | debug.log 檔案 | 完全獨立管道，無法送到 UI |
| `Log.create().info/error()` | 80+ | console/file | 結構化日誌，與事件系統無關 |
| `TuiEvent.ToastShow` | 12 (6 files) | TUI/webapp toast | 寄生在 Bus 上，但前端特殊攔截 |

同一個語義事件（例如「rate limit rotation 發生了」）需要三次獨立呼叫：
1. `debugCheckpoint("rotation3d", ...)` → debug.log
2. `Bus.publish(RotationExecutedEvent, ...)` → 嘗試到前端 card（被 drop）
3. `Bus.publish(TuiEvent.ToastShow, ...)` → toast（繞過 routing 所以能到）

這不是單一 bug，是架構缺陷。

## Original Requirement Wording (Baseline)

- "與其在這邊改來改去，我寧願有一個統一的 message bus。它可以跟 debugcheckpoint 統一。差別是輸出端可以自由的設定為：輸出 debug.log、顯示在 TUI toaster 上、顯示在 webapp toaster 上、顯示在任何指定的 card 上"
- "你的 plan 只為了修改單一功能。但我要的 plan 是大重構整個 repo 把所有的 event messaging 獨立成一個子系統，確保有一致的行為功效。"
- "publish的時候甚至可以選多個topic，實現多元輸出"
- "每一個調用event log的checkpoint，都要能夠根據log_enable環境變數決定是否動作"
- "每一個調用event log的checkpoint，都要能指定一或多個輸出目標"
- "如果加上loglevel來決定輸出細節，可能是更專業的做法。但我怕複雜度一下子拉太高"

## Requirement Revision History

- 2026-03-18: 初始需求 — 修復 LLM status card 不顯示 rotation 事件
- 2026-03-18: 擴大 scope — 全 repo 事件子系統重構，統一 Bus/GlobalBus/debugCheckpoint/TuiEvent
- 2026-03-18: 設計方向確認 — 採用 DDS 風格 Topic/Subscription 模型，subscriber-driven output
- 2026-03-18: 新增要求 — env gate（log_enable）、多 topic publish、log level 預留（不在本次 scope）

## Effective Requirement Description

1. **DDS 風格 Topic/Subscription 模型**：Publisher 選 topic 發布，輸出端（debug.log、TUI toaster、webapp toaster、card）自主訂閱感興趣的 topic
2. **單一 publish API**：一次 `Bus.publish(Topic, props)` 即可觸達所有訂閱該 topic 的 subscriber
3. **多 topic publish**：Publisher 可同時發布多個 topic，實現不同粒度的多元輸出（詳細 debug topic vs 使用者可見摘要 topic）
4. **Subscriber-driven output**：輸出端自主註冊訂閱，加新輸出端不動 publisher 程式碼
5. **env gate（subscriber 層級）**：每個 subscriber 自行決定是否啟用（如 OPENCODE_DEBUG_LOG 控制 debug writer）
6. **保證送達**：前端不因 directory routing 不匹配而靜默 drop
7. **漸進遷移**：152 個 Bus.publish + 432 個 debugCheckpoint（共 713 個呼叫點 / 96 個檔案）不需要一次全改，保留 backward-compatible wrapper
8. **Log 整合或共存**：Log.create() 保持獨立（operational logging），debugCheckpoint 併入 topic/subscription
9. **logLevel（subscriber-side filter）**：`OPENCODE_LOG_LEVEL` 環境變數控制各 subscriber 的敏感度門檻（0=off, 1=quiet, 2=normal, 3=verbose）。Publisher 不變，subscriber 各自 filter

## Scope

### IN
- 修復前端 directory routing drop（broadcast-first）
- 擴展 Bus.publish 支持 topic-level subscriber dispatch
- 新建後端 subscriber 集中目錄（debug-writer、tui-toaster）
- 前端輸出端改為 subscriber 模式（webapp toaster、LLM card component）
- Bus.debug API 整合 debugCheckpoint（走統一 topic）
- GlobalBus 降級為 Bus 的 SSE transport subscriber
- TuiEvent.ToastShow 改為 tui-toaster subscriber 訂閱
- 多 topic publish 支援
- 清理 11 個 GlobalBus.emit 直接呼叫（6 files）
- 清理 12 個 TuiEvent.ToastShow 呼叫（6 files）
- 遷移高頻 debugCheckpoint 呼叫站點

### OUT
- 不改 SSE transport 本身（Hono streamSSE）
- 不改 solid-js store 響應式機制
- 不替換 Log.create()（operational logging 保持獨立）
- 不引入外部 message broker
- 不改 Rpc worker 通訊機制
- logLevel subscriber filter 在 Phase 2 實作（OPENCODE_LOG_LEVEL env）

## Non-Goals
- 分散式 message queue
- 事件持久化 / replay
- 改寫 TUI Ink rendering 框架
- logLevel 超過 3 的 level 定義（未來再擴展）

## Constraints
- 後端 Bun runtime，前端 SolidJS browser
- SSE 是唯一 server→client 推送通道
- 152 個 publish (37 files) + 41 個 subscribe (16 files) + 432 個 debugCheckpoint (41 files) + 65 個 define (28 files) 必須漸進遷移，總計 713 呼叫點 / 96 唯一檔案
- `Bus.publish()` 和 `debugCheckpoint()` 簽名必須保持 backward-compatible wrapper

## What Changes

| 層 | 現狀 | 改後 |
|---|------|------|
| 設計模型 | 無統一模型，五套機制各自為政 | DDS 風格 Topic/Subscription |
| 事件定義 | `BusEvent.define(type, schema)` | 不變（topic = event type） |
| 事件發布 | `Bus.publish()` + `debugCheckpoint()` + `TuiEvent.ToastShow` | `Bus.publish(Topic, props)` 單一入口，可多 topic |
| 輸出路由 | Publisher 硬編碼輸出目標 | Subscriber-driven：輸出端自主訂閱 |
| 事件傳輸 | Bus → GlobalBus → SSE（兩層 relay） | Bus → subscriber dispatch（GlobalBus 變為 SSE transport subscriber） |
| 前端接收 | directory exact-match routing（會 drop） | broadcast-first + directory hint |
| 診斷追蹤 | `debugCheckpoint()` 獨立管道 | `Bus.debug()` → DebugCheckpointEvent topic → debug writer subscriber |
| Toast 通知 | `Bus.publish(TuiEvent.ToastShow)` 特殊攔截 | Toaster subscriber 訂閱相關 topic |
| env gate | 無統一機制 | Subscriber 層級 gate（OPENCODE_DEBUG_LOG 等） |

## Capabilities

### New Capabilities
- **Topic/Subscription dispatch**：Bus.publish 觸發所有訂閱該 topic 的 subscriber
- **Multi-topic publish**：一次操作可 publish 多個 topic，不同粒度的資訊分發
- **Subscriber 集中目錄**：`bus/subscribers/` — debug-writer、tui-toaster 等
- **Bus.debug()**：debugCheckpoint 的 drop-in 替代，走統一 topic
- **Broadcast-first delivery**：前端事件保證送達
- **Subscriber-level env gate**：各輸出端自主控制啟用條件

### Modified Capabilities
- **Bus.publish()**：新增 topic-level subscriber dispatch（additive，不改現有行為）
- **debugCheckpoint()**：變為 thin wrapper 呼叫 Bus.debug
- **GlobalBus**：從「relay layer」降級為「SSE transport subscriber」
- **TuiEvent.ToastShow**：從「獨立事件 + 特殊攔截」變為「tui-toaster subscriber 訂閱」

## Impact

### 核心改動
- `packages/opencode/src/bus/index.ts` — 擴展 subscriber dispatch + Bus.debug API
- `packages/opencode/src/bus/global.ts` — 降級為 SSE transport subscriber
- `packages/opencode/src/util/debug.ts` — 降級為 compatibility wrapper

### 新建
- `packages/opencode/src/bus/subscribers/debug-writer.ts`
- `packages/opencode/src/bus/subscribers/tui-toaster.ts`

### 大量遷移（漸進式）
- 318 個 `debugCheckpoint()` → `Bus.debug()` 或保留 wrapper
- 11 個 `GlobalBus.emit()` 直接呼叫 → 走 Bus.publish
- 7+ 個 `Bus.publish(TuiEvent.ToastShow)` → 由 tui-toaster subscriber 取代

### 前端修復
- `packages/app/src/context/global-sync.tsx` — broadcast-first routing + subscriber 模式
- `packages/app/src/pages/session/session-status-sections.tsx` — LLM card subscriber
