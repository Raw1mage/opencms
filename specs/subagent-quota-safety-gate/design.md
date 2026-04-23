# Design: system-manager-quota-observability

## Context

`packages/mcp/system-manager/src/index.ts` 是一個 stdio MCP server，對外提供 25+ 個管理類 tool。其中 `get_system_status` 已暴露 rotation 狀態（`rotation-state.json`）、codex 5H/WK usage（live API）、RPM/RPD 統計（`usage-stats.json`）。但目前無法區分「UI 選的帳號」與「rotation 當次 inflight 選的帳號」，且 `getCodexUsage()` 每次呼叫都打 live API，沒有 cache、沒有 timestamp。

同時，Session 的 `execution.accountId`（pinned rotation 結果）已持久化在 `~/.local/share/opencode/storage/session/{sessionID}/info.json`（由 [processor.ts:463-470](packages/opencode/src/session/processor.ts#L463-L470) 的 `pinExecutionIdentity()` 寫入），但 MCP tool 層沒有機制知道「是哪個 session 呼叫我」。

## Goals / Non-Goals

### Goals

- AI（特別是 subagent）能以單一 tool 呼叫拿到「我這個 session 現在用的帳號的用量」
- 主 agent / admin 透過 `get_system_status` 能看見 `selectedAccount` vs `currentInflightAccount` 的差別
- 不增加 OpenAI usage endpoint 的壓力；cache staleness 對 AI 顯性
- Read-only 保證在 import 層面硬鎖

### Non-Goals

- 不重構 rotation3d 本身（request-gated → background ticker 留給 `process-liveness-contract`）
- 不新增「自動 handover」邏輯（先給眼睛，行為層晚點再設計）
- 不改 `accounts.json` / rotation-state.json 的寫入路徑
- 不為非 codex/openai provider 發明 usage 機制（它們回 `not supported`）

## Decisions

- **DD-1** Inflight 帳號的 source-of-truth = session info.json 的 `execution.accountId`（由 [processor.ts:463-470](packages/opencode/src/session/processor.ts#L463-L470) `pinExecutionIdentity()` 持久化）。MCP tool 以 `sessionID` 反查該檔案，**不**另建 in-memory cache。
  - Rationale：這是 rotation3d 唯一已持久化、跨行程可見的「誰在用誰」contract。另建 cache 會與 rotation 寫入時序競爭。

- **DD-2** MCP tool 透過 **opencode MCP bridge 自動注入 `sessionID`** 進 tool args，LLM 不需要知道也不需要傳。
  - 改動點：[packages/opencode/src/mcp/index.ts:142-158](packages/opencode/src/mcp/index.ts#L142-L158) 的 `dynamicTool()` 包裝層，在呼叫 `client.callTool()` 前把當前 session 的 sessionID 併入 args。
  - Rationale：LLM 不穩定 — 要它自己帶 sessionID 一定會漏。Bridge 層注入對 LLM 完全透明，也保留「tool 仍可接受顯式 sessionID 覆寫」的彈性（admin UI 帶 sessionID 查別人的 session）。
  - Scope：僅針對 system-manager 這支 MCP server；不改 HTTP MCP transport。

- **DD-3** 新增本地 quota cache，key `codex:{accountId}`，value `{ fiveHourPercent, weeklyPercent, nextResetAt, cachedAt }`。存放於 `~/.config/opencode/quota-cache.json`（獨立於現有 `usage-stats.json`，職責不同）。
  - TTL 由 tweaks.cfg `quota.cache_ttl_seconds` 控制，預設 60 秒。
  - 讀路徑：`getCodexUsage()` 先查 cache，若 `ageSeconds > ttl` 才打 live API 並寫回 cache。
  - Rationale：目前 `getCodexUsage()` 每次打 live API（[system-manager/index.ts:261](packages/mcp/system-manager/src/index.ts#L261)），若 AI 按 heuristic 每幾個 tool call 查一次會直接 hammer OpenAI。60s TTL 在「即時性」與「配額健康」間取平衡。

- **DD-4** `get_system_status` 新增 optional input param `sessionID?: string`。有提供時，每個 family 的回傳加 `currentInflightAccount`（從 session.execution.accountId 推出）；未提供時該欄位為 `null`。
  - **不**自動從 bridge 注入 — 因為 `get_system_status` 的語意是「系統級全景」，有些呼叫端（admin UI）不綁單一 session。

- **DD-5** Provider quota probe 透過 account manager 暴露的 `AccountQuotaProbe` 介面分派。
  ```ts
  interface AccountQuotaProbe {
    probe(accountId: string): Promise<{ fiveHourPercent: number; weeklyPercent: number; nextResetAt: string } | { supported: false; reason: string }>
  }
  ```
  Codex/OpenAI 實作該介面包裝 `getCodexUsage`；其他 provider 回 `{ supported: false }`。MCP tool 只做 registry dispatch。
  - Rationale：遵守 `feedback_provider_boundary.md` — MCP 層不內嵌 provider-specific 邏輯。

- **DD-6** Tool description 內嵌 heuristic：
  ```
  get_my_current_usage: Check remaining quota (5-hour and weekly) for the account your current session is using. Pure read — does not change any rotation or account state. Recommended to call periodically during long tasks, after bursts of heavy tool calls, or when provider responses feel unusually slow, so you can proactively summarize and request handover before hitting exhaustion.
  ```
  - Rationale：AI 看 schema 就知道何時用；不完全依賴 SYSTEM.md 被讀到。

- **DD-7** Read-only 硬鎖：quota tool 實作檔的 import allow-list 在 CI / lint 階段強制（或至少以 unit test 斷言 import 清單）。禁止 import：`markRateLimited`、`updateQuotaCache`（寫入版本）、`forceRotate`、`accounts.json` 的任何 `fs.writeFile` 路徑。
  - Rationale：`feedback_destructive_tool_guard.md` 的教訓 — 光靠註解或命名不夠。

## Risks / Trade-offs

- **R-1** Bridge 注入 sessionID 可能在某些邊界情境（initialize 階段、admin UI 無 session 呼叫）失敗。→ 處理：若 bridge 取不到 sessionID，不注入，tool 走「沒 pinned identity」分支回 `supported: false`。不 throw。
- **R-2** quota-cache.json 與 rotation-state.json 之間可能出現「rotation 剛切號但 quota cache 仍是舊號」的瞬時不一致。→ 處理：cache key 以 `accountId` 為粒度，rotation 切號後 `execution.accountId` 變動，下次查自然落到新 key — 不會跨號污染。
- **R-3** 若 OpenAI usage endpoint 自己在某個 TTL 內 cache，我們再疊一層 60s 等於看到「過時的過時」。→ 接受；ageSeconds 欄位讓 AI 自己判斷。
- **R-4** Subagent 的 sessionID（子 session）跟父 session 不同 — 要確保 bridge 注入的是**執行當下**那個 session 的 ID，不是對話起點的。→ 處理：注入點在 `dynamicTool()` 包裝執行時，從 request context 取 sessionID，非從啟動時快取。

## Critical Files

- [packages/mcp/system-manager/src/index.ts](packages/mcp/system-manager/src/index.ts) — 新增 `get_my_current_usage`、擴充 `get_system_status`
- [packages/opencode/src/mcp/index.ts](packages/opencode/src/mcp/index.ts) — bridge sessionID 注入（dynamicTool 包裝層，約 L142-158）
- [packages/opencode/src/session/processor.ts](packages/opencode/src/session/processor.ts) — 已有 `pinExecutionIdentity()`，**不改**，只讀
- [packages/opencode/src/session/index.ts](packages/opencode/src/session/index.ts) — `ExecutionIdentity` schema（L211-218），**不改**
- `packages/opencode/src/account/` — 新增 `quota-probe.ts`（`AccountQuotaProbe` 介面 + codex 實作 + registry）
- [templates/prompts/enablement.json](templates/prompts/enablement.json) + `packages/opencode/src/session/prompt/enablement.json` — 新 tool 預設啟用
- `/etc/opencode/tweaks.cfg` — 新增 `quota.cache_ttl_seconds`（預設 60）
- `~/.config/opencode/quota-cache.json` — 新 cache 檔（runtime state）

## Data Flow

```
Subagent LLM
    │
    │ call "get_my_current_usage" (no args)
    ▼
MCP bridge (packages/opencode/src/mcp/index.ts dynamicTool)
    │
    │ inject { sessionID: <current session> } into args
    ▼
system-manager MCP (get_my_current_usage handler)
    │
    │ read session info.json → execution.accountId
    ▼
AccountQuotaProbe registry.get(providerId).probe(accountId)
    │
    │ check quota-cache.json[codex:{accountId}]
    │   │
    │   ├─ fresh (ageSeconds <= TTL) → return cached
    │   └─ stale → fetch live API → write cache → return
    ▼
Response to LLM: { provider, family, accountId, usage{...}, cachedAt, ageSeconds }
```

## Open Questions for Implementation Phase

- `AccountQuotaProbe` registry 放在 `account/` 還是 `provider/`？兩處都有道理；傾向 `account/` 因為 probe 是針對 account 而非 provider dispatch。
- Tool unit test 怎麼模擬「某個 session 的 pinned identity」？可能要 temp dir + fake session info.json。
- 若未來 Anthropic 推出 usage endpoint，擴充路徑是加 `AnthropicQuotaProbe` 實作，不需改 tool — 驗證此 DD-5 設計。
