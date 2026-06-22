# Proposal: mcp_tool-result-presentation-contract

## Why

源於 BR `issues/issue_20260622_orchestrator_structuredcontent_unreadable_dup_call_loop.md`（已定性，真因 H1）。

**症狀**：主代理對 `docxmcp_template_vault(action=list)` 等 MCP 工具在同回合連發 5+ 次語意等價呼叫，每次只看到 `ok=True; see structuredContent`，資料拿不到 → 重發跳針，直到改 `response_format=markdown` 才解。

**已定性真因（單點）**：`packages/opencode/src/session/resolve-tools.ts:383-424` 的 MCP wrapper 只把 `result.content[]` 中 `type==="text"` 的項 join 進 LLM 可見的 `output`；`normalizeMcpToolResult`（同檔 66-108）雖把資料收進 `McpToolResult.structuredContent`，但 wrapper 最終回傳的 `{title, metadata, output, attachments, content}` **完全沒有把 structuredContent 帶進 LLM 可見 channel**。當 MCP server 把主體放 `structuredContent` 而 `content[]` 僅一行摘要時，LLM 真的只拿到摘要行。

**升維論述（為何不只是補一個欄位）**：
這不是單一工具的 bug，而是 **opencode 缺少「tool-result 呈現契約（presentation contract）」這個架構抽象**。現況是 MCP 結果的三條 channel（`content[].text` / `structuredContent` / `resource`）各自被臨機處理，沒有單一可測的「保證 LLM 能看到工具實際輸出」的不變式（invariant）。同類缺陷會在任何「主體只放 structuredContent」的 MCP server 重演（docxmcp 只是第一個被踩到的）。治本＝把這層抽出成顯式契約 + 不變式 + 防護，而非在 wrapper 補一行 if。

MCP 規格本身允許工具同時回 `content`（人/LLM 可讀）與 `structuredContent`（機器可讀結構），且建議 server 兩者都給。opencode 作為 host 不能假設 server 一定會在 `content` 放可讀摘要——host 必須在呈現層保證「結構體有資料但文字 channel 空殼」時不丟資料。

### 雙症狀同根（2026-06-22 更新，強化架構論述）

在開此 plan 期間，另一個 agent 獨立修了一個**同根但不同症狀**的 bug（event `RCA+fix: store-app lazy tool first-call returned raw MCP shape → invalid_union retry loop`，已 commit 進 main `b68753905`）：

- **那個 agent 的症狀**：store-app lazy tool（`dynamicTool.execute`）直接 `return result as any` 回傳 raw MCP `{content}` 形狀 → `output=undefined` 漏進 processor `ToolStateCompleted` zod schema → `invalid_union` → 重試迴圈。
- **本 plan 的症狀（H1）**：正規 MCP wrapper 有正規化，但 `structuredContent` 沒帶進 LLM 可見 output → 空殼跳針。

兩者是**同一架構缺口的兩面**：MCP 工具結果缺少單一、強制的呈現收斂點。那個 agent 的 fix 已順手抽出 **`shapeMcpResult(toolID, raw)`**（`resolve-tools.ts:324`）並統一三處 MCP execute 出口——這正是本 plan 要建的「單一收斂點」。**本 plan 因此從「新建契約」收斂為「在既有 `shapeMcpResult` 內補空殼偵測 + structuredContent 回填」**，工作量縮小、且印證了這層抽象確實必要（兩個 agent 各踩到一面）。

## Original Requirement Wording (Baseline)

- "開一個plan來分析RCA做一個更高架構思維的治本修補計畫。"
- scope 決策（使用者選擇）："tool-result 呈現層統一 contract（推薦）"

## Requirement Revision History

- 2026-06-22: initial draft created via plan_create
- 2026-06-22: scope 由使用者選定為「tool-result 呈現層統一 contract」（中間方案，治 H1 根本並防同類回歸；非僅點修，亦非全面 tool I/O 重構）

## Effective Requirement Description

