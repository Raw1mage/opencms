> **CLOSED 2026-06-23** — bulk-closed per resolved→close: fix committed + deployed; soak window elapsed with no recurrence noted. Folder location (closed/) is the authoritative lifecycle state; the in-body OBSERVING text below is the as-observed record. Reopen if recurrence appears.

# Bug Report: specbase `event_record` 工具在 opencms 環境的工具面缺席（stale local-MCP child；跨環境 surfacing drift）

> **覆寫說明（2026-06-11）**：本 BR 曾被一個 **VSCode 環境**的 agent 以「stale child、daemon 重啟已修、非缺陷」結案並移進 `issues/closed/`。但該結論**只對它的環境成立**。出具本 BR 的 **opencms 環境**此刻仍複現缺陷（live evidence E8）。故重開、改寫成環境感知框架，並把根因從「可選後續」升回**主缺陷**。前一版的 §14 Resolution 保留於本檔末 §15 作為「VSCode 環境視角」存證。

## 0. Handoff Summary

`event_record` 是 AGENTS.md / SYSTEM.md 在 8+ 處硬性要求的 event log **唯一寫入路徑**，且 specbase MCP server 原始碼自 commit `ed8dfc1`（2026-06-10 04:13）起確實註冊了此工具。但 specbase 以 **`local` stdio MCP** 形式由 opencode daemon spawn 成長駐子行程；**opencms 環境**的那個子行程啟動於 `event_record` 加入之前，至今未隨原始碼變動重載，因此其工具面仍是舊清單 —— `specbase_event_record` 在 opencms 的 deferred-tools 缺席（E8，本輪 live 快照），呼叫即被 LLM runtime 回 `unavailable tool`。**另一個 VSCode 環境**的 specbase 子行程較新、`event_record` 正常，該環境 agent 因此無法複現、判為非缺陷並結案。本 BR 為 **confirmed（環境特定，opencms 側 live）**：兩邊原始碼都對，缺陷是「opencode 從本地原始碼 spawn 的 local MCP 子行程，在原始碼變動後不重載，造成跨環境/跨時間的工具面 drift，且無偵測、無告警、靜默失效」。下一個（opencms 側）session 應先用 E8 複現、確認子行程啟動時間早於 `ed8dfc1`，再決定修補方向（重啟該子行程即可暫時恢復；長期需 local-MCP 原始碼變更偵測 + 重載/告警）。

## 1. Bug Identity

| Field                         | Value                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Title                         | specbase `event_record` 工具在 opencms 環境工具面缺席（stale local-MCP child）                                       |
| Component                     | opencode local-MCP 子行程生命週期（spawn / reload）— specbase tool surfacing                                         |
| Reporter                      | Main Agent session `ses_1491aa8feffeJQOpbvWKaFmfjk`（**opencms 環境**；MCP 教案任務收尾時觸發）                      |
| Date                          | 2026-06-11                                                                                                           |
| Severity                      | high — event log 是 canonical 開發紀錄基質；opencms 環境寫入路徑全斷，且失效靜默、跨環境不一致難以察覺               |
| Priority                      | P1 — 不阻塞單一任務產出，但持續破壞 opencms 環境的跨 session 知識沉澱，並造成「一環境能用、另一環境不能」的詭異 drift |
| Status                        | **REOPENED / confirmed（環境特定）** — opencms 環境 live 複現；VSCode 環境因子行程較新而無法複現（前次誤結案，見 §15） |
| Affected versions/tools/paths | `mcp__specbase__event_record` / `specbase_event_record`；opencode local-MCP child lifecycle                          |

## 2. Environment

**這是一個跨環境（cross-environment）缺陷，環境差異本身即根因的一部分，故兩邊都列。**

### 2A. 出具 BR 的環境（opencms — 缺陷 live）

- 角色：本 BR 的 reporter session 所在執行環境（暱稱 opencms）
- session cwd: `/home/pkcs12/projects/documents`
- specbase MCP child：啟動時間**早於** `event_record` 加入（commit `ed8dfc1`, 2026-06-10 04:13）→ 服務舊 tool 清單
- 觀測：本輪 live deferred-tools 快照中 specbase 工具有 `wiki_*`/`event_search`/`event_query`/`plan_*`/`spec_amend`/`spec_tick_task`/`spec_record_event`/`spec_record_decision`/`spec_add_code_anchor`/`spec_sync`/`spec_translate`，**唯獨無 `event_record`**（E8）

