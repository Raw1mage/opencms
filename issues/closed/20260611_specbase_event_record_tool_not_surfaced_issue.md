# Bug Report: specbase `event_record` 寫入工具未被 opencode 工具面暴露（mandate 與實際工具面 drift）

## 0. Handoff Summary

AGENTS.md / SYSTEM.md 在 8+ 處硬性要求 AI「任何非瑣碎開發任務開工與收尾都必須呼叫 `event_record`（event log 的唯一寫入路徑）」，且 specbase MCP server 原始碼確實註冊了一個名為 `event_record` 的工具（`packages/mcp/src/index.ts:292` / `:686`）。然而在 opencode runtime 的實際工具面上，specbase 只暴露了 `specbase_event_search`、`specbase_event_query`、`specbase_spec_record_event`（slug-scoped）等讀取/spec-scoped 工具，**唯獨缺少 project-level 的 `event_record` 寫入工具**。AI 依規範呼叫 `specbase_event_record` 時被 runtime 回 `unavailable tool` 拒絕，導致 event log 在「規範強制但工具不存在」的死結中**完全無法寫入**。本 BR 為 **confirmed**：server 端已註冊、規範強制呼叫、工具面卻被過濾掉，三方對齊缺一角。下一個 session 應先比對 specbase server 的 tool registration 清單與 opencode enablement.json 的 specbase `provides` allowlist，補上遺漏的 `event_record`（以及確認 `event_search`/`event_query` 為何活著但 `event_record` 死掉的過濾差異）。

## 1. Bug Identity

| Field                         | Value                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Title                         | specbase `event_record` 寫入工具未被 opencode 工具面暴露                                        |
| Component                     | opencode 工具面 / MCP enablement registry（specbase tool surfacing）                            |
| Reporter                      | Main Agent session `ses_1491aa8feffeJQOpbvWKaFmfjk`（MCP 教案任務收尾時觸發）                   |
| Date                          | 2026-06-11                                                                                      |
| Severity                      | high — event log 是 canonical 開發紀錄基質；寫入路徑全斷代表所有 session 的 event log 義務無法履行 |
| Priority                      | P1 — 不阻塞單一任務產出，但持續性破壞跨 session 知識沉澱（three-tier-recall 的中間層永久缺料）  |
| Status                        | OPEN — RCA 修正：H1（enablement 過濾）以 code 推翻；真因＝opencode 從可變原始碼 spawn 的 stdio MCP 子行程在 server 原始碼變更後無重載偵測（stale tool surface）。真正可修的缺口在 opencode 側。詳 §14 |
| Affected versions/tools/paths | `mcp__specbase__event_record` / `specbase_event_record`；opencode enablement registry          |

## 2. Environment

- opencode repo: `/home/pkcs12/projects/opencode`
- specbase server repo: `/home/pkcs12/projects/specbase`（MCP server 原始碼）
- specbase MCP 設定: `/home/pkcs12/.config/opencode/mcp.json:4`（`cwd: /home/pkcs12/projects/specbase`）
- enablement registry: `packages/opencode/src/session/prompt/enablement.json`
- 觸發 session cwd: `/home/pkcs12/projects/documents`
- 規範來源（mandate）:
  - `/home/pkcs12/.config/opencode/AGENTS.md`（global，多處強制 `event_record`）
  - SYSTEM.md（透過 working cache / event ledger 規範）
- OS/runtime: linux, bun daemon
- configured mcp 快照: `specbase:on, drawmiat:on, docxmcp:on`

## 3. Expected Behavior

- specbase server 註冊的 `event_record` 工具，應該以 `specbase_event_record`（或 `mcp__specbase__event_record`）名稱出現在 AI 可呼叫的工具面（core 或 deferred 皆可），與 `event_search` / `event_query` 同等暴露。
- AI 依 AGENTS.md 規範呼叫 `event_record(summary, body?, scope?, date?, status?, tags?, cites?)` 時，應成功 append 一筆 row 進 event log sqlite。
- 不變量：**規範強制呼叫的工具 = 工具面實際暴露的工具**。任何被 AGENTS.md / SYSTEM.md 列為「唯一寫入路徑」的 MCP 工具，都不得被 enablement 過濾掉。
- 絕不該發生：規範要求呼叫 X，runtime 卻回 `unavailable tool 'X'`。