1. 把「MCP 工具結果 → LLM 可見 channel」抽象成單一、可測的 **presentation contract**：保證任何工具的實際輸出（無論落在 `content[].text` / `structuredContent` / `resource`）都不會對 LLM 呈現為「成功卻空殼」。
2. 消除空殼偏象（empty-shell anti-pattern）：當 `output` 為空或僅為 `see structuredContent` 類佔位字串而 `structuredContent` 有實體時，必須把 structuredContent（至少主體）序列化補進 LLM 可見 `output`。
3. 把 paralysis guard 的涵蓋面延伸到「語意等價讀取重試」這一類非進展循環（換 response_format 原樣重發），作為第二道防護（防 H1 修好後仍有其他空殼源誘發跳針）。
4. 修正 SYSTEM.md §6 過時措辭（dedup 現僅對 apply_patch 生效，非 identical-call 一律 short-circuit），消除「規範宣稱 ≠ 實際行為」的認知落差。

## Scope

### IN
- `resolve-tools.ts` MCP wrapper 的結果組裝路徑：抽出 presentation contract（structuredContent / content / resource 三路統一收斂為 LLM 可見 output + attachments）。
- 空殼偵測與 structuredContent 回填邏輯（含 truncation 互動）。
- presentation contract 的單元測試 + test-vectors（空殼回填、純 text、純 structured、resource、三者混合）。
- paralysis guard 延伸：語意等價讀取重試的偵測（行為層第二道防護）。
- SYSTEM.md §6 措辭修正 + 同步 templates/prompts/SYSTEM.md。

### OUT
- dedup whitelist 機制本身的改動（現行 whitelist 設計正確，不動；僅修文件措辭）。
- response_format 語義在 docxmcp server 端的改動（host 側治本，不要求 server 改）。
- 全面 tool I/O 治理層（attachment relay 重構、truncation 策略重寫等）——留作後續 plan，本 plan 不擴。
- 原生工具（read/edit/bash...）的結果呈現路徑（它們不走 structuredContent channel，不在本案）。

## Non-Goals

- 不改 MCP 協議層或要求任何 MCP server 配合。
- 不引入新的 fallback mechanism（依天條：presentation contract 是「保證資料可見」的顯式不變式，不是 silent fallback；空殼回填是顯式、可測、可觀測的補資料，非掩蓋錯誤）。
- 不把 dedup 重新對 MCP 工具啟用。

## Constraints

- 不得新增 silent fallback（使用者天條）；空殼回填必須顯式可觀測（log / metadata 標記回填發生）。
- 不得手改 `/plans/` 或 `/specs/`——一律走 specbase 工具鏈。
- 須遵守 INV-0 類 byte-identical 紀律：非 MCP 路徑（原生工具）行為不得變動。
- truncation 互動：回填的 structuredContent 仍須過 `Truncate.output`，不得繞過預算。
- 模板同步門檻：SYSTEM.md 措辭改動須同步 runtime + templates。

## What Changes

- 新增「tool-result presentation contract」這層抽象：一個純函式 + 不變式，決定 MCP 結果如何收斂成 LLM 可見輸出。
- MCP wrapper 改為呼叫該契約，不再臨機 join text。
- paralysis guard 增加「語意等價讀取重試」訊號。
- SYSTEM.md §6 措辭更正。

## Capabilities

### New Capabilities
- tool-result presentation contract: 單一可測函式，保證 structuredContent / content / resource 三路都收斂進 LLM 可見輸出，杜絕空殼偏象。
- empty-shell guard: 偵測「output 空殼 + structuredContent 有實體」並顯式回填（含 observability 標記）。

### Modified Capabilities
- MCP tool wrapper（resolve-tools.ts）: 從「只 join text」改為「過 presentation contract」。
- paralysis detector: 涵蓋面延伸到語意等價讀取重試。

## Impact

- 程式：`packages/opencode/src/session/resolve-tools.ts`、`packages/opencode/src/session/prompt.ts`（paralysis）、新增 presentation contract 模組 + 測試。
- 文件：`packages/.../SYSTEM.md` 措辭、`templates/prompts/SYSTEM.md` 同步、`specs/architecture.md`（tool-result 呈現路徑章節）。
- 行為：MCP 工具結果不再對 LLM 呈現空殼；跳針誘因消除。原生工具行為不變。
- 觀測：新增空殼回填 anomaly/log 訊號，可追蹤哪些 server / 工具觸發回填（反向催 server 補 content）。
