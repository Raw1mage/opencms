# Proposal: system-manager-quota-observability

## Why

Subagent（以及主 agent 本身）目前對「帳號用量 / rotation 狀態」沒有任何獨立感官。唯一的資訊管道是「發 request → 拿回來 → 看 provider 報什麼」，而 rotation 決策又是 request-gated。一旦父 session 卡住不發 request（例如 2026-04-23 的 subagent-hang 事件），AI 就看不到當前帳號的 5h window 已經榨乾，也不會主動收斂或 handover — 它根本不知道外面世界已經變了。

這不是 rotation 邏輯本身壞掉，是 **AI 本身對共享 quota 狀態盲目**。即使未來把 rotation 搬成背景 ticker，AI 仍然需要一個「我現在自己能不能問一下用量」的 tool，才能做出「我該不該繼續 / 要不要主動 handover」這類只有它自己能做的判斷。

## Original Requirement Wording (Baseline)

- 「一直以來subagent一直沒有能力自己去留意用量狀況。我覺得應該要寫一個system-manager-quota tool來幫助AI」
- 後續澄清：「對，是觀測工具」

## Requirement Revision History

- 2026-04-23: initial draft created via plan-init.ts
- 2026-04-23: 使用者確認「純觀測、不含 force_rotate 寫入面」
- 2026-04-23: 使用者澄清 tool 形狀 — 單一 tool 自動偵測當前 provider/model/account 並分派；目前僅 codex/openai 有實作，其他 provider 回「not supported」而非錯誤
- 2026-04-23: 三項設計方向確認：(a) tool description 帶 heuristic 使用時機提示，(b) 回傳帶 `cachedAt` + `ageSeconds` 新鮮度欄位（stale 如實反映，禁止靜默刷新），(c) subagent 可能綁與父 session 不同帳號 — 以當次 inflight request 的 account tag 為準而非 session 綁定
- 2026-04-23: 勘查發現 `get_system_status` 已暴露 rotation / codex 5H+WK usage / cooldowns / RPM-RPD，但三個缺口：description 太中性、回傳噪音大、缺 `currentInflightAccount`。方案鎖定 **C（雙軌）**：新增薄包裝 tool `get_my_current_usage`（subagent 自查，低噪音、帶 heuristic description）+ 擴充 `get_system_status` 加 inflight 欄位（admin / 主 agent 全景觀測）

## Effective Requirement Description

1. 在 `system-manager` MCP app 底下新增一組**純讀取**的 quota / account 觀測 tools，讓任何 session（主 agent 或 subagent）能主動查詢目前帳號池的用量狀況與 rotation 現況
2. Tool 回傳資料以 AI 可直接理解的語意欄位為主（剩餘 %、距離 reset 的時間、目前輪到誰、誰被 rate-limit），而非原始 header dump
3. 不提供任何會改變 rotation 狀態、強制切號、修改 quota cache 的寫入面 — 所有決策仍由現有 rotation3d 自動策略與使用者/AI 的對話層負責
4. Tool 本身要能在「父 session 卡住」的場景下被 subagent 單獨呼叫並拿到結果 — 也就是它不能依賴父 session 的 runloop 狀態

## Scope

### IN
- **新 tool** `system-manager:get_my_current_usage` — 不吃參數，自動推當次 inflight 的 provider/model/account（非 session `selectedAccount`），只回當前帳號的用量 + `cachedAt` + `ageSeconds`；description 帶 heuristic 使用時機提示。僅 codex/openai 實作，其他 provider 回 `{supported: false, reason}`
- **擴充既有** `get_system_status` — 在每個 family 的回傳中加入 `currentInflightAccount` 欄位（區別於 `selectedAccount`），標示當次 request 實際被 rotation 選中的帳號；每個帳號的 usage 物件加上 `cachedAt` + `ageSeconds`
- 兩個 tool 都禁止內嵌 provider-specific 邏輯於 MCP 層 — 透過 account manager 暴露的統一介面分派
- Tool 描述 / schema 的寫法，讓 LLM 知道在什麼時機該主動查（例如「連續 3 個大 tool call 之後」「感覺答覆變慢時」）

### OUT
- 任何 `force_rotate` / `mark_exhausted` / `reset_quota_cache` 類的寫入 tool
- Rotation 策略本身的重構（那屬於 `process-liveness-contract` 與未來的 rotation3d 優化）
- 背景 quota ticker / 主動刷 cache（屬於 `process-liveness-contract`）
- 前端顯示 quota 的 UI（這組 tool 是給 AI 用的，不是給使用者 UI 用的 — 如果要 UI 另開）

## Non-Goals

- 不解決 rotation 本身該如何改（request-gated → background ticker 的重構放 `process-liveness-contract`）
- 不解決 2026-04-23 subagent-hang 的根因（IPC 契約重構放 `process-liveness-contract`）
- 不嘗試讓 AI 自動做「quota 到 X% 就強制 handover」的自動化行為 — 先給 AI 眼睛，行為層的 heuristic 等觀測一陣子再決定

## Constraints

- 必須跟現有 rotation3d / account manager 的資料來源對齊，**不另建獨立 cache**。若現有 cache 有 staleness 問題，tool 回傳要如實反映（例如 `cachedAt` 欄位），不是自己偷偷發 refresh
- 「禁止靜默 fallback」—— 若某 family 查不到資料（account 不存在、cache 從未填過），明確回錯誤碼，不 silently 回空陣列或假資料
- 遵守 `feedback_provider_boundary.md`：tool 不得內嵌任何 provider-specific 邏輯；所有 provider 差異由 account manager 層吸收後再暴露統一 schema
- Read-only 保證必須在 tool 實作層面硬鎖（例如不 import account manager 的寫入方法），不是靠註解

## What Changes

- `packages/mcp/system-manager/` 新增 quota / account 觀測 tool
- `packages/opencode/src/session/prompt/enablement.json` 同步（tool 預設啟用狀態）
- `templates/prompts/enablement.json` 同步
- `templates/prompts/SYSTEM.md` 或對應 prompt layer 提示 AI 這組 tool 的存在與使用時機

## Capabilities

### New Capabilities
- `get_my_current_usage`：subagent / 主 agent 能用最低噪音、最直接的方式自查「我現在用的這個帳號還剩多少」
- Tool description 層的 heuristic 引導：AI 透過 schema 就能知道何時該主動查，不必依賴 SYSTEM.md 命中

### Modified Capabilities
- `get_system_status` 區分 `selectedAccount`（UI 選的）vs `currentInflightAccount`（rotation 實際用的）
- 所有 usage 回傳欄位補上 `cachedAt` + `ageSeconds`，新鮮度對 AI 顯性
- `system-manager` MCP surface：從「session / app 管理」擴展到「account/quota 觀測」維度

## Impact

- Runtime：`packages/mcp/system-manager/src/index.ts` 新增 tool 註冊
- Account manager：暴露一組 read-only 介面供 MCP tool 呼叫（不改寫入面）
- Prompt layer：enablement + SYSTEM.md 對應條目
- 文件：`docs/events/` 紀錄；`specs/architecture.md` 在 `system-manager` 相關段落補充 quota 觀測能力
- 不影響既有 rotation3d 自動策略、不影響既有 429 處理路徑
