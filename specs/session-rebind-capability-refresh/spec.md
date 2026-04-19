# Spec: session-rebind-capability-refresh

## Purpose

- 建立「能力層（capability layer）」與「對話層（conversation layer）」的明確邊界契約：能力層必須在每個 rebind event 發生時從磁碟重讀，對話層繼續靠 checkpoint / SharedContext 壓縮。
- 讓「rebind event → 能力層刷新」成為 runtime iron-clad invariant，根治 mandatory-skills-preload 留下的三個漏洞（10 秒 TTL cache、provider switch 不重讀、UI 打開 session 不 init）。
- 新增使用者 / AI 能主動觸發 rebind 的入口：`/reload` slash command 與 `refresh_capability_layer` tool call。

## Requirements

### Requirement: Capability vs Conversation Layer 邊界

The system SHALL 明確區分能力層與對話層，並強制以下歸屬：

- **能力層**：system prompt、driver prompt、AGENTS.md（global + project）、coding.txt sentinel、skill content、enablement.json
- **對話層**：user messages、assistant responses、tool results、task progress、SharedContext snapshot、rebind checkpoint messages

能力層**不得**進入 checkpoint / SharedContext；對話層**不得**進入 rebind epoch cache。

#### Scenario: checkpoint 只壓對話層

- **GIVEN** session 的 rebind checkpoint 已存在
- **WHEN** runtime 讀取 checkpoint
- **THEN** checkpoint 內容必須**只**含壓縮過的 messages 與對話層 metadata
- **AND** 不得出現 AGENTS.md 內容、skill content、driver prompt 等能力層文字

#### Scenario: 能力層 cache 不依賴 checkpoint

- **GIVEN** session 剛套用 rebind checkpoint 壓縮 messages
- **WHEN** runtime 組裝下一輪 system prompt
- **THEN** 能力層內容必須直接從磁碟 / epoch-cache 取得
- **AND** 不得從 checkpoint payload 抽取任何 system prompt / skill content

### Requirement: Rebind Event 列舉

The system SHALL 把以下事件歸類為 rebind event，每個事件發生都會 bump 該 session 的 rebind epoch：

1. Daemon 啟動（runtime 初始化時）
2. Session resume（UI 切到某 session 時發訊號）
3. Provider / model / account 切換（同 session 內）
4. `/reload` slash command 執行
5. `refresh_capability_layer` tool call 執行

#### Scenario: Daemon 啟動時 epoch 從 0 bump 到 1

- **GIVEN** daemon 剛啟動，in-memory rebind epoch map 為空
- **WHEN** session 第一次被使用（user 送訊息 / resume signal / cron 觸發）
- **THEN** 該 session 的 epoch 被設為 1（從預設 0 bump 一次）
- **AND** `session.rebind` 事件發出，trigger = `daemon_start`

#### Scenario: Session resume 時 bump epoch

- **GIVEN** session epoch = N，UI 切換到該 session
- **WHEN** UI 發 `session.resume` signal 給 daemon
- **THEN** daemon 收到後 bump epoch 到 N+1
- **AND** `session.rebind` 事件發出，trigger = `session_resume`
- **AND** 觸發 silent init round（不打 LLM）

#### Scenario: Provider 切換時 bump epoch

- **GIVEN** session 當前 provider 為 anthropic，epoch = N
- **WHEN** 使用者切換到 codex provider
- **THEN** pre-loop provider switch detection 呼叫 bump epoch 到 N+1
- **AND** `session.rebind` 事件發出，trigger = `provider_switch`
- **AND** compactWithSharedContext 之前**必須**先 bump epoch

#### Scenario: Slash command 觸發

- **GIVEN** 使用者在 TUI / web 輸入 `/reload`
- **WHEN** command handler 執行
- **THEN** 當前 session 的 epoch 從 N bump 到 N+1
- **AND** `session.rebind` 事件發出，trigger = `slash_reload`
- **AND** 不打 LLM
- **AND** UI 收到 `capability_layer.refreshed` event 顯示 toast

#### Scenario: Tool call 觸發

- **GIVEN** AI 在對話中呼叫 `refresh_capability_layer({reason: "need updated skill list"})`
- **WHEN** tool 執行
- **THEN** 當前 session 的 epoch bump
- **AND** `session.rebind` 事件發出，trigger = `tool_call`，payload 含 reason
- **AND** 同一 LLM 回合接下來的 tool calls / response 可見新能力層

