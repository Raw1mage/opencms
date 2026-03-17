# Spec

## Purpose

統一 OpenCode 的事件傳遞系統，採用 DDS 風格的 Topic/Subscription 模型。Publisher 選擇 topic 發布，輸出端（debug.log、TUI toaster、webapp toaster、card component）自主訂閱感興趣的 topic。修復前端 directory routing drop。

## Requirements

### Requirement: Topic/Subscription Decoupling

Publisher 和 Subscriber 完全解耦。Publisher 只選 topic，不知道有誰在聽。

#### Scenario: Publisher publishes without knowing subscribers

- **GIVEN** `RotationExecuted` topic 有 3 個 subscriber（debug writer、webapp toaster、LLM card）
- **WHEN** `Bus.publish(RotationExecuted, { from, to, reason })` 被呼叫
- **THEN** 3 個 subscriber 的 callback 都被觸發
- **AND** publisher 端的程式碼沒有任何關於 subscriber 的引用

#### Scenario: New output added without changing publisher

- **GIVEN** 一個新的 UI card 想要顯示 rotation 事件
- **WHEN** 該 card component 註冊 `Bus.subscribe(RotationExecuted, handler)`
- **THEN** 下次 publish 時新 card 收到事件
- **AND** 不需要修改任何 publisher 端的程式碼

#### Scenario: Multi-topic publish for multi-granularity output

- **GIVEN** handleRateLimitFallback 偵測到 rotation
- **WHEN** publisher 選擇發布到多個 topic（`RotationExecuted` + `RotationDebugDetail`）
- **THEN** 訂閱 `RotationExecuted` 的 subscriber 收到使用者可見摘要
- **AND** 訂閱 `RotationDebugDetail` 的 subscriber 收到詳細技術資訊
- **AND** 各 topic 的 subscriber 互不干擾

### Requirement: Guaranteed Event Delivery

前端不應因 directory key 不匹配而靜默 drop 事件。

#### Scenario: Rotation event reaches LLM status card

- **GIVEN** 使用者正在 webapp 中檢視 session，LLM 狀態 card 已展開
- **WHEN** 後端發生 rate limit rotation（account A → account B）
- **THEN** LLM 狀態 card 立即顯示「model rate limited → rotated to target」條目
- **AND** webapp toast 同時顯示相同的 rotation 通知

#### Scenario: Events survive directory key mismatch

- **GIVEN** 後端 Instance.directory 為 `/home/user/projects/opencode`
- **AND** 前端 children store key 為 `/home/user/projects/opencode/` （trailing slash 差異）
- **WHEN** 後端 publish 一個 `rotation.executed` 事件
- **THEN** 事件仍然被前端正確處理

#### Scenario: Existing session/message events do not regress

- **GIVEN** 使用者開啟 webapp 並進入一個 session
- **WHEN** 後端 publish `session.created`、`message.updated`、`part.updated` 等事件
- **THEN** 前端 session list 和 message view 如常更新
- **AND** 不因 broadcast-first 機制產生重複或亂序

### Requirement: Subscriber-Driven Output

輸出端自主決定訂閱哪些 topic，而非 publisher 指定輸出目標。

#### Scenario: logLevel controls subscriber sensitivity

- **GIVEN** `OPENCODE_LOG_LEVEL=2`（normal）
- **WHEN** Bus.publish(RotationExecuted, { from, to, level: "info" })
- **THEN** debug writer 寫入 debug.log（門檻 >= 1）
- **AND** toaster 顯示 toast（門檻 >= 2）
- **AND** card 更新 history（門檻 >= 1）

#### Scenario: logLevel=1 suppresses toaster

- **GIVEN** `OPENCODE_LOG_LEVEL=1`（quiet）
- **WHEN** Bus.publish(RotationExecuted, { from, to, level: "info" })
- **THEN** debug writer 寫入 debug.log
- **AND** card 更新 history
- **AND** toaster **不**顯示 toast

#### Scenario: logLevel=0 disables all output

- **GIVEN** `OPENCODE_LOG_LEVEL=0`（disabled）
- **WHEN** Bus.publish(RotationExecuted, props)
- **THEN** 所有 subscriber skip，無任何輸出

#### Scenario: OPENCODE_DEBUG_LOG backward compatible

- **GIVEN** `OPENCODE_DEBUG_LOG=1`（舊環境變數）
- **AND** `OPENCODE_LOG_LEVEL` 未設定
- **WHEN** Bus.publish 任何事件
- **THEN** 系統視為 `OPENCODE_LOG_LEVEL=1`（quiet）

#### Scenario: Webapp toaster subscribes independently

- **GIVEN** webapp toaster 已訂閱 `RotationExecuted` 和 `LlmError`
- **WHEN** Bus.publish(RotationExecuted, props)
- **THEN** webapp 顯示 toast 通知
- **AND** 不需要額外的 TuiEvent.ToastShow publish

### Requirement: debugCheckpoint Integration

debugCheckpoint 走 topic/subscription 統一管道，不再是獨立管道。

#### Scenario: Bus.debug replaces debugCheckpoint

- **GIVEN** `OPENCODE_DEBUG_LOG=1`
- **AND** debug writer 已訂閱 `DebugCheckpointEvent`
- **WHEN** 呼叫 `Bus.debug("rotation3d", "fallback selected", { from, to })`
- **THEN** debug.log 寫入 `[rotation3d] fallback selected { from, to }`
- **AND** 格式與現有 debugCheckpoint 相容

#### Scenario: debugCheckpoint wrapper backward compatible

- **GIVEN** 現有 318 個 debugCheckpoint 呼叫站點
- **WHEN** debugCheckpoint 函數改為 thin wrapper 呼叫 Bus.debug
- **THEN** 所有現有呼叫站點不需要任何改動
- **AND** debug.log 輸出與改動前完全一致

### Requirement: GlobalBus Consolidation

GlobalBus 從 relay layer 降級為 Bus 的一個 internal subscriber（SSE transport）。

#### Scenario: GlobalBus becomes SSE transport subscriber

- **GIVEN** GlobalBus 註冊為 Bus 的 wildcard subscriber
- **WHEN** Bus.publish(任何事件, props)
- **THEN** GlobalBus 透過 SSE 送到前端
- **AND** 所有事件經過 zod schema 驗證

#### Scenario: Direct GlobalBus.emit eliminated

- **GIVEN** 現有 11 個 GlobalBus.emit 直接呼叫站點
- **WHEN** 遷移完成後
- **THEN** GlobalBus.emit 只被 SSE transport subscriber 內部呼叫
- **AND** 外部不再直接呼叫 GlobalBus.emit

## Acceptance Checks

- LLM 狀態 card 在 rotation 發生後 2 秒內顯示 rotation chain 條目
- Publisher 端只有一行 Bus.publish，不需要多次呼叫到不同輸出端
- 加新 subscriber 不需要改 publisher 程式碼
- debugCheckpoint 呼叫站點可漸進式遷移到 Bus.debug()，行為不變
- 現有 session/message 事件不受影響（regression check）
- directory routing drop 不再發生（broadcast-first 機制）
- OPENCODE_LOG_LEVEL 控制 subscriber 敏感度（0=off, 1=quiet, 2=normal, 3=verbose）
- OPENCODE_DEBUG_LOG=1 向下相容為 LOG_LEVEL=1
- GlobalBus.emit 直接呼叫歸零（只剩 SSE transport subscriber 內部使用）
- 同一事件可被多個 subscriber 接收（debug + toast + card）
- 多 topic publish 支援不同粒度的資訊分發
