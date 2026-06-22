# Orchestrator: tool-result structuredContent 讀取失敗 → 同回合等價工具呼叫跳針迴圈（anti-rewrite/anti-dup guard 未涵蓋 MCP 讀取重試）

- **日期**：2026-06-22
- **Status**：open — 已定性（2026-06-22 源碼偵查完成）。真因＝H1（structuredContent 未被 relay 進 LLM text channel）。H2 假設反了（dedup 對 MCP 工具刻意停用，非 guard bug，是 SYSTEM.md §6 文件過時）。H3 為放大器非真因。修法未實作。
- **嚴重度**：medium（不破壞正確性，但連續 5+ 次浪費 round/token，使用者明顯感知「跳針」；嚴重時可能耗盡 round budget）
- **元件**：opencode orchestrator 的 tool-result 回傳/呈現路徑 + 同回合重複呼叫短路機制（SYSTEM.md §6「Avoid duplicate tool calls」宣稱 dispatcher 會 short-circuit identical (tool_name,args)）
- **回報者**：pkcs12（live；於 docxmcp `template_vault` / `pptx_template` list 操作中觀察到）

## 摘要

主代理對 `docxmcp_template_vault(action=list)` 與 `docxmcp_pptx_template(action=list)` 在**同一使用者 turn 內連續發出 5+ 次語意等價的呼叫**，每次工具回傳都只看到一行 `ok=True; see structuredContent`，但 **structuredContent 主體未被主代理實際讀到/呈現**，導致主代理判定「沒拿到清單」→ 再呼叫 → 再次只拿到 `see structuredContent` → 再呼叫……形成跳針迴圈，直到改用 `response_format=markdown` 才一次拿到完整 JSON。

## 實際症狀（可複現）

1. 呼叫 `docxmcp_template_vault(action=list)` → 回 `docxmcp_template_vault: ok=True; see structuredContent`，但 result 區塊**沒有 structuredContent 內文**（或主代理 context 未注入該結構體）。
2. 主代理因「看不到實際清單」重發同一呼叫，args 僅微調（加 `response_format=json`、`response_format=structured`），語意等價。
3. 連續 5+ 次後，主代理改 `response_format=markdown`，才在 result 內看到完整 items JSON（`thesmart-16x9` / `thesmart-4x3`）。

SYSTEM.md §6 宣稱「Identical (tool_name,args) calls are short-circuited at the dispatcher」——但實測**沒有被短路也沒有被擋下**，連續等價呼叫全部實際執行並回傳。

## 期望行為

二擇一（或併行）：

1. **tool-result relay 修正（首選）**：MCP 工具回 `ok=True; see structuredContent` 時，structuredContent 主體必須確實注入主代理可讀的 result 內文；不應出現「工具成功但主代理拿不到資料」的空殼回應，否則必然誘發重試跳針。
2. **anti-dup / anti-rewrite guard 擴大涵蓋**：同回合對同一 (tool_name, 語意等價 args) 的連續呼叫應被 dispatcher 短路（如 §6 所宣稱），並回灌「上一次結果」而非重跑；目前該短路對 MCP 工具顯然未生效。

## 根因定性（2026-06-22 源碼偵查完成）

**真因＝H1（單點）。** MCP tool-result wrapper 沒把 `structuredContent` 帶進 LLM 可見的 text channel。

- `packages/opencode/src/session/resolve-tools.ts:383-424`：MCP wrapper 只把 `result.content[]` 裡 `type==="text"` 的項 join 進 `output`（LLM 可見 channel）。`normalizeMcpToolResult`（同檔 line 66-108）雖把資料收進 `McpToolResult.structuredContent`，但 wrapper 最終回傳的 `{ title, metadata, output, attachments, content }` **沒有任何欄位帶出 structuredContent**。
- 結果：當 docxmcp 預設 response_format 把清單主體放 `structuredContent`、`content[]` 只有一行 `ok=True; see structuredContent` text 時，LLM 真的只拿到那行摘要 → 判定「沒拿到資料」→ 重發。`response_format=markdown` 可行正是因為它把資料塞進 text content。
- **修法首選**：在 wrapper 回傳前，若 `result.structuredContent` 存在且 `output` 僅為 `see structuredContent` 類空殼，把 structuredContent（至少 items 主體）序列化補進 `output`，消除「成功卻空殼」狀態。

