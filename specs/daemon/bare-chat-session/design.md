# Design: bare_chat_session

## Context

opencode daemon 已具備完整對話基礎設施：provider 抽象、帳號池（rotation3d）、429 failover、token refresh、unix socket（同機免認證）、`format:json_schema` 結構化輸出。外部同機 app（首例 cecelearn）想借此對話層，但需要「乾淨」對話——只有呼叫端自己的 system prompt，不被 opencode 人格堆疊污染。

本案在 opencode daemon 新增一種 bare/passthrough session：對 `buildStaticBlock` 只開 `userSystem` 層。此清零機制已存在（`llm.ts:871-886` 的 codex `driverOnlyBlock`），本案為其鏡像反向。

## Goals / Non-Goals

### Goals

- 提供「只有呼叫端 system prompt」的乾淨對話 session，零 opencode 人格污染。
- 重用既有帳號池 / rotation / token refresh / 結構化輸出，不重造。
- POC 階段固定 pin 單一 Claude 帳號，驗證端到端。
- 結構化輸出在 Claude 上可強制（toolChoice required）。

### Non-Goals

- 不改 rotation3d / 帳號池內部。
- 不改 provider-claude / provider-codex 請求構造。
- 不為 bare session 設計持久化對話歷史（呼叫端自管）。
- 不解 codex 結構化輸出限制（OpenAI 訂閱後端協議現實）。

## Decisions

- **DD-1 觸發機制 = reserved agent `bare` + llm.ts layer-zeroing 分支（兩者並用，缺一不可）**。原碼證據：`agent` name 只控制 agent 層（`llm.ts:827` `input.agent.prompt ?? ""`），但 AGENTS.md（`llm.ts:831`）與 SYSTEM.md（`llm.ts:833`）gated 在 `subagentSession`，非 agent name——光換 agent 名清不掉這兩層。故需在 `buildStaticBlock` 呼叫點（`llm.ts:839-854`）加一個 keyed-on-bare 的分支，明確清零 driver/agent/agentsMd/systemMd/identity，只留 userSystem，即 `driverOnlyBlock`（`llm.ts:871-886`）的鏡像。reserved agent 負責路由/權限/工具閘識別，layer-zeroing 分支負責 system 清零。

- **DD-2 system prompt 組裝 = 只留 userSystem 層**。bare 模式下 `buildStaticBlock` 的 layers = `{driver:"", agent:"", agentsMd:"", systemMd:"", identity:"", userSystem:<呼叫端 input.system>}`。沿用既有 `buildStaticBlock` 機制，不另寫組裝（天條 #13）。

- **DD-3 工具閘 = 只允許 StructuredOutput tool**。bare session 不掛 opencode 內建工具（read/edit/bash/task…）。當帶 `format:json_schema` 時，僅保留 `prompt.ts:3441-3448` 自動生成的 StructuredOutput tool；否則空工具集。message API 的 `tools` 欄位已 `@deprecated`，不走該路。

- **DD-4 continuation 閘 = bare session 不觸發 autorun / 自主 continuation**。純一問一答；不進 plan-builder continuation、不自我 nudge。bare session 應在 runLoop 的 continuation 判斷點被識別為 passthrough 並 break。

- **DD-5 結構化輸出強制 = 依賴 provider 能力，非 bare 模式保證**。`format:json_schema` → toolChoice `required`（`prompt.ts:3476-3478`）。Claude provider 尊重之 → `{type:any}`（`provider-claude/provider.ts:311-326`），結構化輸出強制生效。codex provider 寫死 `tool_choice:auto`（`provider-codex/provider.ts:104`，照搬官方 `codex-rs/core/src/client.rs:796`）→ 降級為機率性。bare session 文件須標明此 provider 依賴。

- **DD-6 帳號策略（POC）= 固定 pin 單一帳號，不走 rotation**。POC 帶 `model:{providerId:"claude-cli", modelID:"claude-opus-4-8", accountId:"claude-cli-subscription-claude-cli-d5002de6"}`（name=yeatsluo@g.ncu.edu.tw）。固定 accountId 不觸發 rotation → 無 cross-family fallback → DD-5 的結構化能力不會被帳號池偷換到 codex。`prompt.ts` 已有 pinnedAccountId / incomingModel.accountId 機制。

