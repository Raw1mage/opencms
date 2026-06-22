# Design: tool-result presentation contract

## Context

承接 BR `issues/issue_20260622_orchestrator_structuredcontent_unreadable_dup_call_loop.md`（已定性，真因 H1）。現行 MCP 工具結果在 `packages/opencode/src/session/resolve-tools.ts:317-428` 的 wrapper 內被組裝成 LLM 可見輸出，但只取 `content[].text`，丟失 `structuredContent`。本 plan 把這層抽成顯式契約。

### 現行呈現路徑（偏探確認）

1. `MCP.tools()` 回傳的 raw item → wrapper（resolve-tools.ts:328-427）。
2. wrapper 內 `normalizeMcpToolResult`（同檔 66-108）把 raw result 正規化成 `McpToolResult { content[], metadata?, isError?, structuredContent? }`。
3. wrapper 遍歷 `result.content[]`：`type==="text"` → push 進 `textParts`；`type==="image"` / `type==="resource"` → push 進 `attachments`（resource.text 也進 textParts）。
4. `textParts.join("\n\n")` → `Truncate.output` → `output`（LLM 可見）。
5. **回傳 `{ title, metadata, output, attachments, content }` — `structuredContent` 在此丟失**（這是 H1 真因點）。

### 三條 channel 現況

| channel | MCP 來源 | 現行去向 | 缺陷 |
|---|---|---|---|
| `content[].text` | text content item | → output（LLM 可見）✓ | 無 |
| `content[].resource.text` | embedded resource | → output ✓ | 無 |
| `content[].image` / `resource.blob` | media | → attachments ✓ | 無 |
| **`structuredContent`** | 結構化主體 | **丟失** ✗ | **H1：LLM 看不到** |

## Goals / Non-Goals

### Goals
- 抽出單一純函式 `composeMcpToolOutput`（暫名）作為 presentation contract，集中三 channel → LLM 可見輸出的收斂邏輯。
- 建立不變式：「工具成功（!isError）時，若有任何實體資料（content text 或 structuredContent），LLM 可見 output 不得為空殼」。
- 空殼偵測 + structuredContent 顯式回填（可觀測）。
- paralysis guard 延伸涵蓋語意等價讀取重試。
- 修正 SYSTEM.md §6 措辭。

### Non-Goals
- 不改 dedup whitelist。
- 不要求 MCP server 配合。
- 不重構 attachment relay / truncation 策略。
- 不引入 silent fallback。

## Decisions

- **DD-1**：~~presentation contract 實作為純函式（新建 composeMcpToolOutput）~~ (v1, SUPERSEDED 2026-06-22) → **擴充既有 `shapeMcpResult`**（`resolve-tools.ts:324`，commit `b68753905` 已落地）。另一個 agent 修 store-app lazy tool `invalid_union` 時已抽出 `shapeMcpResult(toolID, raw)` 並統一三處 MCP execute 出口（normal wrapper :430、lazy fail :539、lazy success :552）——這正是本契約要的「單一收斂點」。本 plan 不再新建，而是在 `shapeMcpResult` 內補空殼偵測 + structuredContent 回填（DD-2）。`shapeMcpResult` 維持非純（它 await `Truncate.output`），空殼偵測邏輯抽成可單測的 pure helper `detectEmptyShell` 注入。理由：避免重複造輪子（天條 #13），既有 enforcement point 已存在。

- **DD-2**：空殼偵測規則（objective，非主觀）——當 `!result.isError` 且 `structuredContent !== undefined` 且 `textParts.join` 後的可讀文字滿足「空殼」判定（空字串 / 純空白 / 僅 match `/see structuredContent/i` 類佔位）時，把 `structuredContent` 序列化（JSON.stringify, 2-space）補進 output。**回填發生時必在 metadata 標記 `presentationBackfill: { reason, bytes }`**（顯式可觀測，非 silent）。

- **DD-3**：回填的 structuredContent 仍須過 `Truncate.output`，不得繞過 token 預算（INV：truncation 對所有 LLM 可見輸出一致生效）。順序：先合併 text + 回填 → 再 truncate。

- **DD-4**：不變式 INV-PRESENT —「成功的工具呼叫若帶實體資料，LLM 可見 output 非空殼」。enforcement point = `composeMcpToolOutput` 出口；測試以 test-vectors 覆蓋（純 text / 純 structured / resource / 混合 / 空殼回填 / isError 不回填）。

- **DD-5**：原生工具（read/edit/bash...）**不經** presentation contract（它們不走 structuredContent channel，行為須 byte-identical，INV-0）。契約只掛在 MCP wrapper 路徑。

- **DD-6**：paralysis guard 延伸（行為層第二道防護，非真因修補）——在現有 tool-call 重複偵測（prompt.ts ~2603）旁，增加「同工具同回合連續 N 次、args 僅 response_format 類欄位變動且每次 output 仍空殼」的訊號，注入 nudge 提示「換讀取策略 / HTTP blob」。此為防護縱深，不取代 DD-1~4。

- **DD-7**：SYSTEM.md §6 措辭改為精確描述現行 whitelist 設計（dedup 僅對 apply_patch 生效；其餘工具一律 re-run），同步 runtime + `templates/prompts/SYSTEM.md`。

## Risks / Trade-offs

- **R1（truncation 互動）**：回填大型 structuredContent 可能撐爆 output 預算 → 被 truncate 成另一種「半截資料」。緩解：truncate 後若仍截斷，metadata 標記 `outputPath`（既有機制），LLM 可走 HTTP blob 取完整。
- **R2（誤判空殼）**：某些工具正常回傳就是短 text + structuredContent（非空殼）。緩解：空殼判定嚴格（空/空白/`see structuredContent` 佔位 regex），非「只要有 structuredContent 就回填」；正常 text 不觸發。
- **R3（blast radius）**：wrapper 是所有 MCP 工具的共同路徑，改動波及全部 MCP 工具呈現。緩解：純函式 + test-vectors 全覆蓋；原生路徑不動（DD-5）；INV-0 baseline 測試守原生行為。
- **R4（paralysis 延伸誤殺）**：語意等價讀取重試偵測可能誤判正常的「換格式重查」。緩解：只在「每次 output 仍空殼」時才觸發（DD-6），正常取得資料即不觸發。

## Critical Files

- `packages/opencode/src/session/resolve-tools.ts`（66-108 normalize、317-428 wrapper）— 抽出契約、改 wrapper 呼叫點。
- 新增 `packages/opencode/src/session/mcp-tool-presentation.ts`（暫名）— presentation contract 純函式 + 空殼偵測。
- 新增 `packages/opencode/test/session/mcp-tool-presentation.test.ts` — test-vectors。
- `packages/opencode/src/session/prompt.ts`（~2603 paralysis tool-call 偵測）— DD-6 延伸。
- `packages/.../SYSTEM.md` §6 + `templates/prompts/SYSTEM.md:213-215` — DD-7 措辭。
- `specs/architecture.md` — tool-result 呈現路徑章節同步。

## Traceability

- BR → H1 真因 → DD-1/2/3/4（治本）→ INV-PRESENT。
- BR → H3 放大器 → DD-6（防護縱深）。
- BR → H2 文件落差 → DD-7（措辭更正）。
