# Spec: subagent-quota-safety-gate

## Purpose

防止 subagent 把 pinned account 的 5H / weekly quota 燒盡：runtime 在 subagent 每輪 tool-call 邊界檢查剩餘額度，低於門檻（預設 5%）即強制終止該 subagent，並以 SharedContext + runtime 自動產的結構化摘要回給 parent。

觀測 tool（`get_my_current_usage` + `get_system_status` 擴充）為附屬功能，服務主 agent / 早期自查用途 — **不是主線防護機制**。

---

## Requirements

### Requirement: Runtime quota gate 在 subagent tool-call 邊界強制檢查

**Purpose**：subagent 不能因為自己不自律就把帳號燒穿。

#### Scenario: 門檻內，subagent 正常執行
- **GIVEN** subagent pinned 到 codex `acc_42`，5H 剩 12%、weekly 剩 40%
- **AND** `subagent.quota_gate_enabled = true`、`threshold = 5`
- **WHEN** subagent 結束一輪 tool-call 準備發下一筆 provider request
- **THEN** gate 讀 quota cache → 兩個 window 都 > 5%
- **AND** subagent 正常繼續下一輪

#### Scenario: 5H 跌破門檻，gate 觸發
- **GIVEN** subagent pinned 到 `acc_42`，5H 剩 3%
- **WHEN** subagent 結束一輪 tool-call 準備發下一筆 provider request
- **THEN** gate trip：runtime 以 `CancelReason = "quota-gate-trip"` 終止 subagent runloop
- **AND** subagent 的 LLM **不再**有機會發任何請求
- **AND** task tool 對 parent 的回傳包含 `{tripped: true, reason: "quota-gate-trip", triggerWindow: "5h", remainingPercent: 3, sharedContext, structuredSummary}`

#### Scenario: Weekly 跌破門檻也觸發
- **GIVEN** 5H 還有 80% 但 weekly 剩 4%
- **WHEN** 同上
- **THEN** gate trip，`triggerWindow: "weekly"`，其餘行為同上

#### Scenario: 兩個 window 都跌破，取更嚴重的回報
- **GIVEN** 5H 剩 2%，weekly 剩 3%
- **WHEN** 同上
- **THEN** gate trip，`triggerWindow: "5h"`（較低者）、`remainingPercent: 2`

#### Scenario: Gate 關閉時不攔
- **GIVEN** `subagent.quota_gate_enabled = false`
- **WHEN** 即使 5H 剩 1%
- **THEN** gate 不觸發；但 runtime log 寫 `[quota-gate] disabled, would-have-tripped acc_42 5h=1%`（方便事後追）

#### Scenario: Quota 查不到時採「寧縱勿誤殺」
- **GIVEN** 當前 subagent 的 provider 無 `AccountQuotaProbe` 實作，或 cache 從未填過
- **WHEN** gate 檢查
- **THEN** gate **放行**（subagent 繼續跑）
- **AND** runtime log 寫 `[quota-gate] WARN cannot probe quota for {provider}:{accountId}, letting subagent proceed`
- **AND** log 等級為 WARN（不是 DEBUG），使用者 tail log 看得到

---

### Requirement: Gate 適用範圍限 task-tool-spawned subagent

#### Scenario: Root session 不被攔
- **GIVEN** 一個根 session（使用者直接對話的）5H 剩 2%
- **WHEN** 該 session 要發請求
- **THEN** gate **不**觸發 — 根 session 不在 gate 範圍
- **AND** 行為回到現有 rotation3d / UI 顯示路徑

#### Scenario: 非 task-tool 來源的 non-root session 不被攔
- **GIVEN** 透過 MCP `manage_session create` 開的新 session（非 task tool spawn）5H 剩 2%
- **WHEN** 該 session 要發請求
- **THEN** gate **不**觸發
- **AND** 行為同 root session

#### Scenario: 判斷來源的依據
- **GIVEN** 任何 session
- **WHEN** gate 檢查要不要管這個 session
- **THEN** 以 session.parentSessionID 存在且 spawn source 為 task tool 為準（具體欄位由 design.md 決定）

---

### Requirement: Structured summary 由 runtime 自動生成

**Purpose**：不依賴 LLM 臨終寫字。

