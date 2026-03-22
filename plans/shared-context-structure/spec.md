# Spec: Shared Context Structure

## Purpose

定義 session-level 的 shared context space 行為契約：一個結構化、增量更新的知識表面，同時服務 main session 的記憶壓縮與 subagent 的知識注入。

---

## Requirements

### R1: Shared Context Space 是 session 的結構化知識表面

每個 main session SHALL 擁有一個 shared context space，以結構化文件形式維護該 session 到目前為止累積的知識。

#### Scenario: 新 session 開始

- **GIVEN** 使用者發起新對話
- **WHEN** 第一個 assistant turn 完成
- **THEN** 系統 SHALL 建立該 session 的 shared context space
- **AND** space 內容 SHALL 至少包含：goal、已讀檔案索引、已執行的操作摘要

#### Scenario: session 沒有任何 tool 呼叫

- **GIVEN** assistant turn 只有純文字回覆，沒有 tool call
- **WHEN** turn 完成
- **THEN** shared context space 可以不更新（無新知識產生）

### R2: Shared Context Space 增量更新

系統 SHALL 在每個 assistant turn 完成後，將該 turn 產生的新知識增量寫入 shared context space。

#### Scenario: assistant turn 讀了 3 個檔案

- **GIVEN** assistant turn N 執行了 3 次 `read` tool call
- **WHEN** turn N 完成
- **THEN** shared context space 的 Files 區塊 SHALL 新增這 3 個檔案的 path + line count
- **AND** 若 assistant 文字中有針對這些檔案的分析，SHALL 附上摘要

#### Scenario: assistant turn 做了 edit 操作

- **GIVEN** assistant turn N 執行了 `edit` tool call
- **WHEN** turn N 完成
- **THEN** shared context space 的 Actions 區塊 SHALL 記錄：哪個檔案、什麼性質的修改

#### Scenario: assistant turn 產生重要決策

- **GIVEN** assistant 文字中包含分析結論或決策
- **WHEN** turn 完成
- **THEN** shared context space 的 Discoveries/Decisions 區塊 SHALL 記錄這些結論

### R3: Subagent 知識注入（同步）

系統 SHALL 在 dispatch subagent 時，將當前 shared context space 注入 subagent 的首條 user message。此操作為同步，是 dispatch 的一部分。

#### Scenario: Orchestrator 讀了多個檔案後委派 coding subagent

- **GIVEN** shared context space 已記錄 5 個已讀檔案和分析結論
- **WHEN** orchestrator 呼叫 `task` tool 委派 coding subagent
- **THEN** subagent 首條 message SHALL 包含完整的 shared context snapshot
- **AND** subagent SHALL 能據此決定哪些檔案不需要重讀

#### Scenario: shared context space 為空

- **GIVEN** session 剛開始，shared context space 尚未建立
- **WHEN** dispatch subagent
- **THEN** 系統 SHALL 不注入 shared context（不產生額外 token 消耗）

#### Scenario: session_id continuation

- **GIVEN** task tool 使用 `session_id` 繼續已有 subagent session
- **WHEN** dispatch
- **THEN** 系統 SHALL 不重複注入 shared context

### R4: Idle Compaction — Turn 邊界的提前壓縮

當 assistant turn 包含 task dispatch 時，系統 SHALL 在 turn 完成後（turn 邊界）評估 context 使用率，決定是否提前執行 compaction。

#### 行為模型

```
turn N 完成（包含 task dispatch）
  │
  ├─ SharedContext.updateFromTurn()
  │
  └─ idle compaction 評估（同步，turn 邊界）
       ├─ utilization < threshold → 跳過（不值得壓）
       └─ utilization ≥ threshold → 執行 compaction
            使用 shared context 作為 summary
            同步重寫 message chain
            不呼叫 compaction agent
```

- Compaction 必須在 **turn 邊界同步執行**——message chain 正被 prompt loop 使用時不能修改
- 門檻判斷仍在：utilization 低時跳過，避免不必要的 I/O

#### Scenario: Task dispatch 後 utilization 低（跳過 compaction）

