# Proposal: Shared Context Structure

## Why

Orchestrator/Subagent 架構存在兩個獨立但本質重複的記憶機制，導致三個核心問題：

1. **跨 session 知識斷層**：subagent 是全新 session，只收到 task prompt string，無法取得 orchestrator 已建立的知識（已讀檔案、分析結論、修改紀錄）
2. **Session 內記憶低效**：tool outputs（read/grep/bash）佔大量 tokens，但 LLM 消化後這些原始資料的邊際價值急遞減
3. **Compaction 品質不穩定**：free-form summary 依賴另一次 LLM call，品質與格式不可預期

核心洞見：Digest（給 subagent 的知識注入）和 Compaction（session 自身的記憶壓縮）**是同一件事**。兩者都在回答：「到目前為止，這個 session 知道了什麼？」

## Original Requirement Wording (Baseline)

- "能不能考慮直接context share搭配適當的動態compaction策略"
- "maintain一個shared context space，每次有subagent call的時候就由main session update這個space。而且這個shared context space可能可以當成一次main session的compaction來用"
- "Orchestrator委派subagent後的等待時間，通常是很好的空檔可以跑跑Compaction"
- "它仍然可以視使用率決定要不要略過不跑"

## Effective Requirement Description

1. Main session 維護一個結構化、增量更新的 shared context space
2. Subagent dispatch 時，shared context 作為起始知識注入（同步）
3. Dispatch 後等待空檔，評估 utilization 決定是否觸發 idle compaction（async, non-blocking）
4. Overflow compaction 優先使用 shared context 作為 summary，省掉 compaction agent LLM call
5. Shared context 為空時，fallback 到現有 compaction agent 行為

## Scope

### IN

- Shared context space 的結構定義與持久化
- 增量更新邏輯（per-tool 分支 + 啟發式文字萃取）
- Subagent 注入機制
- Idle compaction（dispatch 後 async background）
- Overflow compaction 整合
- Config 擴展（sharedContext / sharedContextBudget / opportunisticThreshold）
- Telemetry 指標

### OUT

- 跨 session 的 persistent memory store
- Worker pool 架構變更
- Per-tool TTL 政策
- Prune 機制變更（position-based prune 保留原樣）

## Non-Goals

- 讓 subagent 維護自己的 shared context space（subagent 短命且自足）
- 取代 position-based prune（prune 處理原始資料清理，shared context 處理知識摘要）
- LLM-based extraction（初期用啟發式 regex，zero additional token cost）

## Constraints

- 只有 main session（`!session.parentID`）維護 shared context
- Idle compaction 必須是 fire-and-forget，不阻塞 subagent dispatch
- Shared context 自身有 token budget 限制（default 8192）
- Config 停用時（`sharedContext = false`）必須完整 fallback 到現有行為

## What Changes

- **新增** `session/shared-context.ts`：核心模組，包含 Space model、updateFromTurn、snapshot、consolidate
- **修改** `tool/task.ts`：dispatch 前注入 shared context snapshot + dispatch 後排程 idle compaction
- **修改** `session/compaction.ts`：process() 優先使用 shared context 作為 summary
- **修改** `session/prompt.ts`：turn 完成後觸發 SharedContext.updateFromTurn()
- **修改** `config/config.ts`：新增 3 個 config 欄位

## Capabilities

### New Capabilities

- **Shared Context Space**：per-session 結構化知識表面，增量更新，支援 snapshot 輸出
- **Subagent Knowledge Injection**：subagent 開工即擁有 orchestrator 的檔案索引、分析結論、操作紀錄
- **Idle Compaction**：利用 dispatch 後等待空檔進行背景 compaction，提前釋放 context 空間
- **Zero-LLM Compaction**：使用結構化 snapshot 取代 free-form LLM summary

### Modified Capabilities

- **Overflow Compaction**：新增 shared context 優先路徑，shared context 為空時 fallback 到現有 LLM compaction agent

## Impact

- `packages/opencode/src/session/shared-context.ts`（新增）
- `packages/opencode/src/tool/task.ts`（修改 dispatch 流程）
- `packages/opencode/src/session/compaction.ts`（修改 process()）
- `packages/opencode/src/session/prompt.ts`（修改 turn completion 流程）
- `packages/opencode/src/config/config.ts`（新增 config schema）
- 預期節省：跨 session 重複讀檔 ~40k tokens/delegation、compaction 省掉一次 LLM call