### 2B. 結案 BR 的環境（VSCode — 缺陷不複現）

- 角色：前一版 §15 Resolution 的撰寫者所在環境（VSCode）
- specbase MCP child：較新，已含 `event_record`，可正常寫入 `.specbase/events.sqlite`（前版驗證 slug `event_2026-06-11_rca-...`）
- 因此該環境 agent 判為非缺陷、結案

### 2C. 共用事實（兩環境一致）

- specbase server repo: `/home/pkcs12/projects/specbase`（`event_record` 註冊於 `packages/mcp/src/index.ts:292`，handler `:686`）
- specbase MCP 設定: `/home/pkcs12/.config/opencode/mcp.json:4`（`local`：`bun packages/mcp/src/index.ts`，`cwd: /home/pkcs12/projects/specbase`）
- enablement registry: `packages/opencode/src/session/prompt/enablement.json`
- 規範來源: `/home/pkcs12/.config/opencode/AGENTS.md`（多處強制 `event_record`）+ SYSTEM.md
- deferred-tools 由 `packages/opencode/src/tool/tool-loader.ts` 從**該環境 daemon 當下已連線的 MCP 子行程**動態產生 → 工具面 = 子行程當下回報的 tool 清單，子行程 stale → 工具面 stale
- OS/runtime: linux, bun daemon

## 3. Expected Behavior

- 同一份 specbase server 原始碼，在**任何環境**都應暴露相同的工具面；`event_record` 一旦進原始碼，所有環境的 deferred-tools 都應出現 `specbase_event_record`。
- AI 依 AGENTS.md 呼叫 `event_record(summary, body?, scope?, date?, status?, tags?, cites?)` 應成功 append row，無論身處哪個環境。
- 不變量：**規範強制呼叫的工具 = 工具面實際暴露的工具，且跨環境一致**。
- 不變量：local MCP server 原始碼更新後，其工具面更新應在**有界時間內**對所有依賴它的環境生效，或至少**可被偵測/告警**，不得靜默 drift。
- 絕不該發生：同一工具在 A 環境可用、B 環境回 `unavailable tool`，且無任何訊號解釋差異。

## 4. Actual Behavior

- **opencms 環境（live）**：`specbase_event_record` 不在 deferred-tools（E8）。呼叫 → LLM runtime `experimental_repairToolCall` 失敗 → `Model tried to call unavailable tool 'specbase_event_record'`（E1）。event log 在本 session 無法寫入。
- **VSCode 環境**：同一工具正常，可寫入（§15）。
- 兩環境差異純由 specbase `local` 子行程的**啟動時間**決定（早於/晚於 `ed8dfc1`），無任何使用者可見訊號，造成「同一台機、同一份原始碼、不同環境結論相反」的靜默 drift。
- 副作用：因 server 原始碼**檔案系統上有** `event_record`、但 opencms 子行程**沒服務它**，極易誤判為「opencode 端過濾掉了工具」（前版 BR 的 H1 即此誤判，見 §15 已被推翻）。

## 5. Steps To Reproduce

1. 在 **opencms 環境**任一 session 檢視 deferred-tools 中 specbase 區段
   - 預期：含 `specbase_event_record`
   - 實際：無（僅 `event_search`/`event_query`/`spec_record_event` 等）
2. 呼叫 `specbase_event_record({summary:"test", body:"test", scope:"documents"})`
   - 預期：成功 append row
   - 實際：`unavailable tool 'specbase_event_record'`
3. 對照呼叫 `specbase_event_search({q:"test"})`
   - 實際：正常 → 證明 specbase MCP 連線本身健康，只是子行程的 tool 清單 stale
4. 確認子行程啟動時間：找出 opencms daemon spawn specbase child 的時間戳，對照 `git -C /home/pkcs12/projects/specbase log ed8dfc1`（2026-06-10 04:13）
   - 預期佐證：子行程啟動 < `ed8dfc1` 時間 → 服務舊清單
5. （恢復驗證）重啟 opencms 的 specbase 子行程 / daemon 後重做步驟 1-2
   - 預期：`event_record` 出現且可呼叫

## 6. Evidence