- **GIVEN** assistant turn 包含已完成的 task dispatch
- **AND** 當前 context 使用率為 35%（低於門檻）
- **WHEN** turn 完成，idle compaction 在 turn 邊界評估
- **THEN** 系統 SHALL 跳過 compaction（不值得壓）
- **AND** main session messages 保持不變

#### Scenario: Task dispatch 後 utilization 高（執行 compaction）

- **GIVEN** assistant turn 包含已完成的 task dispatch
- **AND** 當前 context 使用率為 72%（高於門檻）
- **WHEN** turn 完成，idle compaction 在 turn 邊界評估
- **THEN** 系統 SHALL 使用 shared context space 作為 compaction summary
- **AND** 不呼叫 compaction agent（省掉 LLM call）
- **AND** 舊的 message history SHALL 被標記為 compacted
- **AND** 下一 turn 從 compacted chain 開始

#### Scenario: Task dispatch 但 shared context 為空

- **GIVEN** assistant turn 包含已完成的 task dispatch
- **AND** shared context 為空（首次 turn 直接 dispatch）
- **WHEN** turn 完成，idle compaction 在 turn 邊界評估
- **THEN** 跳過 idle compaction（無 summary 可用）

### R4.1: Overflow Compaction 整合

現有的 overflow compaction（context 超出 usable budget）仍然保留，但優先使用 shared context：

#### Scenario: Overflow 且 shared context 有內容

- **GIVEN** session token 使用量超過 usable budget
- **AND** shared context space 有內容
- **WHEN** overflow compaction 觸發
- **THEN** 系統 SHALL 使用 shared context 作為 summary（不呼叫 compaction agent）

#### Scenario: Overflow 且 shared context 為空

- **GIVEN** session token 使用量超過 usable budget
- **AND** shared context space 為空
- **WHEN** overflow compaction 觸發
- **THEN** 系統 SHALL 降級為現有 compaction agent 行為

#### Scenario: Compaction 後 main session 繼續工作

- **GIVEN** compaction 完成（無論是 idle 或 overflow）
- **WHEN** main session 繼續下一 turn
- **THEN** main session SHALL 從 shared context space 恢復工作脈絡
- **AND** 後續 turns 繼續增量更新 shared context space

### R4.2: Compaction 門檻可配置

- `config.compaction.opportunisticThreshold`（預設 0.6）控制 idle compaction 的使用率門檻
- 設為 `1.0` 等同於停用 idle compaction（只在 overflow 時使用 shared context）
- 設為 `0.0` 等同於每次 dispatch 空檔都 compact

### R5: Shared Context Space 的 Budget 管理

Shared context space 自身 SHALL 有 token budget 控制，避免無限膨脹。

#### Scenario: shared context 超出 budget

- **GIVEN** shared context space 累計超過 budget（預設 8192 tokens）
- **WHEN** 下一次增量更新
- **THEN** 系統 SHALL 對最舊的條目進行進一步壓縮（例如：合併同類型條目、移除最舊的低優先級條目）
- **AND** 截斷處 SHALL 記錄 `[{N} earlier entries consolidated]`

### R6: Shared Context Space 的結構

Shared context space SHALL 採用以下固定結構：

```
## Goal
{使用者目標的一句話摘要}

## Files
{已讀/已改的檔案索引，每行：path (lines) — 用途/摘要}

## Discoveries
{分析過程中發現的重要事實}

## Actions Taken
{已完成的操作摘要}

## Current State
{目前進行到哪裡、下一步是什麼}
```

每個區塊 SHALL 支援增量 append 和整體 replace 兩種更新模式。

### R7: Telemetry

系統 SHALL 在現有 telemetry 基礎上增加：

- `sharedContextTokens: number` — shared context space 目前大小
- `sharedContextEntries: number` — 條目數
- `sharedContextUpdates: number` — 本 session 累計更新次數

### R8: 向後相容與降級

- 現有的 position-based prune（`PRUNE_PROTECT` / `PRUNE_MINIMUM`）SHALL 保留
- Shared context space 不可用時（例如首次 turn、config 停用），SHALL 降級為現有 compaction 行為
- `config.compaction.sharedContext` 設為 `false` 可完全停用，回退到現有 free-form compaction
