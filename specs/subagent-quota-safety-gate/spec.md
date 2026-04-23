# Spec: system-manager-quota-observability

## Purpose

為 AI（尤其 subagent）提供一組純讀取的 MCP tool，讓它能主動觀測「當前這個 session 所用帳號」的 quota 狀況，以及（給主 agent / admin）跨 family 的 rotation 全景。Tool 不做決策、不改狀態；AI 看見數字後自己判斷要不要收斂或 handover。

---

## Requirements

### Requirement: `get_my_current_usage` tool 存在且為純讀取

**Purpose**: Subagent / 主 agent 能以最低噪音查到「我現在這個 session 用的帳號還剩多少 5H / WK 額度」。

#### Scenario: Codex subagent 主動自查
- **GIVEN** subagent 綁定到 codex/openai family 的某個 pinned account
- **AND** session info.json 已有 `execution.accountId`
- **WHEN** subagent 呼叫 `system-manager:get_my_current_usage`（不帶參數）
- **THEN** 回傳 payload 包含 `provider: "codex"`、`family: "openai"`、`accountId`、`usage.fiveHourPercent`、`usage.weeklyPercent`、`usage.nextResetAt`、`cachedAt`、`ageSeconds`
- **AND** 回傳的 `accountId` 等於 session info.json 的 `execution.accountId`（不是 `accounts.json.families.openai.activeAccount`）
- **AND** 回傳不包含其他 family 或其他帳號的資料

#### Scenario: Provider 不支援用量查詢
- **GIVEN** 當前 session 綁到一個無 usage endpoint 的 provider（如 anthropic、gemini）
- **WHEN** AI 呼叫 `get_my_current_usage`
- **THEN** 回傳 `{ supported: false, provider, reason: "provider does not expose usage endpoint" }`
- **AND** **不得**回傳空 `usage` 物件或 null — 必須明確標示 not supported（「禁止靜默 fallback」）

#### Scenario: Session 無 pinned execution identity
- **GIVEN** session 尚未發過任何 inflight request，`execution.accountId` 為空
- **WHEN** AI 呼叫 `get_my_current_usage`
- **THEN** 回傳 `{ supported: false, reason: "no pinned execution identity for this session" }`
- **AND** **不得**退回讀 `accounts.json.activeAccount`（那是 UI 選的，不是 rotation 實際用的）

#### Scenario: Cache 新鮮度顯式回傳
- **GIVEN** 最近一次呼叫 codex usage endpoint 發生於 T 秒前
- **WHEN** AI 呼叫 `get_my_current_usage`
- **THEN** 回傳包含 `cachedAt`（ISO-8601）與 `ageSeconds`（整數）
- **AND** 若 `ageSeconds > quotaCacheTtlSeconds`（tweaks.cfg 設定），tool 主動刷新後再回
- **AND** 若 `ageSeconds <= quotaCacheTtlSeconds`，直接回 cached 值，**不**打 OpenAI API

#### Scenario: Tool description 帶 heuristic 使用時機
- **GIVEN** MCP client 載入 system-manager tools
- **WHEN** 讀取 `get_my_current_usage` 的 description 欄位
- **THEN** description 包含語意線索：「在長任務中定期檢查」「連續大量 tool call 後」「感覺 provider 回應變慢時」
- **AND** description 明示「純讀取、不會改變帳號或 rotation 狀態」

---

### Requirement: `get_system_status` 擴充 inflight 與新鮮度欄位

**Purpose**: 主 agent / admin / 使用者想看全景時，能區分「UI 選的帳號」與「rotation 此刻用的帳號」，並知道資料多舊。

#### Scenario: `currentInflightAccount` 與 `selectedAccount` 分離
- **GIVEN** 某 family 的 `accounts.json.activeAccount = "A"`
- **AND** 某 session 的 `execution.accountId = "B"`（rotation 在該 session 選了不同的帳號）
- **WHEN** 呼叫 `get_system_status` 並帶 `sessionID`
- **THEN** 該 family 的回傳同時包含 `selectedAccount: "A"` 與 `currentInflightAccount: "B"`
- **AND** 當 `sessionID` 未提供時，`currentInflightAccount` 欄位值為 `null`（不猜測、不 fallback 到 selectedAccount）

#### Scenario: Usage 物件帶 cachedAt / ageSeconds
- **GIVEN** 某帳號的 usage 資料
- **WHEN** 呼叫 `get_system_status`
- **THEN** 每個帳號的 `usage` 物件（若有）包含 `cachedAt` 與 `ageSeconds`
- **AND** TTL 過期的帳號 usage 會在回應前被刷新

---

### Requirement: Read-only 保證在實作層面硬鎖

#### Scenario: 兩個 tool 不 import 任何寫入介面
- **GIVEN** `get_my_current_usage` 或 `get_system_status` 的實作檔
- **WHEN** static 檢查 import 清單
- **THEN** 不存在對 rotation3d 寫入函式（`markRateLimited`、`updateQuotaCache`、`forceRotate` 等）的 import
- **AND** 不存在對 accounts.json 的 `fs.writeFile` / `fs.rename` 呼叫

---

### Requirement: 不 hammer OpenAI usage endpoint

#### Scenario: TTL 內多次呼叫共享 cache
- **GIVEN** `quota.cache_ttl_seconds = 60`
- **AND** T=0 時一次呼叫打了 live API、結果寫入 cache
- **WHEN** T=30 時第二次呼叫
- **THEN** 第二次**不**打 live API，直接回 cache 值
- **AND** 第二次回應的 `ageSeconds ≈ 30`

#### Scenario: TTL 可調
- **GIVEN** tweaks.cfg 設定 `quota.cache_ttl_seconds`
- **WHEN** 未設定時
- **THEN** 使用預設值 60 秒
- **AND** 設定值應與 rate-limit 狀況平衡（太小會 hammer、太大 AI 看到的永遠過時）

---

## Acceptance Checks

- [ ] 新 tool `get_my_current_usage` 在 MCP client 列表中可見，description 含 heuristic
- [ ] Subagent 在獨立 session 呼叫可拿到自己的 pinned account 的用量（非父 session 的）
- [ ] `get_system_status` 帶 `sessionID` 時 `currentInflightAccount` 準確；不帶時為 null
- [ ] Cache TTL 行為符合 §「不 hammer」的兩個 scenario
- [ ] Provider not supported 情境回明確錯誤，不 silently fallback
- [ ] 兩個 tool 的實作檔 import 清單通過 read-only 靜態檢查