## 4. Actual Behavior

- AI 呼叫 `specbase_event_record(...)` → runtime 回傳 `invalid` 結果，error：`Model tried to call unavailable tool 'specbase_event_record'`（本 session 末段 evidence E1）。
- 實際工具面（deferred-tools manifest）列出的 specbase 工具：`wiki_*` 系列、`event_search`、`event_query`、`plan_*` 系列、`spec_amend`、`spec_tick_task`、`spec_record_event`、`spec_record_decision`、`spec_add_code_anchor`、`spec_sync`、`spec_translate`。**沒有 `event_record`**。
- specbase server 原始碼**確實有**註冊 `event_record`（E2），所以不是 server 沒做，而是 opencode 端沒把它 surface 出來。
- 結果：event log 在本 session 完全無法寫入（MCP 教案任務開場與收尾的 event 都吞掉了）。

## 5. Steps To Reproduce

1. 在任一 opencode session（specbase MCP on）呼叫 `specbase_event_record({summary: "test", body: "test", scope: "documents"})`
   - 預期觀察：成功 append row
   - 實際觀察：`unavailable tool 'specbase_event_record'`
2. 對照呼叫 `specbase_event_search({q: "test"})`
   - 實際觀察：正常執行（證明 specbase MCP 連線本身是好的，只有 `event_record` 這個 tool 不見了）
3. 檢視 deferred-tools manifest 中 specbase 區段
   - 實際觀察：有 `event_search` / `event_query` / `spec_record_event`，無 `event_record`

## 6. Evidence

| Evidence | Type      | Reference                                                              | What it shows                                                                                          |
| -------- | --------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| E1       | tool call | `toolu_01KqvjsmJcLx8Lzx9Vot5SBH`（本 session）                         | `Model tried to call unavailable tool 'specbase_event_record'` — runtime 拒絕呼叫                      |
| E2       | file      | `/home/pkcs12/projects/specbase/packages/mcp/src/index.ts:292`        | specbase server **註冊** `name: "event_record"`；`:686` 為其 case handler。工具在 server 端確實存在    |
| E3       | file      | `/home/pkcs12/projects/specbase/packages/mcp/src/index.ts:401,886`    | 同檔另註冊 `spec_record_event`（slug-scoped），此工具有被 surface（見 deferred-tools）                 |
| E4       | file      | `packages/opencode/src/session/prompt/enablement.json:383-394`        | specbase `provides` allowlist 列出 `spec_record_event`（:391）等，但**未列** `event_record`            |
| E5       | manifest  | deferred-tools（本 session system-reminder）                          | specbase 暴露 `event_search`/`event_query`/`spec_record_event`，**無** `event_record`                  |
| E6       | file      | `/home/pkcs12/.config/opencode/AGENTS.md:132,222,249,283`             | 規範強制 `event_record` 為 event log「唯一寫入路徑」，commit gate 把關                                 |
| E7       | file      | `/home/pkcs12/.config/opencode/mcp.json:4-7`                          | specbase MCP 設定指向 `/home/pkcs12/projects/specbase`，server 連線正常（E1 的 search 工具可用佐證）   |

## 7. Impact / Risk

