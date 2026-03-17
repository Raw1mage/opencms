# Design

## Context

### 現有架構（五套互不相通的訊息機制）

```
┌──────────────────────────────────────────────────────────────────────┐
│                        後端事件發布                                    │
│                                                                      │
│  Bus.publish(event, props)  ──── 152 call sites ────→ GlobalBus.emit │
│       │                                                    │         │
│       └→ Instance subscribers (41 sites)                   │         │
│                                                            │         │
│  GlobalBus.emit("event", ...) ── 11 direct sites ──→ SSE stream     │
│                                                                      │
│  debugCheckpoint(scope, msg, payload)  ── 432 sites ──→ debug.log   │
│       （完全獨立管道，與 Bus 無關）                                      │
│                                                                      │
│  Log.create().info/error()  ── 80+ instances ──→ console / file     │
│       （結構化日誌，與事件系統無關）                                      │
│                                                                      │
│  Bus.publish(TuiEvent.ToastShow, ...) ── 7+ sites                   │
│       （寄生在 Bus 上，但前端特殊攔截）                                   │
└──────────────────────────────────────────────────────────────────────┘
                                │
                  GlobalBus → SSE (兩個端點)
                    ├─ /api/v2/global/event  (全域)
                    └─ /api/v2/event          (per-directory)
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   前端事件接收 (global-sync.tsx)                        │
│                                                                      │
│  1. Toast 攔截 (L387) ← ✅ 永遠 work，因為繞過 directory routing        │
│                                                                      │
│  2. Directory routing (L416-420):                                    │
│     child = children.children[directory]                             │
│     if (!child) return  ← ❌ SILENT DROP                             │
│                                                                      │
│  3. applyDirectoryEvent() → event-reducer.ts switch/case             │
│     （rotation.executed 等事件永遠到不了這裡）                           │
└──────────────────────────────────────────────────────────────────────┘
```

### 問題彙整

1. **同一事件需要多次呼叫**：rotation 事件需要 debugCheckpoint + Bus.publish(RotationExecuted) + Bus.publish(ToastShow) 三次呼叫
2. **前端 directory routing drop**：GlobalBus → SSE 事件到前端後，因 directory key 不匹配被靜默 drop
3. **debugCheckpoint 獨立管道**：318 個呼叫站點的診斷資訊無法送到 UI
4. **TuiEvent 特殊攔截**：Toast 繞過 directory routing 才能 work，這是 workaround 不是 design
5. **GlobalBus 被繞過**：11 個直接 emit 跳過 Bus 層，缺少 zod 驗證
6. **輸出目標硬編碼**：publisher 必須知道所有消費者並逐一呼叫

### 事件系統普查

| 機制 | 定義數 | 呼叫點 | 訂閱點 | 驗證 |
|------|--------|--------|--------|------|
| BusEvent.define() | 65 (28 files) | — | — | zod schema |
| Bus.publish() | — | 152 (37 files) | 41 (16 files) | 透過 BusEvent schema |
| GlobalBus.emit() | — | 11 (6 files) | — | 無 |
| debugCheckpoint() | — | 432 (41 files) | — | 無 |
| Log.create() | 80+ | — | — | 結構化 |
| TuiEvent | 5 | 12 (6 files) | — | 透過 BusEvent schema |

## Goals / Non-Goals

**Goals:**
- Topic/Subscription 模型：publisher 選 topic 發布，subscriber 選 topic 訂閱，解耦兩端
- 單一 publish API：一次呼叫，不管有多少 subscriber
- 輸出端自主訂閱：debug.log writer、TUI toaster、webapp toaster、card component 各自註冊感興趣的 topic
- 修復前端 directory routing drop（broadcast-first）
- debugCheckpoint 整合進 topic/subscription 機制
- 漸進遷移：124 + 318 個呼叫點不需一次全改

**Non-Goals:**
- 不重寫 SSE transport（Hono streamSSE）
- 不改 solid-js store 響應式機制
- 不替換 Log.create()（operational logging 保持獨立）
- 不引入外部 message broker
- 不改 Rpc worker 通訊機制
- 不做事件持久化 / replay