| Evidence | Type      | Reference                                                          | What it shows                                                                                                  |
| -------- | --------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| E8       | manifest  | 本輪 opencms live deferred-tools 快照（system-reminder）          | **live**：specbase 暴露 `event_search`/`event_query`/`spec_record_event` 等，**無 `event_record`** — 缺陷未消 |
| E1       | tool call | `toolu_01KqvjsmJcLx8Lzx9Vot5SBH`（本 session）                     | `Model tried to call unavailable tool 'specbase_event_record'` — 呼叫被 LLM runtime repair 失敗拒絕            |
| E2       | file      | `/home/pkcs12/projects/specbase/packages/mcp/src/index.ts:292`    | server **註冊** `name: "event_record"`；`:686` 為 handler。原始碼確實有                                        |
| E9       | git       | `specbase` `ed8dfc1`（2026-06-10 04:13）/ `7e0da31`（06-10 14:24）| `event_record` 的引入 commit；opencms 子行程啟動早於此即會缺工具                                               |
| E3       | file      | `/home/pkcs12/projects/specbase/packages/mcp/src/index.ts:401,886`| 同檔註冊 `spec_record_event`（slug-scoped），此工具兩環境皆 surface                                            |
| E7       | file      | `/home/pkcs12/.config/opencode/mcp.json:4`                        | specbase 為 `local` MCP（`bun packages/mcp/src/index.ts`）→ 長駐子行程、不隨原始碼 hot-reload                  |
| E6       | file      | `/home/pkcs12/.config/opencode/AGENTS.md:132,222,249,283`         | 規範強制 `event_record` 為 event log 唯一寫入路徑，commit gate 把關                                            |
| E10      | file      | `packages/opencode/src/tool/tool-loader.ts`                       | deferred-tools 從當下已連線 MCP 子行程動態產生 → 子行程 stale 則工具面 stale（前版 §15 認定，非 enablement 過濾）|

> 註：前版 BR 的 E4「enablement.json `provides` allowlist 漏列」已被 §15 推翻 —— 該檔無 `provides` key、不 gate 工具暴露，當時看到的是 `prefer` 陣列。本版不再以 enablement 過濾為假設。

## 7. Impact / Risk

- **opencms 環境跨 session 知識沉澱全斷**：event log 寫入路徑在該環境不可用，所有決策/RCA/checkpoint 無法落盤，`event_search` 未來撈不到本應存在的紀錄。
- **跨環境不一致 + 靜默失效**：最危險之處不是「壞」，而是「一環境好、一環境壞且無訊號」。導致：
  - agent 誤判根因（前版直接誤判成 enablement 過濾，浪費一輪調查）
  - 在能用的環境結案、在不能用的環境繼續壞，issue 在 closed/ 與 live 缺陷間錯位
- **規範與能力在 opencms 自相矛盾**：commit gate 要求「event log 已透過 `event_record` 寫入」，但工具不存在 → 遵守規範的 agent 卡死或被迫違規跳過。
- blast radius：所有 specbase 子行程啟動早於相關原始碼變更的 opencode 環境（不限本 repo、不限單次）。屬 local-MCP 開發配置的系統性風險，非一次性。
- 無資料損毀（寫不進去而非寫壞），屬持續性資料**遺漏** + **跨環境觀測不一致**。

## 8. Root-Cause Hypotheses

### H1（refuted，保留以防再次誤入）：opencode enablement / tool 過濾把 `event_record` 篩掉

Confidence: refuted

- 已由前版 §15 推翻：enablement.json 無 `provides`、不 gate 工具暴露；deferred-tools 由 `tool-loader.ts` 從已連線子行程動態產生，opencode 端**沒有**過濾 `event_record`。
- 保留此條的唯一目的：阻止後續 session 重蹈「看到原始碼有、工具面沒有 → 以為 opencode 過濾」的覆轍。

### H2（confirmed，已由精確 git 時間線強化）：specbase `local` 子行程 stale —— 啟動落在「`event_search`/`event_query` 已加入、但 `event_record` 尚未加入」的 2 小時窗口

Confidence: high（opencms 環境）

**決定性證據（E11，git 時間線）**：三個 event 工具**並非同批加入**：
- `event_search` + `event_query`：commit `b59b37d`，**2026-06-10 02:14:25**
- `event_record`：commit `ed8dfc1`，**2026-06-10 04:13:28**（晚約 2 小時）

live 工具面（E8）觀測：`event_search`/`event_query` **在**、`event_record` **不在**。這**精確對應**一個啟動時間落在區間 **[02:14:25, 04:13:28)** 的子行程 —— 它載入時 server 原始碼已有 search/query、尚未有 record。

