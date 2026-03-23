# Spec

## Purpose
- 讓 TUI 在長對話 session 中實現非同步漸進加載，最新消息優先顯示，舊消息分批背景加載且不干擾用戶操作

## Requirements

### Requirement: Cursor-Based Pagination
後端 `Session.messages()` SHALL 支援 cursor-based 分頁，以 message ID 為 cursor 向前讀取指定數量的消息。

#### Scenario: 帶 cursor 的分頁請求
- **GIVEN** session 中有 60 條消息，ID 從 msg_001 到 msg_060
- **WHEN** 呼叫 `Session.messages({ sessionID, limit: 20, cursor: "msg_040" })`
- **THEN** 返回 msg_020 到 msg_039 共 20 條消息，按時間序排列

#### Scenario: 不帶 cursor 的請求（向下相容）
- **GIVEN** session 中有 60 條消息
- **WHEN** 呼叫 `Session.messages({ sessionID, limit: 20 })`
- **THEN** 返回最近 20 條消息（msg_041 到 msg_060），行為與現有一致

#### Scenario: cursor 到達會話起點
- **GIVEN** session 中有 60 條消息，cursor 指向 msg_010
- **WHEN** 呼叫 `Session.messages({ sessionID, limit: 20, cursor: "msg_010" })`
- **THEN** 返回 msg_001 到 msg_009 共 9 條消息，調用者可知已到起點

### Requirement: Two-Phase TUI Loading
TUI 的 sync 機制 SHALL 分兩階段加載消息：快速初始載入 + 背景補齊。

#### Scenario: 長 session 初始進入
- **GIVEN** session 有 80 條消息
- **WHEN** 用戶進入該 session
- **THEN** 最近 20 條消息在首次渲染中顯示，用戶可立即輸入
- **AND** 剩餘消息在背景逐批加載

#### Scenario: 短 session 無退化
- **GIVEN** session 只有 12 條消息
- **WHEN** 用戶進入該 session
- **THEN** 所有 12 條消息一次性加載，無額外延遲

#### Scenario: 背景加載不影響滾動位置
- **GIVEN** 用戶已在 session 中查看最新消息
- **WHEN** 背景加載完成並 prepend 了 40 條舊消息
- **THEN** scrollbox 的可見內容不跳動，用戶看到的消息不變

### Requirement: Compaction-Aware Initial Load
TUI SHALL 初始加載止步於最近的 compaction 邊界，除非用戶主動請求載入更早的消息。

#### Scenario: 存在 compaction 邊界
- **GIVEN** session 有 100 條消息，第 40 條是 compaction 邊界
- **WHEN** 用戶進入 session
- **THEN** TUI 只載入第 41-100 條消息（compaction 之後）
- **AND** 在第 41 條消息上方顯示 compaction 摘要 + 「載入更早消息」按鈕

#### Scenario: 用戶展開 compaction 之前的消息
- **GIVEN** TUI 顯示了 compaction 邊界 UI
- **WHEN** 用戶點擊「載入更早消息」
- **THEN** 使用 cursor API 加載 compaction 之前的消息到下一個 compaction 邊界或會話起點

#### Scenario: 無 compaction 邊界
- **GIVEN** session 有 100 條消息但從未觸發 compaction
- **WHEN** 用戶進入 session
- **THEN** 走正常的兩階段加載流程（最近 20 條 + 背景補齊到 limit）

## Acceptance Checks
- 長 session（50+ 消息）進入時，最新消息在 200ms 內顯示
- 背景加載期間，scrollbox 視口位置穩定（像素偏移 = 0）
- 短 session（≤20 消息）的加載行為不退化（無多餘 API 呼叫）
- Compaction 邊界 UI 正確顯示摘要文本和互動按鈕
- 現有 compact/prune 流程不受影響（既有測試全部通過）
