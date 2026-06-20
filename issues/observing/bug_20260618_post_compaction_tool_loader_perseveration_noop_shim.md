# BUG: auto-compaction 後在 no-op meta-tool（`tool_loader`）上 perseveration 迴圈——shim 結果語氣鼓勵性、反覆呼叫不收斂

- **日期**：2026-06-18
- **嚴重度**：medium（不會崩，但每次 compaction 後若踩到，會連燒數個 turn 重複同一無效動作，需使用者手動 interrupt 兩次才脫離；體感「AI 卡住鬼打牆」）
- **元件**：opencode session runtime — `tool_loader`（lazy-tool 相容 shim）結果語意 × dispatcher 的 `[already executed — reusing result]` 短路 × 缺少「N 次相同 toolcall → 行為糾正」的通用 guard × compaction artifact 的 `TOOL_INDEX` 截斷
- **回報者**：pkcs12（live，session `ses_127a8a471ffeNvACvK7B21xanG`，cms.thesmart.cc）
- **狀態**：OBSERVING（2026-06-19）—— 3R 部署 live，三證綠（daemon pid 96309→70657、binary inode 65769→66608、health buildId `5af7ed900-dirty.1781801709`）。**待自然發生的 post-compaction tool_loader 情境即時驗證**才轉 closed（無法強制重現該迴圈）。A/C/B1/B2 全落地（main `5af7ed900`，plan `session/anti-perseveration-guard`），41 單元/回歸測試綠、tsc 零新增錯。RCA 已用 live session DB 驗證、根因 #4 被推翻（見下方「VERIFIED RCA」）。

## 症狀

一次 auto-compaction 後，orchestrator 要對一個 pptx 做 `docxmcp_pptx_thumbnail` render。它**連續 3 個 turn** 呼叫了 `tool_loader({tools:["docxmcp_pptx_thumbnail"]})`，每次 shim 都回覆「該工具已可直接呼叫、不需要 loader」，但模型沒有前進到真正的 `docxmcp_pptx_thumbnail`，而是反覆 re-call `tool_loader`。

使用者必須**手動 interrupt 兩次**（「你連續 3 輪呼叫了同一個 tool 加同樣參數。停下來想想…換一個動作」）才打斷迴圈。

實際 turn 序列（節錄）：

```
turn N    tool_loader({tools:["docxmcp_pptx_thumbnail"]})
          → "These tools are available — call them directly now: docxmcp_pptx_thumbnail.
             No tool_loader round-trip is needed; deferred tools auto-load on first use."
turn N+1  tool_loader({tools:["docxmcp_pptx_thumbnail"]})   ← 完全相同 args
          → "[already executed — reusing result] These tools are available — call them directly now…"
turn N+2  tool_loader({tools:["docxmcp_pptx_thumbnail"]})   ← 又一次相同
          → "[already executed — reusing result] …"
[使用者 interrupt #1]
turn N+3  tool_loader(...)  ← 仍重複
[使用者 interrupt #2]
turn N+4  終於改用 bash soffice→pdftoppm 轉圖，脫離迴圈
```

## Root Cause（分層；標註哪些是已證實 vs 推論）

### 觸發條件（已證實）

本 session 在長 agentic 任務中經歷多次 auto-compaction。最近一次 compaction 後，可見 context 變成 narrative summary + 一份 **`TOOL_INDEX` 表，其最舊 418 筆被截斷成註記**：

> `(truncated 418 earlier entries — recall by guessing id from narrative)`

→ 模型對「我剛剛做過什麼」的精確記憶被削弱（working-cache L2 仍在，但 prompt 內可見的 tool 軌跡被壓掉）。

### 因果鏈（推論，需 runtime 端核對）

1. **`tool_loader` 是 no-op 相容 shim**。其 self-description 已明言「usually unnecessary…deferred tools are ALREADY directly callable」。對 `docxmcp_pptx_thumbnail` 這類已在 deferred catalog 的工具，呼叫它本身就是多餘動作。模型在 post-compaction context 變薄下，反射性地把「載入工具」當成 render 前的必要前置步驟——**這一步從一開始就不該存在**。

2. **shim 結果語氣是「鼓勵性 + 祈使句」而非「終止性」**。回覆為 _"call them directly now"_——這是一句**祈使指令**。在 perseveration 狀態下，模型把它讀成「還要再做一個 setup 動作」，而不是「你已經可以了，停止呼叫我」。結果是：每次 shim 回覆反而**再次觸發**同類動作。

3. **dispatcher 的相同-call 短路有偵測、但無行為糾正**。第 2、3 次呼叫回的是 `[already executed — reusing result]`——代表 runtime **已偵測到 identical (tool_name, args)**，卻只是靜默 reuse cache，**沒有對模型發出任何「你在重複、換動作」的訊號**。短路防的是重複「執行」，沒防重複「決策」。

4. **既有 paralysis guard 蓋不到**。`bug_20260615_paralysis_guard_evaded_by_preface_perseveration` 的 guard 監看的是 `todowrite` byte-equality；本案重複的是 `tool_loader`（任意工具），不在該 guard 範圍。