> 這條時間線同時**排除了**一個一度看似成立的反證：「若子行程 stale，三個 event_* 應一起缺席」。該反證建立在「三者同批加入」的錯誤前提；git 史證明它們相隔 2 小時，故「只缺 record、不缺 search/query」非但不矛盾，反而是 stale-child 假設的**強佐證**，並把子行程啟動時間夾擊到 2 小時窗口內。

其餘佐證：
- E7：specbase 是 `local` stdio MCP，由 daemon spawn 成長駐子行程；stdio MCP 標準行為是不 hot-reload。
- E2：`event_record` 原始碼確實註冊於 `index.ts:292`（handler `:686`）。
- 跨環境對照：VSCode 環境子行程較新（啟動 ≥ 04:13）→ 有此工具（§15）。差異完美對應「子行程啟動時間 vs commit 時間」。

How to confirm:

- 取得 opencms daemon spawn specbase child 的啟動時間戳，確認落在 **[2026-06-10 02:14:25, 04:13:28)** 區間內（或至少早於 `ed8dfc1` 04:13）。
- 重啟該子行程後 E8 步驟複測 → `event_record` 應出現。

How to refute:

- 若子行程啟動時間明明 ≥ `ed8dfc1`（04:13）卻仍缺工具 → H2 不足以解釋，需查 server 端是否該環境跑的是不同 checkout / 分支 / 未拉取最新原始碼。

### H3（design-level，本 BR 主張的「該修點」）：local-MCP 原始碼變更後缺乏重載/偵測機制，使工具面靜默 drift 成為固有副作用

Confidence: medium-high

Why plausible:

- H2 的單次表現是「stale child」，但其**系統性成因**是 opencode 從本地原始碼直跑 local MCP server、卻不在原始碼變動時重載或告警。只要這個機制不存在，drift 會週期性復發（本 BR 正是復發證明：前版在 VSCode 已「驗證修好」，opencms 仍壞）。
- 前版 §15 把此點降級為「可選後續、價值較低、stdio 標準行為」。本版主張：對**長駐、多環境、且把 local MCP 當 first-class 能力來源**的 opencode 而言，這是該被當缺陷處理的營運性問題，而非可忽略的固有副作用。

How to confirm / refute:

- 設計層討論：是否該為 `local` MCP 增加「server 原始碼 mtime/commit 變更偵測 → 提示或自動重載子行程」。若團隊認定 local MCP 僅供開發、可接受手動重啟，則降級為文件化注意事項；否則列入修補。

## 9. Workarounds

- **暫時恢復（opencms）**：重啟 opencms 的 specbase `local` 子行程（或 daemon），讓它重新 spawn 並載入含 `event_record` 的新原始碼。重啟後 E8 步驟應通過。
  - 注意：依 AGENTS.md「Daemon Lifecycle Authority」，AI **不得**自行 kill/restart daemon；此步驟需使用者或 `system-manager:restart_self` 合法路徑執行。
- **替代記錄**：在重啟前又必須留開發紀錄時，退回 markdown 事件檔（違反 sqlite-only 新範式，僅過渡，事後需清理）。
- **不要做**：不要再嘗試改 enablement.json 補 allowlist —— 已證實 no-op（§15）。

## 10. Proposed Fix Direction

- **短期（恢復）**：重啟 opencms specbase 子行程；非程式改動，僅環境操作。
- **長期（治本，對應 H3）**：為 opencode 的 `local` MCP 子行程增加原始碼變更偵測 —— server 入口/原始碼 mtime 或 git HEAD 變動時，提示使用者或受控重載該子行程，避免工具面靜默 drift。
- **可選防呆**：當 LLM runtime 出現 `unavailable tool 'mcp__<server>__<x>'` 但該 server 原始碼確有註冊 `<x>` 時，emit 一條診斷 log（「疑似 stale MCP child，建議重啟」），把靜默失效變成可見訊號。
- 相容性：上述皆為附加偵測/告警或受控重載，不改 MCP 協定、不破壞既有工具行為。
- 不採用：前版建議的「server tools ⊆ surfaced tools 單元測試」對本根因無效（單元測試跑的是當下原始碼，抓不到 runtime stale child）。

## 11. Acceptance Criteria