- **跨 session 知識沉澱永久缺料**：event log 是 three-tier-recall（session → event → spec）的中間蒸餾層，也是 AGENTS.md 宣告的 canonical 開發紀錄基質。寫入路徑全斷 = 所有 AI session 的「決策 / RCA / 部署 / checkpoint」都無法落盤，未來 `event_search` 撈不到本應存在的紀錄。
- **規範與能力自相矛盾**：AGENTS.md 的 commit gate 要求「commit 前必須確認 event log 已透過 `event_record` 寫入」，但工具不存在 → 所有遵守規範的 agent 都會卡在無法滿足的 gate，或被迫違規跳過。
- **靜默失敗風險**：若 agent 沒注意到 `invalid` 回傳就宣告完成，等於規範被無聲架空，問題長期潛伏。
- blast radius：全機所有使用 specbase event log 的 opencode session（不限本 repo）。
- 無資料損毀風險（是「寫不進去」而非「寫壞」），但屬持續性資料**遺漏**。

## 8. Root-Cause Hypotheses

### H1: enablement.json 的 specbase `provides` allowlist 漏列 `event_record`，導致 surfacing 階段被過濾

Confidence: high

Why plausible:

- E4 顯示 `provides` 陣列（:383-394）明確列出多個 specbase 工具但無 `event_record`。
- E5 顯示實際工具面與該 allowlist 高度吻合（被列的活著、沒列的 `event_record` 死掉）。
- `spec_record_event`（slug-scoped，有列）活著、`event_record`（project-level，沒列）死掉 — 正好對應 allowlist 的有無。

How to confirm:

- 把 `mcp__specbase__event_record` 加進 enablement.json:383-394 的 `provides`，重啟 runtime，重呼叫 `specbase_event_record` 看是否成功。

How to refute:

- 若 enablement 的 `provides` 只是文件性 routing hint、不實際 gate 工具暴露，則加進去無效 → 排除 H1，轉 H2。

### H2: opencode 的 MCP tool 過濾/allowlist 機制（非 enablement.json）把 `event_record` 篩掉

Confidence: medium

Why plausible:

- 尚未在本次調查中定位到實際把 MCP 工具切成 core/deferred/隱藏的程式碼路徑（grep `deferred|tool.*allowlist` 在 prompt/*.ts 無命中）。
- 過濾可能發生在工具 surfacing 的另一層（例如以名稱前綴或 schema 條件篩選）。

How to confirm:

- 定位 opencode 載入 MCP server 工具清單 → 決定哪些 surface 的程式碼；檢查是否對 `event_record` 有特殊排除（例如與內建 `event`/ledger 名稱衝突而被去重）。

How to refute:

- 若該層原樣透傳所有 server 工具、僅靠 enablement.json gate → 回到 H1。

### H3: 名稱衝突 — `event_record` 與 opencode 內建某機制（event ledger / GlobalBus "event"）撞名被去重

Confidence: low

Why plausible:

- 程式碼中 `"event"` 字串大量用於 GlobalBus / event stream（E：worker.ts、plugin/index.ts 等）。若工具去重以子字串或寬鬆比對，理論上可能誤殺。

How to confirm / refute:

- 檢查工具註冊去重邏輯是否以完整 `mcp__specbase__event_record` 比對；若是完整比對則排除 H3。

## 9. Workarounds

- **暫時手段（本 session 已被迫採用的替代）**：無法寫 sqlite event log 時，退回在 repo 寫 markdown 事件檔（如 `docs/events/event_<date>_<topic>.md`）——但這違反 three-tier-recall 的 sqlite-only 新範式，且 `event_search` 不一定吃得到，僅作為過渡。
- **何時用**：在 fix 落地前、又必須留下開發紀錄時。
- **downside**：產生 AGENTS.md 已宣告淘汰的 markdown 殘留，未來需清理；且與 sqlite event log 分裂成兩處。
- **何時不要用**：fix 完成後不應再走此路。

## 10. Proposed Fix Direction

- **若 H1 成立（最可能）**：在 `packages/opencode/src/session/prompt/enablement.json` 的 specbase `provides`（:383-394）補上 `mcp__specbase__event_record`，並同步 `templates/prompts/enablement.json`（避免 runtime/template drift，AGENTS.md §Enablement Registry 要求兩處同步）。
- **若 H2/H3 成立**：在 MCP 工具 surfacing 層修正過濾/去重邏輯，確保 server 註冊的所有工具（除非明確排除）都被暴露。
- 相容性：純粹「補上遺漏工具」，無破壞性；不影響既有 `event_search`/`event_query` 行為。
- 伴隨測試：新增一條測試斷言「specbase server 註冊的每個 tool 都出現在 opencode 暴露的工具面」（防止未來再次 drift）。
- 注意：修完後應回頭驗證 AGENTS.md 引用的工具簽名 `event_record(summary, body?, scope?, date?, status?, tags?, cites?)` 與 server 端 schema 一致。

## 11. Acceptance Criteria

- positive：在 specbase on 的 session 呼叫 `specbase_event_record({summary, body, scope})` 成功 append 一筆 row，`event_search` 能撈回。
- negative：呼叫不再回 `unavailable tool`。
- regression：`specbase_event_search` / `event_query` / `spec_record_event` 行為不變。
- structural：新增的「server tools ⊆ surfaced tools」斷言測試通過。
- diagnostics：若工具仍被刻意排除，需有明確 log 說明原因，而非靜默消失。

## 12. Open Questions

- enablement.json 的 `provides` 到底是「實際 gate 工具暴露的 allowlist」還是「routing 文件提示」？需定位消費 `provides` 的程式碼以確認 H1 vs H2。
- 為何 `spec_record_event` 被收錄而 `event_record` 沒有？是手動維護 allowlist 時的單純遺漏，還是自動產生時有篩選規則？
- specbase server 是否還有其他註冊但未被 surface 的工具（如 `wiki_list`/`wiki_get`/`wiki_graph`/`wiki_validate`/`wiki_rebuild_index`/`spec_translate` 都在 deferred 出現，但需全面比對 server registration 清單）？

## 13. Next Session Checklist

1. 開 `/home/pkcs12/projects/specbase/packages/mcp/src/index.ts`，列出所有 `name:` tool registration，做成完整清單。
2. 開 `packages/opencode/src/session/prompt/enablement.json:367-400`，比對 specbase `provides` 與步驟 1 清單，標出所有缺漏（至少 `event_record`）。
3. 定位 opencode 消費 `enablement.json` `provides` / surface MCP 工具的程式碼（grep `provides`、`requires_mcp`、MCP tool 載入處），確認 H1 vs H2。
4. recall 本 session evidence：tool call `toolu_01KqvjsmJcLx8Lzx9Vot5SBH`（unavailable tool 證據）。
5. 實作 fix（補 enablement allowlist 或修 surfacing 過濾），同步 `templates/prompts/enablement.json`。
6. 驗證：呼叫 `specbase_event_record` 成功 → 再 `event_search` 撈回 → 停在 acceptance criteria 全綠。

## 14. RCA (2026-06-11 — 修正版；前一版結論的證據已撤回)

> **撤回聲明**：本 RCA 第一版曾以「調查者自己的 session 能呼叫 `event_record`」為決定性證據判 CLOSED/非缺陷。該證據**無效**——調查者是 Claude Code harness，其 tool-loading 路徑與 opencode runtime 不同；「我這邊能用」推不出「opencode agent 那邊能用」。下方為改以 **opencode runtime 原始碼 + BR 自身 evidence** 重建的版本，結論的方向不變，但證據鏈替換，且**不再判非缺陷**——確實存在一個屬於 opencode 的可修缺口。

### (a) H1 以 code 推翻（enablement.json 不 gate 工具）
- enablement.json **沒有** `provides` 這個 key；全 codebase grep `provides` 無任何消費它的程式碼。該檔只是 `intent`/`keywords`/`prefer`/`fallback` 的 routing 提示，且整檔未提 `event_record`/`event_search`/`event_query`。BR §H1 把 specbase 區塊的 `prefer` 誤讀成 `provides` allowlist。
- opencode 對 MCP 工具**零 allowlist 過濾**：[mcp/index.ts:1459-1466](packages/opencode/src/mcp/index.ts#L1459-L1466) 的 `tools()` 把 `client.listTools()` 回的**每個** tool 都註冊（`result[toolID(...)] = ...`）；[resolve-tools.ts:317-319](packages/opencode/src/session/resolve-tools.ts#L317-L319) 進池時唯一的丟棄條件是 `PermissionNext` 的 `deny` 與 `system-manager_` 去重。沒有任何「列入才暴露」的清單。
- 命名：[mcp/index.ts:856-866](packages/opencode/src/mcp/index.ts#L856-L866) `toolID()` 產 `specbase_event_record`（與 E1 一致；`mcp__specbase__` 是別的 harness 的命名）。

### (b) 決定性判別點：BR §5 step 2（同 session 內 event_search 活、event_record 死）
這條 evidence 把「過濾說」和「stale 說」分開：
- 若是 opencode 端過濾/permission，沒有理由只篩掉 `event_record` 卻保留同源於**同一次 `listTools()`** 的 `event_search` / `spec_record_event`。
- 但這正是 **stale 子行程的指紋**：`event_search`/`event_query` 來自較早 commit `b59b37d`；`event_record` 來自較晚 commit `ed8dfc1`（2026-06-10 04:13）。一個在這兩個 commit 之間、從原始碼 spawn 的 specbase 子行程，`listTools()` 會**剛好**回 event_search 而無 event_record——與 BR 觀察逐項吻合。

### (c) 真正可修的缺口（opencode 側）
opencode 把 `local` MCP（`bun packages/mcp/src/index.ts`，mcp.json:4）spawn 成 stdio 子行程，工具清單只在收到 server 主動發的 `ToolListChangedNotification`（[mcp/index.ts:143](packages/opencode/src/mcp/index.ts#L143)）時 invalidate cache。但**從可變原始碼直跑的子行程，在原始碼被編輯後不會知道、也不會發那個 notification**——於是 opencode 忠實地服務一個 stale 子行程的舊工具面，直到該子行程被換掉（daemon 重啟，或 on-demand idle 10 分鐘後重連，見 resolve-tools.ts `AUTO_MCP_IDLE_MS`）。這就是「server 原始碼已註冊、agent 工具面卻沒有」的成因，且**修正點在 opencode**（偵測 local server 原始碼 mtime / 提供重載），不在 enablement。

### (d) 殘留不確定（誠實標註）
- BR 當下命中的那個子行程**已消亡**，無法直接觀測其 `listTools()`；(b) 是以 runtime code + commit 時序 + BR evidence 做的**重建**，非當場抓到。屬高信心但非直證。
- 現況快照：機器上同時有 ~10 個 `bun packages/mcp/src/index.ts` 子行程，最早起於今天 12:34（**全部晚於** ed8dfc1），故**現在**的 daemon 應已暴露 event_record。但「現況」不能回溯證明 BR 當下狀態（這正是第一版犯的錯，不再重複當證據）。10 個並存子行程本身疑似 on-demand connect/disconnect 沒收乾淨的 **process leak**，屬另一條線索（見下）。

### (e) 處置與待辦（未動工，待使用者定奪）
- **不改 enablement.json**；BR §10 補 allowlist 會是 no-op。
- 候選修法（opencode 側，二選一或併用）：
  1. dev 模式下對 `local` MCP server 的 entry 檔做 mtime/watch，原始碼變更時 invalidate cache + 重連子行程（最貼根因）；
  2. 至少在 `listTools()` 結果與「server 原始碼 git HEAD 新於子行程 spawn 時間」不一致時 log 警告，讓 stale 不再靜默。
- BR §10 的「server tools ⊆ surfaced tools」單元測試：對 stale-child 無效（測的是當下連線），價值低於上面兩項。
- 旁生線索：~10 個 specbase 子行程並存，疑 on-demand MCP disconnect 未真正 kill stdio child →（若屬實）另開 issue。
- **狀態**：維持 OPEN。修法未實作、未部署、未驗證，不進 observing。