## Decisions

### DD-1: Topic/Subscription 模型（Subscriber-Driven Output）

~~原設計：sink 在事件定義時宣告，publisher 決定輸出目標。~~

**修訂**：採用 DDS 風格的 topic/subscription 模型。Publisher 只選 topic 發布，輸出端自己訂閱感興趣的 topic。

```typescript
// Publisher 端：只管發布到正確的 topic
Bus.publish(RotationExecuted, { from, to, reason })

// Subscriber 端：各輸出端獨立註冊
// ── debug.log writer（後端）
Bus.subscribe(RotationExecuted, (props) => {
  if (env.OPENCODE_DEBUG_LOG) writeDebugLog("rotation", props)
})

// ── TUI toaster（後端 TUI 層）
Bus.subscribe(RotationExecuted, (props) => {
  showTuiToast(`${props.from} → ${props.to}`)
})

// ── webapp toaster（前端 global-sync.tsx）
emitter.on("rotation.executed", (props) => showToast(formatRotation(props)))

// ── LLM status card（前端 card component）
emitter.on("rotation.executed", (props) => pushLlmHistory(props))
```

**理由**：
- Publisher 不需要知道消費者，完全解耦
- 加一個新 card / 新輸出端只要新增 subscriber，不動事件定義
- Topic 選擇天然控制資訊粒度（詳細 debug topic vs 摘要 user-facing topic）
- 與 DDS topic/subscription 概念對齊

### DD-2: 前端改為 broadcast-first + directory hint

```typescript
// 改前（directory routing，會 drop）：
const child = children.children[directory]
if (!child) return  // ← silent drop

// 改後（broadcast to all children + directory hint）：
for (const [dir, child] of Object.entries(children.children)) {
  if (directory !== "global" && normalizeDirectoryKey(dir) !== directory) continue
  applyDirectoryEvent({ event, directory: dir, ...child })
}
```

**理由**：webapp 同時最多 1-3 個 directory，broadcast 成本可忽略（<1ms per event）。比起修復 directory normalization（可能有 symlink、encoding 等邊界情況），broadcast-first 更簡單且可靠。

### DD-3: debugCheckpoint 轉為 Bus.publish + debug topic subscriber

```typescript
// 現有
debugCheckpoint("rotation3d", "fallback selected", { from, to })

// 改為
Bus.debug("rotation3d", "fallback selected", { from, to })
// 內部 = Bus.publish(DebugCheckpointEvent, { scope, message, payload })

// debug.log writer 是一個 subscriber
Bus.subscribe(DebugCheckpointEvent, (props) => {
  if (env.OPENCODE_DEBUG_LOG) {
    appendFile(debugLogPath, `[${props.scope}] ${props.message} ${JSON.stringify(props.payload)}`)
  }
})
```

**理由**：debugCheckpoint 走統一管道後，任何 subscriber 都能接收——UI 也能顯示 debug 資訊（如果有人訂閱）。

### DD-4: logLevel 是 subscriber 層級的 filter

Publisher 帶上 level metadata，subscriber 各自決定門檻。logLevel 是全域 knob，控制 subscriber 的敏感度，不控制 publisher 的行為。

```typescript
// Publisher：永遠 publish，帶 level metadata
Bus.publish(RotationExecuted, { from, to, reason, level: "info" })

// Subscriber 各自 filter：
// debug writer：logLevel >= 1 才寫
Bus.subscribe(RotationExecuted, (props) => {
  if (logLevel < 1) return
  writeDebugLog(props)
})

// toaster：logLevel >= 2 才顯示
Bus.subscribe(RotationExecuted, (props) => {
  if (logLevel < 2) return
  showToast(formatRotation(props))
})

// card：logLevel >= 1 就顯示（使用者正在看的 UI）
Bus.subscribe(RotationExecuted, (props) => {
  if (logLevel < 1) return
  pushLlmHistory(props)
})
```

**logLevel 定義**：

| logLevel | 語義 | debug.log | toaster | card |
|----------|------|-----------|---------|------|
| 0 | disabled | - | - | - |
| 1 | quiet | write | - | show |
| 2 | normal | write | show | show |
| 3 | verbose | write (verbose) | show | show |

