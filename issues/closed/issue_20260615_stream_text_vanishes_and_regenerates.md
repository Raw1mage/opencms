> **CLOSED 2026-06-23** — bulk-closed per resolved→close: fix committed + deployed; soak window elapsed with no recurrence noted. Folder location (closed/) is the authoritative lifecycle state; the in-body OBSERVING text below is the as-observed record. Reopen if recurrence appears.

# Stream 文字在 runloop 中整段消失後重新生成

Status: OBSERVING (2026-06-20 兩半修復完成、待 live 即時驗證) — 後端 + 前端兩半皆已落地。

- **後端半已修**：`9f2935be0`（merge `337dc18bc`，2026-06-16）。compaction summary-anchor 的大 part（70K `prior_context` body）+ compaction parts 不再廣播給 live SSE（`Session.updatePart { broadcast:false }`）。log 證實阻止了 70K part 串流。**對應 issue 假設 #1/#2 的後端那一段。**
- **前端半已修（本次）**：`<本 commit>` — 壓縮窗（`session.compaction.started → session.compacted`/60s timeout）內前端**延遲套用**對「非 live 訊息」的結構性 churn（`message.removed` 折疊 splice、`message.updated` 既有身份改寫），凍結使用者正在看的 transcript 視覺狀態；窗關閉做一次 atomic `forceReload` 對齊真值。`_liveStreamingIds` 內的 live 串流一律即時放行（`hybrid_llm_background` 續跑不被卡）。被延遲的 remove 仍先設 tombstone（防 active-poll 在窗內 resurrect）。per-session 窗隔離、onCleanup 清旗標防 remount 洩漏、forceReload 失敗顯式 log（no silent fallback）。
  - 檔案：`event-reducer.ts`（`_compactionWindows` + begin/end/isOpen + 兩個 case 延遲分支）、`session.tsx`（compaction listener 開關窗 + `closeCompactionWindow` 統一路徑）、`event-reducer.test.ts`（+2 測試：窗內延遲/放行/窗關恢復、per-session 隔離）。
  - 驗證：`bun test event-reducer.test.ts` 22 pass / 3 fail（3 fail 為**既有** tail-window module-state 污染，`git stash` 後 baseline 同為 20 pass / 3 fail，零回歸；新增 2 測試全綠）。typecheck touched 檔零新增 error。
    Type: Bug Report
    Severity: Medium（影響可觀測性與使用者信任；兩半皆已止血，待 live 觀察壓縮當下文字不再 reflow → 轉 closed）

## Symptom（使用者回報）

在 runloop 執行過程中，正在串流輸出的 assistant 文字**常常突然整段消失，像是被「吞回去」**，然後接著**重新生成文字**。視覺上像是：已經渲染出來的一段 stream 內容被抹除，游標退回，再重新一段段長出來。

## Repro（待補）

- 觸發頻率：使用者描述為「常常」，非偶發 → 應可穩定重現
- 尚未確認：
  - 是否只發生在特定 client surface（TUI / Web SPA / Desktop）？還是全部？
  - 是否與 autorun / 連續 continuation 回合相關（runloop 跨 turn 的銜接點）？
  - 是否與 subagent narration / tool-call 邊界（assistant text → tool call → 回 assistant text）同時發生？
  - 是否與 reasoning channel 與 visible text 兩段內容的合併/切換有關？

## 初步假設（待 instrumentation 驗證，勿先下結論）

可能的因果層次（system-first / boundary-first，尚無 checkpoint evidence）：

1. **純前端渲染回退**：stream 增量 patch 與一次 full snapshot re-render 撞在一起，snapshot 比 client 已渲染的 delta「舊」，導致畫面先被覆蓋回舊狀態再重放。→ event-reducer / message part 合併邏輯。
2. **後端 message part 真的被改寫**：streaming part 在中途被一個新的 part 取代（例如 reasoning→text 切換、或 part 重新分段），client 忠實反映 → 看起來像「吞回去重生」。
3. **跨 turn / continuation 銜接**：runloop 在 turn 邊界重放或 re-emit 部分訊息（synthetic continuation），造成同一段文字被重送。
4. **Bus event 順序 race**：stream delta 與 snapshot/finalize event 抵達 client 的順序顛倒（參考 AGENTS.md infra rule：Bus subscriber 執行時機 vs 讀取時機的 race window）。

## Instrumentation Plan（debug 起手式，依 code-thinker syslog contract）

在開始猜修之前，先在以下 component boundary 埋點觀察「同一段文字被覆蓋」那一刻的輸入/輸出/狀態：

- **後端 message stream 產生端**：assistant text part 的 create / append / replace / finalize event 序列（part id 是否變動、是否有 replace 同一 part id）
- **Bus 傳輸層**：delta event 與 snapshot/finalize event 的相對順序與時間戳
- **前端 event-reducer**：收到 snapshot 時如何 merge 既有 streaming part（是否無條件覆蓋）
- **前端渲染層**：哪個 state 變更觸發「抹除已渲染文字」

關鍵問題：**「消失」的是 client 端已渲染的 delta，還是後端真的丟棄了那段內容？** 這兩者修法完全不同，必須先用 checkpoint 分清楚，不得只看 symptom 在渲染層疊補丁。

## 相關 code anchor（待確認，先記方向）

- 前端 stream 合併：`packages/app` / `packages/web` 的 event-reducer / message part 渲染
- 後端 message part 串流：`packages/opencode/src/session/` 的 message / part streaming
- Bus：`packages/opencode/src/bus/`（event 順序）

## Out of scope（暫定）

- 不在本 issue 處理 stream 文字「內容品質」問題（例如模型自己改寫）——本 issue 只針對「已串流出來的文字被回退/重放」這個渲染/傳輸層現象。

## Next

1. 先確認發生面（TUI / Web / Desktop）以縮小 component 範圍
2. 依 Instrumentation Plan 埋點，抓到「覆蓋當下」的 event 序列證據
3. 用 checkpoint evidence 定性（前端覆蓋 vs 後端回退 vs turn 邊界重放）再決定修法
