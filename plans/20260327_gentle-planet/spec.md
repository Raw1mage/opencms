# Spec

## Purpose

- 定義 context sharing v2 的可驗證行為，確保 child 以 parent full-message prefix 執行，且 parent continuation 可取得足夠 child evidence。

## Requirements

### Requirement: Forward Parent Messages To Child

The system SHALL prepend the parent session's visible message history to each child model call as a stable, read-only prefix.

#### Scenario: First child round carries full parent context

- **GIVEN** parent session 已累積可觀上下文且 child 為新派生 session
- **WHEN** child 進入第一輪模型呼叫
- **THEN** child messages 必須包含 parent 歷史、separator、child task prompt

#### Scenario: Continued child worker reloads parent prefix once per prompt loop

- **GIVEN** task tool 以 `session_id` 續跑既有 child session
- **WHEN** 新的 child prompt loop 啟動
- **THEN** parent prefix 必須在該次 loop 啟動時重新載入一次
- **AND** 同一次 loop 內不得每輪重新讀 parent store

### Requirement: Remove Snapshot Injection As Primary Bridge

The system SHALL stop injecting SharedContext snapshot content into child prompt parts during dispatch.

#### Scenario: Dispatch no longer duplicates parent context

- **GIVEN** child 已透過 parent message forwarding 取得完整 parent 脈絡
- **WHEN** task dispatch 建立 child 的第一則 user prompt
- **THEN** prompt parts 不得再額外插入 SharedContext snapshot

### Requirement: Relay Child Evidence Back To Parent

The system SHALL provide sufficient child completion evidence to the parent continuation path.

#### Scenario: Parent continuation can reason over child completion

- **GIVEN** child session 已完成 delegated work
- **WHEN** task-worker continuation 建立 parent synthetic continuation message
- **THEN** 該 continuation 必須包含 child 關鍵 assistant outputs 或等價 evidence
- **AND** `SharedContext.mergeFrom()` 可保留，但不得是唯一回饋來源

### Requirement: Preserve SharedContext For Compaction Only

The system SHALL preserve SharedContext v1 infrastructure for compaction and observability purposes only.

#### Scenario: Child compaction compresses only child-owned history

- **GIVEN** child 帶有大型 parent prefix 並觸發 compaction
- **WHEN** compaction 執行
- **THEN** 只可壓縮 child 自己的 session history
- **AND** parent prefix 必須維持 read-only

## Acceptance Checks

- T9: 有一組高 parent-prefix 佔比測試，能判斷 child compaction 是否出現 oscillation。
- T10: 有 checkpoint 證據證明 child 第一輪模型呼叫包含完整 parent history 與 separator。
- T11: 有 by-token provider 的 stable-prefix cache reuse 證據。
- T12: 有 by-request provider 成本不受 full prefix 影響的觀測與結論。
- T13/T14: event 與 architecture 文件同步規則已被明確列為 completion gate。