**控制方式**：`OPENCODE_LOG_LEVEL` 環境變數（預設 2 = normal）。取代現有 `OPENCODE_DEBUG_LOG` 的布林開關。

**理由**：
- Publisher 程式碼永遠不變——不管 logLevel 多少，publish 就是一行
- 加新 level 只改 subscriber 的 filter 條件
- 不同 subscriber 可以有不同的門檻解讀
- 向下相容：`OPENCODE_DEBUG_LOG=1` 等同 `OPENCODE_LOG_LEVEL=1`

### DD-5: GlobalBus 降級為 SSE transport adapter

```typescript
// GlobalBus 變為 Bus 的一個 internal subscriber
// 負責把事件透過 SSE 送到前端
Bus.subscribeAll((event) => {
  GlobalBus.emit("event", { directory: Instance.directory, payload: event })
})

// GlobalBus 不再被外部直接呼叫（11 個站點改走 Bus.publish）
```

**理由**：消除「跳過 Bus 層直接 emit」的旁路，確保所有事件走統一管道 + zod 驗證。

### DD-6: Topic 語義控制資訊粒度

```typescript
// 詳細技術資訊 → debug subscriber 訂閱
Bus.publish(RotationDebugDetail, { stack, timing, candidates, scores })

// 使用者可見的摘要 → toast + card subscriber 訂閱
Bus.publish(RotationExecuted, { from, to, reason })
```

**理由**：同一件事可以有不同粒度的 topic。Publisher 透過選擇 topic 控制語義層級，subscriber 透過選擇 topic 控制接收粒度。不需要 log level 也能達到分級效果。

### DD-7: 保留 backward-compatible wrappers

```typescript
// Bus.publish() 保持現有簽名，內部加 subscriber dispatch
// debugCheckpoint() 保持現有簽名，內部改呼叫 Bus.debug()
// GlobalBus.emit() 保留但標記 deprecated
```

**理由**：124 + 318 個呼叫點不需要一次全改。

## Data / State / Control Flow

### 新架構（Topic/Subscription 模型）

```
Publisher 端（後端）：
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Bus.publish(Topic, props)                                       │
│       │                                                          │
│       ├─ zod validation (現有)                                    │
│       │                                                          │
│       └─ dispatch to all subscribers of this topic               │
│            │                                                     │
│            ├─ [subscriber] debug.log writer                      │
│            │    └─ if OPENCODE_DEBUG_LOG → appendFile(debug.log) │
│            │                                                     │
│            ├─ [subscriber] TUI toaster                           │
│            │    └─ showTuiToast(format(props))                   │
│            │                                                     │
│            ├─ [subscriber] SSE transport (原 GlobalBus)           │
│            │    └─ GlobalBus.emit → SSE stream → 前端            │
│            │                                                     │
│            └─ [subscriber] Instance-local handlers (現有 37 個)   │
│                                                                  │
│  Bus.debug(scope, msg, payload)                                  │
│       → Bus.publish(DebugCheckpointEvent, { scope, msg, payload })│
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                          │
                    SSE /api/v2/global/event
                          │
                          ▼
Subscriber 端（前端）：
┌──────────────────────────────────────────────────────────────────┐
│  收到事件 { directory, payload }                                    │
│                                                                  │
│  // Broadcast to ALL children (DD-2)                             │
│  for (const [dir, child] of Object.entries(children.children)) { │
│    applyDirectoryEvent({ event, directory: dir, ...child })      │
│  }                                                               │
│                                                                  │
│  前端 subscriber（各自獨立註冊）：                                    │
│  ├─ webapp toaster: on("rotation.executed") → showToast(...)     │
│  ├─ LLM card: on("rotation.executed") → pushLlmHistory(...)     │
│  ├─ LLM card: on("ratelimit.detected") → updateLlmStatus(...)   │
│  └─ session list: on("session.*") → updateSessionList(...)       │
└──────────────────────────────────────────────────────────────────┘
```

### DDS 概念映射