→ 三者疊加：post-compaction 記憶變薄誘發多餘前置動作 → shim 用祈使語氣回覆 → 模型再次觸發 → 短路靜默 reuse、不糾正 → 迴圈直到使用者手動打斷。

## VERIFIED RCA（2026-06-18 transcript 稽核，取代上方推論的因果鏈 #3/#4）

直接讀 live session DB（`~/.local/share/opencode/storage/session/ses_127a8a471ffeNvACvK7B21xanG.db`，table `messages`/`parts`）還原實際序列。**七次 tool_loader 全部同一個 args `["docxmcp_pptx_thumbnail"]`**，迴圈實況：

| #   | msg id        | finish                | 內容                            |
| --- | ------------- | --------------------- | ------------------------------- |
| 1   | edad56ef3     | tool-calls            | tool_loader                     |
| 2   | edad58ec6     | tool-calls            | tool_loader                     |
| 3   | edad5a9ba     | tool-calls            | tool_loader                     |
| —   | **edad5cf39** | (user, **synthetic**) | **🛑 Detector A 自動 nudge #1** |
| 4   | edad5cfa5     | **error**             | tool_loader                     |
| 5   | edae0794c     | tool-calls            | tool_loader                     |
| —   | **edae0797f** | (user, 真人)          | 使用者實際只打了「**繼續**」    |
| 6   | edae0995d     | tool-calls            | tool_loader                     |
| —   | **edae0b8fa** | (user, **synthetic**) | **🛑 Detector A 自動 nudge #2** |
| 7   | edae0b954     | error                 | tool_loader                     |

兩條 synthetic user 訊息的 text part **逐字**是 signature-detector 的 nudge（`packages/opencode/src/session/prompt.ts:2715`）：

> 「你連續 3 輪呼叫了同一個 tool 加同樣參數。停下來想想：是不是該檢查當前實際狀態，而不是重複 plan？換一個動作。」

session 內有一筆 compaction summary（`msg_edac6d965`, `summary=1`）發生在迴圈**之前** → 「post-compaction」前提屬實。

### 已證實的事實（推翻原根因 #4）

1. **shim 訊息確為鼓勵性祈使句**（原根因 #1/#2 ✓）。`tool-loader.ts:259-263`：found.length>0 一律回 `"These tools are available — call them directly now: …. No tool_loader round-trip is needed; deferred tools auto-load on first use."`，**無**「已在 catalog → 終止」分支；self-description（`tool-loader.ts:166-170`）也只說 "usually unnecessary / ALREADY directly callable"，沒有反鼓勵語氣。

2. **dedup 短路確實靜默、無計數器**（原根因 #3 ✓，但次要）。`session/tool-invoker.ts:228/266` 用 `stableStringify(normalizeArgsForDedup(...))` 判 identical，命中只加 `[already executed — reusing result]` 前綴（exploration 類工具連前綴都沒有），metadata 只有 `shortCircuited`/`reason`，**不記重複次數、不對模型發行為糾正**。

3. **原根因 #4 錯，且錯兩層**：
   - **Detector A 是 tool-agnostic 的**：signature = `${tool}:${xxHash64(JSON.stringify(input))}`（`prompt.ts:2468-2479`），對任意工具生效，**不是只看 todowrite**。`PARALYSIS_PROGRESS_TOOLS` 只用於 Detector D 的「有無 file mutation」判斷，不是 guard 的監看白名單。
   - **它不但涵蓋 tool_loader，還真的在 call #3 開火了，且開了兩次**。BR 上半部被當成「使用者手動 interrupt」的那句話，其實是 **guard 自己注入的 nudge**；使用者真正的輸入只是「繼續」。

### 真正的缺陷（修法應對準這兩條）

- **C1 — nudge 內容太泛、對 no-op shim 迴圈無指向性**。模型收到「換一個動作」後仍再呼叫 tool_loader。它需要的是具體逃生路線（「tool_loader 是 no-op，別再叫它，直接呼叫目標工具」），而非泛用提示。
- **C2 — 升級到 hard-halt 的狀態活不過 runloop 重入**。`paralysisRecoveryCount`/`paralysisCleanStreak` 是 runloop 的 local `let`（`prompt.ts:1738/1742`），每次重入歸零。中間夾的 `finish=error` turn（被 `prompt.ts:2456` 的 `finish==='tool-calls'` filter 排除出 `recentAssistants` 視窗）與使用者那句「繼續」都讓 runloop 退出重入 → counter 歸零 → 永遠停在「第一次 nudge」（`recoveryCount===0` 分支），**`prompt.ts:2738+` 的「recovery 已試過一次 → ParalysisDetectedError hard-halt」安全網從沒接上**。實況因此是 nudge→nudge→nudge，而非 nudge→halt。C2 與 0615「guard 被繞過」同源。

## 與既有 BR 的關係

