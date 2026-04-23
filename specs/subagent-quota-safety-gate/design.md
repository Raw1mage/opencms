# Design: subagent-quota-safety-gate

## Context

這份 spec 在 2026-04-23 經歷過一次 scope pivot：從「AI 觀測 tool」改為「runtime 強制 quota gate + 附屬觀測 tool」。原因：`SYSTEM.md` 已有的 5% wrap-up 文字規則在實務中對 subagent 完全不生效，而 subagent 有自己的 pinned `execution.accountId`、rotation 預設尊重 pin 不動它。事故模式一再是 subagent 把單一帳號 5H window 燒爆。結論：這件事不能靠 AI 自律，必須 runtime 硬攔。

技術面既有的基礎：
- Rotation 在首次 request 後把 `{providerId, modelID, accountId}` 用 `pinExecutionIdentity()` 寫進 session info.json（[processor.ts:463-470](packages/opencode/src/session/processor.ts#L463-L470)）— 這就是 subagent 當前用的帳號
- `getCodexUsage()` 每次呼叫都打 live API，無 cache、無 timestamp（[system-manager/index.ts:261](packages/mcp/system-manager/src/index.ts#L261)）— gate 若直接用會 hammer OpenAI
- Task tool 的 subagent runloop 在 [packages/opencode/src/tool/task.ts](packages/opencode/src/tool/task.ts) — 這是插入 gate 的位置
- 既有 cancel reason / CancelReason union 已存在（[session/prompt-runtime.ts](packages/opencode/src/session/prompt-runtime.ts)，參考 `runaway-guard` reason 的前例）

## Goals / Non-Goals

### Goals

- Subagent 5H 或 weekly 任一跌破 5% → runtime 強制終止，不給 LLM 再燒的機會
- Parent 收到的不是 crash 而是結構化 handover（SharedContext + runtime 自動摘要）
- Gate 邏輯與觀測 tool 共享同一份 quota 資料源（`AccountQuotaProbe` registry + `quota-cache.json`）
- 保留 v1 的觀測 tool 能力作為附屬

### Non-Goals

- 不重構 rotation3d（request-gated → background ticker 留給 `process-liveness-contract`）
- 不在 subagent 內部做 rotation 或 re-pin（不動 rotation 契約）
- 不替 parent 自動重派（policy 留給 parent LLM / 使用者）
- 不處理 root session / parent / 非 task-tool session 的 quota 問題
- 不追求 LLM-品質的摘要（runtime 機械生成就夠）

## Decisions

### 主線（v2 gate）

- **DD-10** Gate 插入點 = subagent runloop 的 **pre-dispatch hook**：每輪 tool-call 結束、下一次要把 message 送去 provider 之前。
  - 位置：`packages/opencode/src/tool/task.ts` subagent 執行迴圈 OR 共用的 session runloop（`prompt.ts` / `processor.ts`）— 實作時選最薄的那一層（若共用 runloop 能只加一個 `if (isSubagent)` 就最好）。
  - Rationale：tool-call 邊界粒度夠細（不會連燒十次）且成本低（每輪僅一次 cache 讀取）；選 pre-dispatch 而非 post-tool-call 是因為要擋的是「下一次 provider 呼叫」而非「上一次的已成事實」。

- **DD-11** 判斷「這個 session 是不是 task-tool subagent」的依據 = `session.parentSessionID` 存在 **且** `session.source === "task-tool"`（或等價的 spawn-origin 標記）。
  - 若現有 session info 沒有 `source` 欄位，**補**一個並在 task tool spawn 時標註。
  - 其他 spawn 路徑（MCP handover、使用者手開）**不**標 `task-tool`，自動不進 gate 範圍。
  - Rationale：光靠 `parentSessionID` 不夠區分（MCP handover 也有 parent）；要明確標「這是 task-tool 生的」。

- **DD-12** Gate 觸發條件 = `min(fiveHourPercent_remaining, weeklyPercent_remaining) < threshold`。`remaining = 100 - used_percent`。
  - `triggerWindow` 取數值較低者；若並列，優先回報 `"5h"`（時間尺度較短 → 使用者 recovery 較快，優先曝光）。
  - Threshold 預設 5，可由 `/etc/opencode/tweaks.cfg` 的 `subagent.quota_gate_threshold_percent` 覆寫。

- **DD-13** Cancel 路徑 = 新增 `CancelReason: "quota-gate-trip"`；由 runtime（非 subagent 的 LLM）觸發 cancel。
  - Subagent 的 runloop 收到 cancel 後走正常 cancel 路徑，但 task tool 層攔截這個特定 reason 組成結構化 result（見 DD-15），而非讓 parent 看到「manual_interrupt」或 error。
  - 注意：[prompt.ts:390-403 已知 bug](packages/opencode/src/session/prompt.ts#L390-L403)（`manual_interrupt` stopReason 寫死）要**先**修，否則這個 reason 會被覆蓋。此修補列入 tasks.md 為 prerequisite task。

- **DD-14** 「寧縱勿誤殺」fallback 語義明確化：
  - Probe 不存在 / cache 完全空 / probe 拋例外 → gate **放行**（不 cancel）+ WARN log
  - Probe 回 stale 但有數字（`ageSeconds > TTL`）→ gate 正常觸發 refresh；refresh 失敗則退回放行 + WARN
  - Probe 回的數字明顯異常（<0 或 >100）→ 當 missing 處理，放行 + WARN
  - Rationale：誤殺比放行難處理（使用者看到 subagent 莫名死亡會失去信任）；放行只是回到 pre-gate 的 status quo。WARN log 確保不會靜默失效。

- **DD-15** Structured summary 由 runtime 機械生成，**不**呼叫 LLM：
  - 生成器位置：`packages/opencode/src/session/quota-trip-summary.ts`（新檔）
  - 輸入：subagent sessionID、SharedContext snapshot、session message list
  - 掃描邏輯：
    - `completedToolCalls`：掃 session messages 的 tool_use + tool_result pairs，取後 20 筆
    - `readFiles` / `editedFiles`：從 tool_use 的 name + args 提取（Read tool → readFiles，Edit/Write → editedFiles），unique + path 歸一化
    - `lastMessages`：取最後 3 則 assistant message 的 text content，每則截 500 字
    - `pendingWork`：若 session 有 TodoWrite state 且存在 non-completed items，輸出 content + status；否則空陣列
  - 為 pure function，輸入 snapshot 輸出 JSON — 可單元測試

- **DD-16** Task tool 回傳 schema 擴充：原本 task tool 結束回傳 final assistant text；現在額外支援「trip result」型別：
  ```ts
  type TaskResult =
    | { tripped: false, finalText: string }
    | { tripped: true, reason: "quota-gate-trip", triggerWindow: "5h" | "weekly", remainingPercent: number, summary: StructuredSummary, sharedContext: string }
  ```
  - Parent LLM 收到後看 `tripped` 欄位分流；tool description 要明示這個型別

### 共享層

- **DD-17** Quota 資料源 = 單一 `AccountQuotaProbe` registry（原 v1 DD-5，保留） + 單一 `quota-cache.json`（原 v1 DD-3，保留）。Gate 與觀測 tool 都呼叫同一組介面，看到同一份 cache。
  - TTL 由 `quota.cache_ttl_seconds` 控制，預設 60。
  - Gate 呼叫 probe 時若 cache 過期會自動 refresh — 這會讓 gate 觸發點可能有一次 live fetch 成本；可接受（1 req/60s/account 上限）。

- **DD-18** `tweaks.cfg` 新增三個 knob：
  - `subagent.quota_gate_enabled`（default `true`）
  - `subagent.quota_gate_threshold_percent`（default `5`）
  - `quota.cache_ttl_seconds`（default `60`，gate 與觀測 tool 共用）

### 支援線（v1 觀測 tool，保留不變）

- **DD-1 ~ DD-7**（v1）：全部保留。詳見 proposal.md v1 Revision History 與先前版本 design.md。核心摘要：
  - DD-1：inflight account = session.execution.accountId
  - DD-2：MCP bridge 自動注入 sessionID
  - DD-3：quota-cache.json + TTL 60s（與 gate 共用）
  - DD-4：`get_system_status` 加 `currentInflightAccount`
  - DD-5：`AccountQuotaProbe` 介面（與 gate 共用）
  - DD-6：tool description 帶 heuristic
  - DD-7：read-only import allow-list（觀測 tool，不含 gate — gate 當然有 cancel 權）

## Risks / Trade-offs

- **R-10** 5% 門檻在快速燒的情境下仍來不及 — 例如 subagent 一輪 tool-call 就從 6% 燒到 3%。→ tool-call 邊界檢查只能抓到邊界時刻；若單輪消耗 >1% 理論上會穿門檻。緩解：tweaks.cfg 可把門檻調高（例如 10%）。
- **R-11** Cache TTL 60s 可能讓 gate 看到的是 1 分鐘前的數字，實際帳號其實已耗盡。→ 接受；快速情境下 codex 自己會開始 429 走 rotation 既有路徑。Gate 的目標是「絕大多數情況下避免燒乾」，不是「絕對保證不燒乾」。
- **R-12** Parent LLM 看到 structured trip result 仍可能「沒讀懂就重派」導致無限迴圈。→ 緩解：tool description 明示 trip 語義；但最終還是人/LLM 行為問題，policy 不在這個 spec 內解決。未來若發現問題可加一個 parent-side 重派計數上限。
- **R-13** Session `source` 欄位補上之後，**既有** session info.json 沒有這個欄位 — 判斷要 fallback。→ 緩解：missing source 視為「非 task-tool」（不攔）；從此刻起 spawn 的新 subagent 才會標 `task-tool`。屬於 on-touch 遷移，不做 batch migration。
- **R-14** 結構化摘要即使截斷後仍可能 > parent context 可容納的量。→ 緩解：硬上限（completedToolCalls 20、lastMessages 3×500 字）；極端情況 parent LLM 自行處理長 tool result。
- **R-15** Gate 觸發後 subagent 的 SharedContext 若正在被其他寫入 path 修改，snapshot 可能不一致。→ 緩解：snapshot 取副本（shallow clone 對 SharedContext 足夠，它本身已是 immutable-ish）；若不夠就在 cancel 前加一個 write barrier。

## Critical Files

### 主線
- [packages/opencode/src/tool/task.ts](packages/opencode/src/tool/task.ts) — subagent spawn 時標 `source: "task-tool"`；gate check hook 可能加在這裡
- [packages/opencode/src/session/prompt.ts](packages/opencode/src/session/prompt.ts) OR processor.ts — pre-dispatch gate hook 的實際位置（實作時擇一）
- [packages/opencode/src/session/prompt-runtime.ts](packages/opencode/src/session/prompt-runtime.ts) — 新增 `CancelReason: "quota-gate-trip"`
- `packages/opencode/src/session/quota-trip-summary.ts`（**新檔**）— 結構化摘要生成器
- [packages/opencode/src/session/index.ts](packages/opencode/src/session/index.ts) — Session schema 可能要加 `source` 欄位
- Task tool result schema — 需要擴充成 union 型別

### 共享 / 支援線
- `packages/opencode/src/account/quota-probe.ts`（**新檔**）— registry + 介面
- `packages/opencode/src/account/quota-probe-codex.ts`（**新檔**）— codex 實作包裝 `getCodexUsage`
- `~/.config/opencode/quota-cache.json`（**新 runtime state**）
- [packages/mcp/system-manager/src/index.ts](packages/mcp/system-manager/src/index.ts) — 新 `get_my_current_usage`、擴 `get_system_status`
- [packages/opencode/src/mcp/index.ts](packages/opencode/src/mcp/index.ts) — bridge 自動注入 sessionID（v1 DD-2）
- `/etc/opencode/tweaks.cfg` — 三個 knob

### Prerequisites（要先處理）
- [packages/opencode/src/session/prompt.ts:390-403](packages/opencode/src/session/prompt.ts#L390-L403) — `manual_interrupt` stopReason 寫死的 bug；必須修好讓新 cancel reason 能正確傳遞

## Data Flow（Gate 觸發路徑）

```
Subagent LLM 發完一輪 tool_use → tool_result
    │
    ▼ (pre-dispatch hook)
Runtime: isSubagent(session)?  ── false → 正常走原路徑
    │ true
    ▼
Runtime: probe quota for session.execution.accountId
    │
    │ via AccountQuotaProbe registry (共用 quota-cache.json, TTL 60s)
    ▼
remainingPercent = min(5H, weekly)
    │
    ├─ >= threshold → 正常繼續，送下一筆 provider request
    │
    └─ < threshold → gate trip
            │
            ▼
       Runtime: cancel(session, reason="quota-gate-trip")
            │
            ▼
       Runtime: generate structured summary (quota-trip-summary.ts)
            │
            ▼
       Task tool: 組 TaskResult { tripped: true, ... } 回給 parent
            │
            ▼
       Parent session: 收到 tool_result → parent LLM 自行決定
```

## Open Questions for Implementation Phase

- Gate hook 放在 `task.ts`（subagent 層）還是 `prompt.ts` / `processor.ts`（共用 runloop 加 isSubagent 分支）？— 傾向後者，但要看現有架構的介面粒度
- Session `source` 欄位要加在 `Session.Info`（info.json）還是另起一個 meta 檔？— 傾向前者
- `pendingWork` 要從 TodoWrite 的 runtime state 抓 — 那份 state 存在哪？（可能在 session messages 裡的 tool_use args）
- 觀測 tool bridge 注入 sessionID 的機制（v1 DD-2）— 具體怎麼從 `dynamicTool` 層取到當次 request 的 sessionID？需要補設計