### Requirement: Capability Layer Cache 契約

The system SHALL 以 per-session rebind epoch 作為能力層 cache 的唯一 key，平時命中 cache 直接重用 in-memory 內容，epoch bump 時整個 session 的能力層 cache 作廢。

#### Scenario: 同 epoch 內多輪重用 cache

- **GIVEN** session epoch = 3，AGENTS.md 已讀過並 cache
- **WHEN** 同 session 連續 10 輪 LLM 對話（無 rebind event）
- **THEN** runtime 不得重新讀 AGENTS.md 檔案
- **AND** system prompt 組裝直接從 in-memory cache 取字串

#### Scenario: Epoch bump 後 cache 失效

- **GIVEN** session epoch = 3，AGENTS.md cache 已填入
- **WHEN** `/reload` 觸發 epoch 3 → 4
- **THEN** cache 內 (sessionID, epoch=3) 的條目必須作廢或跳過
- **AND** 下一輪 runLoop 以 epoch=4 為 key，cache miss，重讀 AGENTS.md
- **AND** 新內容存入 (sessionID, epoch=4) cache

#### Scenario: 禁止時間基失效

- **GIVEN** session epoch = 3，AGENTS.md cache 存入已經 > 10 秒
- **WHEN** 下一輪 runLoop 組裝 system prompt
- **THEN** cache 依然命中（epoch 未變）
- **AND** 不得因為「超過 10 秒」而主動作廢

### Requirement: 能力層刷新順序契約

The system SHALL 確保單輪 runLoop 組裝 system prompt 時，能力層的取得 / 注入早於 checkpoint / SharedContext 的對話層壓縮應用。

#### Scenario: Provider switch 的刷新順序

- **GIVEN** session 偵測到 provider 從 anthropic 切換到 codex
- **WHEN** 進入 pre-loop provider switch detection 區塊
- **THEN** 執行順序必須為：
  1. bump epoch
  2. 清空能力層 cache
  3. 重讀 AGENTS.md / skill content（能力層）
  4. 載入 rebind checkpoint snapshot（對話層壓縮）
  5. 呼叫 compactWithSharedContext（對話層壓縮）
- **AND** 步驟 3 必須早於步驟 4 與 5

#### Scenario: Resume signal 的刷新順序

- **GIVEN** UI 發 `session.resume` signal
- **WHEN** daemon handler 處理該 signal
- **THEN** 執行順序必須為：bump epoch → 清 cache → 重注入能力層 → 發 `capability_layer.refreshed` event
- **AND** 期間**不得**呼叫 LLM（silent refresh）
- **AND** 不得觸發 autonomous continuation

### Requirement: Slash Command `/reload`

The system SHALL 提供 `/reload` slash command，讓使用者在對話中手動 bump 當前 session 的 rebind epoch。

#### Scenario: 基本 `/reload` 執行

- **GIVEN** 使用者在 TUI 或 web 輸入 `/reload`
- **WHEN** command dispatcher 接到指令
- **THEN** 呼叫 rebind-epoch module 的 `bumpEpoch(sessionID, trigger: "slash_reload")`
- **AND** 回傳短訊息「Capability layer refreshed (epoch N → N+1)」
- **AND** 不送任何 LLM 請求
- **AND** 不寫入 tasks.md / message history

#### Scenario: `/reload` 在 no-session 情境下拒絕

- **GIVEN** 使用者在**無 active session** 的 CLI context 下輸入 `/reload`
- **WHEN** command handler 被呼叫
- **THEN** 回傳錯誤「no active session to reload」
- **AND** 不 bump 任何 epoch

### Requirement: Tool Call `refresh_capability_layer`

The system SHALL 提供 `refresh_capability_layer` tool call，讓 AI 在對話中主動觸發 rebind event。

#### Scenario: AI 呼叫 tool

- **GIVEN** AI 偵測到自己缺少某個近期新增的 skill
- **WHEN** AI 發出 `refresh_capability_layer({reason: "detected missing new-skill in registry"})`
- **THEN** tool 執行 bump epoch，trigger = `tool_call`，reason 記錄在 event payload
- **AND** tool 返回 `{previousEpoch: N, currentEpoch: N+1, refreshedSkills: [...]}`
- **AND** AI 可在同一 assistant turn 的後續 tool calls 看到新能力層