| DDS 概念 | 實作 | 說明 |
|----------|------|------|
| Topic | BusEvent.define(type, schema) | 帶 zod schema 的具名事件類型 |
| Publisher / DataWriter | Bus.publish(topic, props) | 單一入口，不知道有誰在聽 |
| Subscriber / DataReader | Bus.subscribe(topic, callback) | 輸出端自主註冊 |
| Domain Participant | Instance (per-directory) | 每個 project directory 一個 instance |
| Partition | directory key in SSE payload | 前端用 broadcast-first 取代 exact-match |
| QoS: Enable | env gate in subscriber | OPENCODE_DEBUG_LOG 等 subscriber 層級控制 |
| QoS: Content Filter | severity / level filter | 未來擴展，subscriber 內部 filter |

## Risks / Trade-offs

### R-1: Migration cost（124 + 318 呼叫點）
- **風險**：一次遷移可能導致大量 regression
- **緩解**：漸進式遷移。Phase 1 只修 directory routing。Phase 2 加 subscriber infrastructure。Phase 3-4 才遷移呼叫點，且保留 backward-compatible wrappers。

### R-2: Broadcast-first 效能
- **風險**：broadcast 到所有 children 可能增加前端處理成本
- **緩解**：webapp 同時最多 1-3 個 directory。如果 >5ms per event，回退到修復 directory normalization。

### R-3: Subscriber 散佈的可維護性
- **風險**：「rotation.executed 有誰在聽？」需要翻多個檔案
- **緩解**：(a) 集中註冊——後端 subscriber 集中在 `bus/subscribers/` 目錄；(b) 前端 subscriber 在各 component 的 onMount 中，跟 UI 邏輯放一起是合理的；(c) 可建立 topic → subscriber 的 registry 輔助查詢。

### R-4: debugCheckpoint 高頻呼叫效能
- **風險**：318 個 debugCheckpoint 改走 Bus 可能增加開銷
- **緩解**：如果沒有 subscriber 註冊在該 topic 上，dispatch 是 O(1) no-op。debug subscriber 內部再做 env gate。

### R-5: Backward compatibility breakage
- **風險**：BusEvent.define 或 Bus.publish 改動可能影響現有行為
- **緩解**：新增 subscriber dispatch 是 additive，不改現有行為。現有 37 個 subscriber 繼續運作。

### R-6: 前端 subscriber lifecycle
- **風險**：component unmount 後 subscriber 沒清理，造成 memory leak 或 stale callback
- **緩解**：前端 subscriber 在 SolidJS onCleanup 中 unsubscribe，跟現有 createEffect cleanup 模式一致。

## Critical Files

### 核心改動
- `packages/opencode/src/bus/index.ts` — Bus.publish 擴展 subscriber dispatch + Bus.debug API
- `packages/opencode/src/bus/bus-event.ts` — BusEvent.define 保持不變（topic = event type）
- `packages/opencode/src/bus/global.ts` — 降級為 SSE transport subscriber

### 新建
- `packages/opencode/src/bus/subscribers/` — 後端 subscriber 集中目錄
  - `debug-writer.ts` — debug.log subscriber（取代 debugCheckpoint 管道）
  - `tui-toaster.ts` — TUI toast subscriber（取代 TuiEvent.ToastShow）

### Compatibility Wrappers
- `packages/opencode/src/util/debug.ts` — debugCheckpoint 改為 thin wrapper

### 前端修復
- `packages/app/src/context/global-sync.tsx` — broadcast-first routing
- `packages/app/src/context/global-sdk.tsx` — SSE event 解析

### 前端 subscriber（各 component 自主訂閱）
- `packages/app/src/context/global-sync/event-reducer.ts` — 已有 handler（不動）
- `packages/app/src/pages/session/session-status-sections.tsx` — LLM card subscriber
- `packages/app/src/context/global-sync.tsx` — webapp toaster subscriber

### 事件定義（publisher 端，只改 publish 方式）
- `packages/opencode/src/session/llm.ts` — rotation 事件統一
- `packages/opencode/src/account/rate-limit-judge.ts` — ratelimit 事件
- `packages/opencode/src/cli/cmd/tui/event.ts` — TuiEvent 重構
