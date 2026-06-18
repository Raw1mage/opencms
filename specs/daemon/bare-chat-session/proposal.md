# Proposal: bare_chat_session

## Why

- 外部 app（首例 cecelearn 兒童中文學習）想借用 opencode daemon 已建好的對話能力——provider 抽象、帳號池、rotation3d、429 failover、token refresh——用 Claude OAuth 訂閱省成本，而不必自己持有 LLM 憑證或重造一套輪替引擎。
- 但現有 message API 的 top-level session 會把 opencode 自身的人格堆疊（AGENTS.md + SYSTEM.md driver + agent prompt + IDENTITY REINFORCEMENT）疊加到每一輪的 system prompt 上（證據：`packages/opencode/src/session/llm.ts:780-854` 的 `buildStaticBlock` 七層組裝）。外部 app 拿不到「只有自己 system prompt」的乾淨對話——小雞老師人格會被 orchestrator 指令稀釋。
- 因此需要一種「bare / passthrough session」：對 `buildStaticBlock` 只開 `userSystem` 層，清零其餘層。此清零機制已存在（`llm.ts:871-886` 為 codex upstream wire 建了一個 `driverOnlyBlock`，把 agent/agentsMd/userSystem/systemMd/identity 全清成空字串）——本案是它的鏡像反向（只留 userSystem）。

## Original Requirement Wording (Baseline)

- 「opencode開sock讓cecelearn打request應該是最少工程之路吧？」
- 「cecelearn不要管登入。daemon有什麼就用什麼。cecelearn只是daemon上的一個session」
- 「system prompt和tool injection應有獨立driver不跟opencms混用」
- 「這表示opencode要實作一種特殊session，有獨立的system prompt和driver。」
- 「優先接claude說話」

## Requirement Revision History

- 2026-06-18: initial draft created via plan-init.ts
- 2026-06-18: 經四輪可行性查證收斂。否決路徑：(a) 直接讀 accounts.json（沒 Claude family、Codex 是會過期的訂閱 OAuth、Gemini key 與現用同一把）；(b) 蒸餾 provider-codex 進 cecelearn standalone（codex tool_choice 寫死 auto，結構化輸出無法強制）。定案路徑：opencode daemon 加 bare session + cecelearn 走 unix socket client。

## Effective Requirement Description

1. opencode daemon 提供一種 session 變體（bare/passthrough），其 system prompt **僅**由呼叫端提供的 `input.system` 組成，清零 driver / agent / AGENTS.md / SYSTEM.md / identity 層。
2. 該 session 透過現有 unix socket（同機免認證）建立與發訊：`POST /api/v2/session`、`POST /api/v2/session/{id}/message`。
3. 該 session 支援 `format: json_schema` 結構化輸出（→ 合成 StructuredOutput tool + toolChoice `required`），且在 Claude provider 上能強制生效。
4. 該 session 走帳號池（省略 `model` → rotation3d）或指定 provider/family（首選 anthropic/Claude OAuth 訂閱）。
5. 該 session 不掛 opencode 內建工具、不觸發 autorun / plan-builder continuation——純一問一答。
6. 憑證與登入由 daemon 既有機制處理；呼叫端完全不碰憑證（cecelearn 不管登入）。

## Scope

### IN

- opencode daemon 新增 bare session 觸發機制（session flag 或 reserved agent name，designed 階段定）。
- `buildStaticBlock` / system 組裝路徑：bare 模式只保留 userSystem 層。
- bare session 的工具閘：只允許 `format:json_schema` 的 StructuredOutput tool，排除內建工具。
- bare session 的 continuation 閘：不觸發 autorun / 自主 continuation。
- 既有 unix socket 路徑的相容性（不破壞現有 serve API 行為）。
- fail-fast：bare 模式下若被要求注入非 userSystem 層，明確報錯而非 silent 疊加。

### OUT

- cecelearn 端的 socket client、Codex/Claude chat provider 介面、intent schema 對應（另記 cecelearn repo 的 spec）。
- Claude 帳號 OAuth 登入流程（使用者手動 `opencode auth login` → anthropic → Subscription）。
- codex provider 的結構化輸出強制（已證實 tool_choice 寫死 auto，協議限制，本案不碰）。
- 多租戶、速率限制、認證強化（bare session 僅供同機 unix socket 信任邊界）。

## Non-Goals

- 不改 rotation3d / 帳號池本身——bare session 重用既有輪替。
- 不為 bare session 設計持久化對話歷史；呼叫端自管歷史（cecelearn useConversation 已自管）。
- 不解決 codex 的結構化輸出限制（OpenAI 訂閱後端協議現實，非 opencode 可控）。
- 不改 message API 既有 top-level / subagent session 的人格堆疊行為。

## Constraints

- **天條 #11 禁 silent fallback**：bare 模式被要求清零的層若意外被注入，必須 fail-fast。
- **天條 #13 不重造輪子**：重用既有 `buildStaticBlock` 的 layer-zeroing 機制（`llm.ts:871-886`），不另寫 system 組裝。
- **不動語音核心 / provider 內部**：不改 provider-claude / provider-codex 的請求構造邏輯。
- **daemon 生命週期權威**：開發後生效走 `restart_self`，禁止 AI 自行 spawn/kill daemon。
- **結構化輸出 provider 依賴**：bare session 的 `format:json_schema` 只在尊重 toolChoice:required 的 provider（Claude/Gemini/OpenAI API-key）上強制；codex 上會降級（已知限制，需在 errors/observability 標明）。

## What Changes

- daemon 新增 bare session 概念 + 觸發點。
- system prompt 組裝路徑（`llm.ts` buildStaticBlock 呼叫處）新增 bare 分支：只開 userSystem。
- 工具解析 / continuation 邏輯辨識 bare session 並跳過內建工具與自主推進。

## Capabilities

### New Capabilities

- bare/passthrough session: 外部同機 app 可開一個「只有自己 system prompt」的乾淨對話 session，借 daemon 帳號池與 Claude 結構化輸出能力。

### Modified Capabilities

- system prompt 組裝: 新增「只開 userSystem 層」模式（既有 layer-zeroing 機制的鏡像）。
- session 工具/continuation 閘: 辨識 bare session 並降載（無內建工具、無 autorun）。

## Impact

- 受影響碼：`packages/opencode/src/session/llm.ts`（buildStaticBlock 呼叫 + system 組裝）、`packages/opencode/src/session/prompt.ts`（session 解析、tools/continuation 閘、format 處理）、可能涉及 session create/message 的 schema（`message-v2.ts`、server route）。
- 受影響 API：`POST /api/v2/session`、`POST /api/v2/session/{id}/message`（新增 bare 觸發欄位或 reserved agent）。
- 下游消費者：cecelearn 後端（另案）。
- 文件：opencode `specs/architecture.md` 的 session / prompt-assembly 段落需同步。
- 操作者：bare session 為同機 unix socket 信任邊界，需在文件標明不可暴露於非信任網路。