#### Scenario: 標準內容
- **GIVEN** gate trip
- **WHEN** runtime 產生 structured summary
- **THEN** 包含至少：
  - `reason`: "quota-gate-trip"
  - `triggerWindow`, `remainingPercent`
  - `completedToolCalls[]`: 已完成的 tool call 列表（name、args 摘要、結果成功/失敗）
  - `readFiles[]`: subagent 讀過的檔案路徑（從 tool call 歷史掃）
  - `editedFiles[]`: subagent 編輯過的檔案路徑
  - `lastMessages[]`: 最後 N 則 assistant message（預設 N=3，取文字內容摘要，不含 thinking）
  - `pendingWork[]`: 若 subagent 的 TodoWrite 有 in_progress / pending item，列出（best-effort，沒 TodoWrite 就空陣列）
- **AND** 所有欄位由 runtime 從 SharedContext / session messages 機械掃出，**不**呼叫 LLM

#### Scenario: Summary 不爆量
- **GIVEN** subagent 已執行 200 個 tool call
- **WHEN** runtime 產生 summary
- **THEN** `completedToolCalls` 截斷到最後 20 筆（其餘摘要為 `"... and 180 earlier calls"`）
- **AND** `readFiles` / `editedFiles` 以 unique path 去重
- **AND** `lastMessages` 每則截斷到 500 字（或 tweaks.cfg 可調）

---

### Requirement: Handover 沿正常 task-tool-result 路徑

#### Scenario: Parent 收到結構化中止結果
- **GIVEN** gate trip
- **WHEN** parent 的 task tool 呼叫從 await 回來
- **THEN** tool result payload 是結構化的：
  ```json
  {
    "tripped": true,
    "reason": "quota-gate-trip",
    "triggerWindow": "5h",
    "remainingPercent": 3,
    "summary": { ...structured summary... },
    "sharedContext": "..."
  }
  ```
- **AND** parent 的 LLM 看到這個 tool result 可以自己決定要重派、通知使用者、或結案
- **AND** **不**在 parent 層面自動重派（policy 留給 parent LLM / 使用者）

#### Scenario: Parent 對話本身不壞
- **GIVEN** gate trip
- **WHEN** 事件發生後
- **THEN** parent session 狀態正常，SSE 事件不中斷，UI 顯示 task tool call 正常「完成」（不顯示 error 紅字 — 這是定義內的 outcome，不是 bug）
- **AND** parent 的 UI timeline 顯示 subagent bar 以「被 quota gate 中止」標記（而非 crash）

---

### Requirement: 支援線 — 觀測 tools 保留 v1 的行為

**Purpose**：v1 所有觀測 tool 需求保留（主 agent 全景、subagent 早期自查）；僅「主線防 burn」責任從它們移出。

#### Scenario: v1 requirements 仍然成立
- **GIVEN** 這份 spec
- **WHEN** 實作
- **THEN** `get_my_current_usage` 的行為（`supported` 判定、`cachedAt` / `ageSeconds`、pinned identity 語意）完全照 proposal.md v1 描述
- **AND** `get_system_status` 擴充的 `currentInflightAccount` + usage 新鮮度欄位照 v1 描述
- **AND** Gate 與觀測 tool **共用**同一個 `AccountQuotaProbe` registry 與 `quota-cache.json`（不另建）
- **AND** Gate 與觀測 tool 共享同一個 cache TTL（`quota.cache_ttl_seconds`），確保 gate 判斷所用的數字與主 agent 觀測看到的一致

---

## Acceptance Checks

- [ ] 單元測試：subagent 5H < 5% 時 gate 觸發、cancel reason 正確
- [ ] 單元測試：gate 關閉時不觸發，但 would-have-tripped log 有寫
- [ ] 單元測試：provider 無 probe 時放行 + WARN log
- [ ] 單元測試：structured summary 從真實 tool-call 歷史產出欄位正確
- [ ] 整合測試：root session 5H 1% 不被攔（負向案例）
- [ ] 整合測試：parent 收到 task tool result，LLM 看到後可自行決定（不要斷言 LLM 行為，只驗資料到位）
- [ ] 觀測 tool acceptance 沿用 v1（get_my_current_usage 在 pinned subagent 拿到正確數字）
- [ ] tweaks.cfg 三個 knob 有 fallback defaults、能被改寫覆蓋