**H2 — 假設反了（非 bug，是文件過時）。**

- `packages/opencode/src/tool/tool.ts:232-260` `isDedupEligible()`：whitelist 模型（plans/dispatcher_kill-silent-dedup-cache, 2026-06-19），**預設 RE-RUN，唯一 dedup 白名單成員是 `apply_patch`**。所有 MCP 工具（含 docxmcp list）一律不 dedup、每次實跑。
- 所以本案的連續呼叫「沒被短路」是**正確的刻意設計**（fail-safe re-run，源自 bug_20260619 系列），不是 guard 漏洞。`tool-invoker.ts:124` 雖有 args alias 正規化，但對 MCP 工具根本不觸發 dedup。
- 真正過時的是 **SYSTEM.md §6「Identical (tool_name,args) calls are short-circuited at the dispatcher」**——這句已與現行 whitelist 設計不符，應修正措辭（dedup 僅對 apply_patch 生效）。

**H3 — 部分成立（放大器，非真因）。**

- paralysis guard（`packages/opencode/src/session/prompt.ts` 2-turn/3-turn 偵測）盯的是「無檔案變更的重複 turn」+ todowrite/narrative 重複，**不涵蓋**「拿不到資料 → 換 response_format 原樣重發」這類語意等價讀取重試。
- H3 讓重試不被攔截而連環跳針，但觸發源是 H1。H1 修好後，跳針誘因即消失。

**causal chain**：H1（structuredContent 落在 LLM 看不到的回傳欄位）→ LLM 判定「沒資料」→ H3（無 guard 攔截語意等價重試）→ 連續 5+ 次跳針，直到改 response_format 把資料塞進 text channel 才解。H2 與本案無關（dedup 對 MCP 本就停用）。

---

## 根因假設（原始，已被上方定性取代）

- **H1（relay 層）**：docxmcp 這類 MCP 工具走 `structuredContent` channel 回傳主體，但 opencode 把它呈現給 LLM 的 text channel 只放了 `ok=True; see structuredContent` 摘要行，結構體被丟在 LLM 看不到的地方（或被裁切）。`response_format=markdown` 之所以可行，是因為它把資料塞進 text channel。→ 若成立，這是 tool-result 呈現層的 channel 不一致 bug。
- **H2（guard 層）**：§6 的 identical-call short-circuit 只比對「字面完全相同」的 args；本案每次 args 微調（不同 response_format）即繞過 hash 比對，未觸發短路。語意等價但非 byte-equal 的呼叫不被視為 duplicate。
- **H3（行為層）**：anti-rewrite「paralysis 偵測」只盯 `todowrite` 的 byte-equivalent，未涵蓋一般 MCP 讀取工具的等價重試；主代理缺乏「拿不到資料時先換 response_format / 換工具，而非原樣重發」的硬約束。

三者可能疊加：H1 製造「拿不到資料」的觸發源，H2/H3 讓重試不被攔截而連環跳針。

## 候選修法（方向，待確認）

1. 修 tool-result relay：凡工具回傳含 structuredContent，一律同步在 LLM 可見 text channel 提供可讀摘要或完整體（至少 items 主體），消除「成功卻空殼」狀態。
2. dispatcher 短路條件從「byte-equal args」放寬為「正規化後語意等價」（至少對 read-only / list 類工具），或對「同回合同工具連續 N 次」加 circuit-breaker，回灌前次結果並提示 LLM 換策略。
3. driver/SYSTEM.md 行為約束：明文「同一資料連兩次拿不到 → 不得原樣重發；改 response_format 或換讀取工具或 HTTP blob」，把 §6 的 dup 規範從 todowrite 擴及一般工具。

## 複現要點

- 工具：`docxmcp_template_vault(action=list)`、`docxmcp_pptx_template(action=list)`
- 觸發：預設 response_format（非 markdown）回 `ok=True; see structuredContent` 而主體未進 LLM context
- 規避：加 `response_format=markdown` 一次即取得完整資料

## 關聯

- SYSTEM.md §6 Tool Governance「Avoid duplicate tool calls」（宣稱的 dispatcher short-circuit 與實測不符）
- 觀察來源：利善美月會 task（用 thesmart_template 轉投影片，先查 vault 模板清單時跳針）