- positive：opencms 環境呼叫 `specbase_event_record({summary, body, scope})` 成功 append → `event_search` 撈回。
- negative：opencms 環境呼叫不再回 `unavailable tool`。
- cross-env：同一份 specbase 原始碼下，opencms 與 VSCode 兩環境的 specbase 工具面一致（皆含 `event_record`）。
- regression：`event_search`/`event_query`/`spec_record_event` 等行為不變。
- diagnostics（若採 H3 修補）：local MCP 原始碼變更後，子行程未重載時有可見提示/告警，而非靜默。

## 12. Open Questions

- opencms daemon 何時、以何條件重新 spawn specbase 子行程？是否有自動重啟週期，還是需手動/restart_self 觸發？
- 此 drift 是否也波及 specbase 以外的 `local` MCP（drawmiat、docxmcp 也是 local）？需確認是否為通用 local-MCP 生命週期問題。
- 團隊對「local MCP 是否該支援原始碼變更自動重載」的取態 —— 決定 H3 是修補還是文件化注意事項。
- closed/ 與 live 缺陷錯位的流程問題：跨環境 BR 結案前，是否該要求「在所有相關環境複現/不複現」才能 close？

## 13. Next Session Checklist

1. 在 **opencms 環境**用 E8 複現：檢視 deferred-tools specbase 區段確認無 `event_record`。
2. 呼叫 `specbase_event_record({summary:"repro", body:"x", scope:"documents"})` 觀察 `unavailable tool`。
3. 取得 opencms specbase 子行程啟動時間，對照 `git -C /home/pkcs12/projects/specbase show -s --format=%ci ed8dfc1`（2026-06-10 04:13）確認 stale。
4. recall 證據：tool call `toolu_01KqvjsmJcLx8Lzx9Vot5SBH`（unavailable tool）。
5. 檢視程式：`packages/opencode/src/tool/tool-loader.ts`（工具面如何從子行程產生）+ `mcp.json:4`（local spawn 設定）+ local MCP 生命週期/重載路徑。
6. 經合法路徑（使用者 / `system-manager:restart_self`）重啟 specbase 子行程，重做步驟 1-2 驗證恢復。
7. 決策點：是否實作 H3 的 local-MCP 原始碼變更偵測/告警。
8. 預期停點：opencms 環境 `event_record` 可寫且 `event_search` 撈回；或團隊明確把 H3 降級為文件化注意事項並記錄理由。

---

## 15. 前版 Resolution 存證（VSCode 環境視角 — 對該環境成立，對 opencms 不成立）

> 以下為前一個 **VSCode 環境** agent 的結案內容，原樣保留。其機制 RCA（stale child）正確且有價值，但**處置結論（非缺陷、直接結案）僅對 VSCode 環境成立**。opencms 環境 live 複現（E8）推翻其「已修」前提，故本 BR 重開。特別注意：其 §「H1 refuted」對 enablement.json 的分析是正確且通用的，兩環境皆適用。

### H1 refuted（enablement.json 不是 gate）— 兩環境通用、正確
- enablement.json **沒有** `provides` 這個 key；全 codebase grep `provides` 無消費它的程式碼。該檔只是 `intent`/`keywords`/`prefer`/`fallback` 的 routing 提示，不 gate 工具暴露。
- 檔內完全沒提 `event_record`/`event_search`/`event_query`。前版 §H1 把 specbase 區塊的 `prefer` 陣列誤讀成 `provides` allowlist。
- deferred-tools 由 `tool-loader.ts` 從所有已註冊 MCP 工具動態產生；`unavailable tool` 來自 LLM runtime 的 `experimental_repairToolCall` 失敗，不是 opencode 端過濾。

### 真正根因：stale MCP child process — 機制正確
- `event_record` 於 commit `ed8dfc1`（2026-06-10 04:13）加入 server。
- specbase 是 `local` MCP，由 daemon spawn 長駐子行程；命中的子行程啟動於 event_record 加入前 → 服務舊 tool 清單。

### VSCode 環境的驗證（僅該環境成立）
- positive：`event_record({...})` 成功 append → slug `event_2026-06-11_rca-specbase-event-record-unavailable-tool-stale-m_9nblx2`。
- negative：該環境不再回 `unavailable tool`。
- **但**：此驗證在 VSCode 環境的新子行程上成立；opencms 環境的舊子行程未受影響，缺陷續存（本 BR 主體）。