- `bug_20260615_paralysis_guard_evaded_by_preface_perseveration.md`（OPEN）：**同家族、同根**。兩案都不是「guard 不存在」，而是「guard 開火/邏輯有但被繞過或沒效」。本案的 B2（升級狀態跨 runloop 重入持久化）與 0615 的修法應一起設計——通用 guard（Detector A-D）已存在，要修的是它的**有效性與狀態續存**，不是再蓋一條新機制。
- `bug_20260618_compaction_continue_injection_empty_text_runloop_stall.md`（FIX DEPLOYED）：**同樣由 compaction 觸發**，但失敗模式不同——那案是 runloop **靜默停住**；本案是 runloop **活著但鬼打牆**。兩案共同指向「compaction 後 context/continuity 退化」這個更大主題。

## Fix Plan（已依 VERIFIED RCA 重排）

### 主修 A — `tool_loader` shim 回終止性結果（最小、低風險、首要）

源頭就是模型把 no-op shim 當 render 前置。當目標工具已在 deferred catalog（即呼叫 tool_loader 是多餘的），`tool-loader.ts` 的 `formatLoaderOutput()` 在 found.length>0 分支應回**明確終止 + 反鼓勵**的訊息，取代現行「call them directly now」：

> `NO-OP: 'docxmcp_pptx_thumbnail' is already directly callable. tool_loader was unnecessary. Do NOT call tool_loader again — invoke 'docxmcp_pptx_thumbnail' directly with its real arguments.`

把祈使焦點從「call them directly」改成「**stop calling tool_loader**」，移除「還有前置步驟」的暗示。攻擊迴圈源頭、與 guard 是否開火無關。

### ~~主修 B（原案：蓋通用 N-repeat guard）已撤銷~~

**通用 guard 已存在且確實開火**：`prompt.ts` Detector A（signature, tool-agnostic）在本案 call #3 注入了 nudge、且觸發兩次（見 VERIFIED RCA）。再蓋一條會是重複機制。改為下列 B1/B2 —— 對準「guard 開火了卻沒效」的兩個真缺陷。

### 主修 B1 — guard nudge 對 no-op meta-tool 給指向性逃生語句

Detector A 的 nudge 現為泛用「換一個動作」，對 no-op shim 迴圈無指向性。當被重複的工具是 `tool_loader`（或其他已知 no-op meta-tool）時，nudge 應改成具體逃生路線，例如：

> `tool_loader 是 no-op 相容 shim，呼叫它不會有任何效果。停止呼叫 tool_loader，直接呼叫你想用的目標工具（它已可直接呼叫）。`
> 可在 `prompt.ts:2713-2716` 依 `repeatedTool` 是否為 no-op meta-tool 走分支。

### 主修 B2 — paralysis 升級狀態跨 runloop 重入持久化（治本，與 0615 同源）

`paralysisRecoveryCount`/`paralysisCleanStreak` 目前是 runloop 的 local `let`（`prompt.ts:1738/1742`），`finish=error` turn 與使用者插話（「繼續」）造成的 runloop 重入都會歸零，使「recovery 失敗 → hard-halt」（`prompt.ts:2738+`）永遠接不上 → 只會無限 re-nudge。應把這兩個 counter 改為 **session-scoped 持久狀態**（隨 session 存取、跨重入保留），讓第二次偵測到 paralysis 時真的能 halt。附帶考量：`recentAssistants` 視窗是否該把 `finish=error` 的同 (tool,args) turn 也納入連續性判斷（目前被 `prompt.ts:2456` 排除，導致錯誤 turn 把迴圈切斷、計數重來）。

### 主修 C — compaction artifact 保留近期 tool 軌跡（次要）

`TOOL_INDEX`（`session/tool-index.ts:applyBudget`，client 端 30KB 預算）截斷成「guess id from narrative」會削弱 post-compaction 的自我記憶。建議保留**最近 N 筆的 tool name + status**（不必保留 args/body），讓模型壓縮後仍知道「render 這步我剛做過/沒做過」，降低多餘前置動作的誘因。

### 回歸測試

1. 對已在 catalog 的工具呼叫 `tool_loader` → 斷言 `formatLoaderOutput()` 回覆含明確「Do NOT call again / NO-OP」終止語意、且**不含** "call them directly now"。
2. B1：模擬連續 3 次 identical `tool_loader` call → 斷言注入的 nudge 含「tool_loader 是 no-op / 直接呼叫目標工具」指向性語句，而非泛用「換一個動作」。
3. B2：模擬「3 次重複 → nudge → runloop 重入（error 或使用者插話）→ 再 3 次重複」→ 斷言第二輪走 **hard-halt** 而非再 nudge（即 recoveryCount 跨重入保留）。
4. post-compaction artifact → 斷言 `TOOL_INDEX` 至少保留最近 N 筆 name+status。

## 影響範圍

任何長 agentic session 在 compaction 後、且模型反射性呼叫 no-op meta-tool（tool_loader）或任何冪等查詢時，可能踩入空轉迴圈。不致命但燒 turn、傷使用者信任（「AI 卡住了」）。本 session 實測燒掉 ~4 個 turn + 2 次使用者 interrupt。