- **DD-7 帳號 switch 邊界（生產）= 延後到齒輪設定階段**。生產若要走帳號池（省略 model），rotation3d 的 cross-family fallback（`rotation3d.ts:260` same-family preference、跨 family fallback）可能把 Claude 撞 429 後掉到 codex → 結構化輸出靜默降級（違天條 #11）。生產階段須決定：(A) bare session 釘死 family + Claude 全掛則 fail-fast；(B) 跨 family 但回降級訊號。POC 不處理（DD-6 固定帳號已規避）。

- **DD-8 fail-fast 不 silent fallback（天條 #11）**。bare 模式被要求注入非 userSystem 層、或指定帳號不存在、或 provider 不支援強制結構化卻要求 json_schema → 明確報錯，不靜默疊加 / 不靜默降級。

- **DD-9 連線邊界 = 同機 unix socket 信任域**。bare session 經 `/run/user/1000/opencode/daemon.sock`（`serve.ts:52-62` 繞過 auth）。文件須標明不可暴露於非信任網路（無額外認證）。

- **DD-10 對話歷史「不落地」= cecelearn 端搞定，opencode 不動（2026-06-18 拍板）**。需求：對話在一頁 session 內熱累積，網頁重置歸零。決議：opencode **不改 session 持久化**（一般 session 的 dual-track storage 是剛 hotfix 過的敏感子系統，改寫寫入路徑風險高、易誤傷一般 session）。改由 cecelearn 每次網頁載入開一個全新 bare session、跨輪重用同一 sessionID、不重連舊 id → reload 即空白對話（重置歸零）。daemon 照常持久化；舊 bare session 在硬碟累積屬可接受殘跡（日後 GC 處理，非本案阻擋項）。**不採**：memory-only backend / 寫了就刪（兩者皆動到 storage 子系統，超出最小工程）。事件記錄見 cecelearn `event_2026-06-18_decide-cecelearn-opencode-bare-session-claude-prim`。

## Risks / Trade-offs

- **R1 人格清零誤傷**：清零分支若邏輯錯誤，可能反而把正常 session 的人格也清掉。緩解：keyed-on-bare 嚴格 gate，預設行為不變；加測試覆蓋正常 session 不受影響。
- **R2 結構化輸出 provider 耦合（DD-5）**：bare session 的可靠結構化只在尊重 toolChoice 的 provider 成立。緩解：POC 固定 Claude；文件標明限制；生產走 DD-7 邊界決策。
- **R3 continuation 漏網**：若 bare session 未在所有 continuation 判斷點被識別，可能誤觸 autorun。緩解：集中在 runLoop 單一 passthrough 判斷點。
- **R4 token 額度**：POC 打真實 Claude 訂閱額度（claude-opus-4-8）。緩解：POC 控制測試次數；帳號 5H/週額度監控。
- **R5 upstream 漂移**：opencode prompt pipeline 重構可能移動 buildStaticBlock 呼叫點。緩解：code anchors 標明，sync 階段比對。

## Critical Files

- `packages/opencode/src/session/llm.ts` — buildStaticBlock 呼叫 + system 組裝（:780-854 七層、:871-886 driverOnlyBlock 鏡像來源、:1071 input.system carry-over）
- `packages/opencode/src/session/prompt.ts` — session 解析、format→StructuredOutput tool（:3441-3448）、toolChoice required（:3476-3478）、continuation 判斷、pinnedAccountId
- `packages/opencode/src/session/user-message-context.ts` — agent/model/system/format 入口（:16-67），bare agent 解析點
- `packages/opencode/src/agent/agent.ts` — getNativeAgents（:67-），新增 reserved agent `bare`
- `packages/opencode/src/account/rotation/account-selector.ts` — 帳號選擇（POC 不改，DD-7 生產參考）
- `packages/opencode/src/provider-claude/src/provider.ts` — toolChoice 映射（:311-326，不改，DD-5 依據）
- `packages/opencode/src/cli/cmd/serve.ts` — unix socket 模式（:52-62，不改，DD-9 依據）

## Code Anchors

- `llm.ts:839-854` buildStaticBlock 七層組裝（bare 分支插入點）
- `llm.ts:871-886` codex driverOnlyBlock（bare layer-zeroing 鏡像範本）
- `prompt.ts:3441-3448` createStructuredOutputTool 註冊
- `prompt.ts:3476-3478` json_schema → toolChoice "required"
- `provider-claude/provider.ts:311-326` toolChoice → {type:any}/{type:tool}（Claude 強制結構化依據）
- `provider-codex/provider.ts:104` tool_choice 寫死 auto（codex 降級根因）
- `user-message-context.ts:28` Agent.get(input.agent ?? default)（bare agent 解析）
- `serve.ts:52-62` unix socket 繞過 auth