### 前版處置（本 BR 修正）
- 前版：判非缺陷、直接結案、列 H3（重載偵測）為「可選後續、價值較低」。
- 本 BR 修正：對多環境長駐 daemon 而言，跨環境靜默 drift 是 P1 營運缺陷；H3 升為主修補方向。短期重啟恢復、長期需 local-MCP 變更偵測。

---

## 16. Fix 實作（2026-06-11，治本 = H3；待 rebuild+restart 部署與 opencms 端驗證）

對應 §10「長期治本」與 §11 diagnostics。修改 [packages/opencode/src/mcp/index.ts](packages/opencode/src/mcp/index.ts)，為**所有** `local` stdio MCP 子行程加入「entry 原始碼 mtime 監看 + 自動重連」（不限 specbase；直接回答 §12「drawmiat/docxmcp 等其他 local MCP 是否同受影響」——是，且本修一併涵蓋）：

- `resolveLocalSourceWatch(command, cwd)`：解析 local 命令真正在跑的原始碼檔——跳過 `bun`/`node`/`npx`/`tsx`… 等 interpreter token，取第一個存在的檔（script 或 compiled binary）；npx 套件等無本地檔者回 undefined（無法偵測、不動）。擷取該檔 mtime。
- spawn 成功時把 `{entryPath, mtimeMs}` baseline 進 state `localSourceWatch`（涵蓋 auto-connect / `add()` / `connect()` 三條 client 指派路徑；`disconnect()` 清除）。
- `tools()` 取用 client 前呼叫 `refreshStaleLocalServers()`：對 connected local server 重新 stat，mtime 變了即 **`log.warn`（把靜默失效變可見訊號，對應 §10 可選防呆 + §11 diagnostics）→ 關閉舊 child → `create()` 重連 → invalidate cache → publish `ToolsChanged`**。以 `STALE_CHECK_INTERVAL_MS = 3000` 節流 stat sweep。
- 效果：本事件這類「直接編輯 server entry（`index.ts` 加 tool）」會在下一次 `tools()`（≤3s 節流）被偵測並自動重連，**無需手動重啟 daemon**；工具面 drift 不再靜默。

### 驗證（程式層，已綠）
- `bun run --cwd packages/opencode typecheck` → 0 error。
- 新增 [test/mcp/local-source-watch.test.ts](packages/opencode/test/mcp/local-source-watch.test.ts) → 5/5 pass（interpreter 跳過、相對/絕對路徑解析、npx→undefined、mtime 變動偵測）。

### 已知侷限（檔內註解標明）
- 只監看 **entry 檔** mtime。若改的是 entry 所 `import` 的相依模組而未動 entry 檔，偵測不到。本事件正是直接改 entry（合涵蓋範圍）。完整解需 watch 整個 source tree，依「大道至簡」不納入，列為已知取捨。

### 尚未完成（故 BR 維持 OPEN）
- **未 rebuild + restart 部署**：需經合法路徑（`system-manager:restart_self` 或使用者）重建並重啟 daemon，fix 才生效；restart 亦會順帶重 spawn 那個 stale 的 specbase 子行程，立即恢復 opencms 端 `event_record`。
- **未做 opencms 端端到端驗證**：部署後應在 opencms 環境複現 §11 acceptance（呼叫 `specbase_event_record` 成功、`event_search` 撈回、cross-env 工具面一致），並實測「編輯 local server 原始碼 → 看 opencode 自動重連 + 新工具出現 + log.warn」。
- 通過上述即可移 `observing/`（soak 觀察無復發後再 `closed/`）。
- 旁生線索仍待查：機器上 ~10 個 specbase 子行程並存，疑 on-demand disconnect 未真正 kill stdio child 的 process leak（另開 issue）。

---

## 17. RESOLVED → observing (2026-06-12)

specbase 已改為 opencode 行程內 native toolcall（plan `specbase/internal-toolcall-dual-track`，部署上線 daemon 95537）。**opencode 不再 spawn specbase MCP 子行程**，本 BR 的觸發成因（stale specbase child）對 specbase 永久消失。其餘真·外部 MCP（docxmcp/drawmiat）的 stale 由 reconnect fix `76cae876c`（同批部署）涵蓋。
Status: OBSERVING — specbase 去-MCP 化 + reconnect fix 雙重部署；soak 觀察無復發後 → closed。
Observing since: 2026-06-12. Exit → closed/：數日無 specbase-相關 stale 復發。Regress → open：specbase 工具面再現 stale。