#### Scenario: 防止 AI 惡性循環呼叫

- **GIVEN** AI 在單一 turn 內已呼叫 `refresh_capability_layer` 3 次
- **WHEN** AI 嘗試第 4 次呼叫
- **THEN** tool 回傳錯誤「refresh limit exceeded (3 per turn)」
- **AND** 不 bump epoch
- **AND** anomaly event 發出，flag `refresh_loop_suspected`

### Requirement: UI Session-resume Silent Refresh

The system SHALL 提供 `session.resume` signal endpoint，讓前端在 session 被使用者選中時觸發 daemon 的 silent init round。

#### Scenario: 前端發 resume signal

- **GIVEN** 使用者在 TUI / web 切到某 session
- **WHEN** 前端向 daemon 發 `POST /session/:id/resume`（或等效 SSE event）
- **THEN** daemon 驗證 signal 來源（同 process / 同 uid socket）
- **AND** 呼叫 bumpEpoch(sessionID, "session_resume")
- **AND** 跑 silent init round：重注入能力層、pin mandatory skills、推 SSE event
- **AND** 不呼叫 LLM，不計費，不寫入 message history

#### Scenario: 惡意來源偽造 resume signal

- **GIVEN** AI 在 tool call 中嘗試構造 `POST /session/:id/resume` 請求
- **WHEN** daemon server 收到該請求
- **THEN** 驗證來源不匹配（非 UI socket origin）→ 拒絕
- **AND** log warn「session.resume from unexpected origin」
- **AND** anomaly event 發出

### Requirement: Observability Events

The system SHALL 為每個 rebind event 與能力層刷新動作發送 RuntimeEvent，payload 含 trigger、epoch transition、刷新的能力層清單。

#### Scenario: session.rebind 事件

- **GIVEN** 任一 rebind event 發生
- **WHEN** bumpEpoch 執行
- **THEN** `RuntimeEventService.append` 必須寫入：
  - `eventType: "session.rebind"`
  - `level: "info"`
  - `domain: "workflow"`
  - `payload: { sessionID, previousEpoch: N, currentEpoch: N+1, trigger, reason? }`

#### Scenario: capability_layer.refreshed 事件

- **GIVEN** 能力層刷新完成（clear cache + 重讀）
- **WHEN** refresh 流程結束
- **THEN** 發送 `capability_layer.refreshed` event：
  - `payload: { sessionID, epoch, layers: ["agents_md", "driver", "skill_content", "enablement"], pinnedSkills: [...] }`
- **AND** dashboard「已載技能」面板可由此訂閱更新

#### Scenario: 無限 refresh 迴圈的 anomaly

- **GIVEN** 在 1 秒內同 session 的 bumpEpoch 被呼叫 > 5 次
- **WHEN** 第 6 次 bumpEpoch 發生
- **THEN** 發送 anomaly event `eventType: "session.rebind_storm"`，anomalyFlags 含 `rebind_storm`
- **AND** 下一次 bumpEpoch 在 5 秒內被 rate-limit rejected

## Acceptance Checks

1. 舊 session 打開（UI 切到已存在的 session）→ dashboard 「已載技能」在 < 2 秒內顯示 `plan-builder` pinned，無須使用者送訊息
2. 編輯 `~/.config/opencode/AGENTS.md` → `/reload` → 下一輪 LLM 對話的 system prompt 含新 AGENTS.md 內容
3. 同 session 從 claude 切到 codex → 新 provider 第一句對話就看到最新 AGENTS.md（而非切換前 cache 的舊版）
4. AI 呼叫 `refresh_capability_layer({reason: "test"})` → tool 返回 epoch 遞增，event 記錄 reason
5. 偽造 `POST /session/:id/resume` 非 UI 來源 → 403 拒絕，anomaly event 出現
6. 無限 bumpEpoch 測試：1 秒內連續 6 次呼叫 → 第 6 次 rejected，anomaly 發出
7. 所有 Scenario 在 `bun test` 通過；dashboard manual verification 通過
8. `plan-validate.ts specs/session-rebind-capability-refresh/` 在 `planned` 與 `verified` 目標均通過
