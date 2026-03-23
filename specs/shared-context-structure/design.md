# Design: Shared Context Structure

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Main Session                           │
│                                                             │
│  turn 1 ──▶ tool calls ──▶ SharedContext.update()           │
│  turn 2 ──▶ tool calls ──▶ SharedContext.update()           │
│  turn 3 ──▶ task(coding) ─┐                                │
│                            │ SharedContext.snapshot()        │
│                            ▼                                │
│            ┌──────────────────────────┐                     │
│            │  Subagent Session        │                     │
│            │  msg[0]: shared context  │                     │
│            │  msg[1..n]: own work     │                     │
│            └──────────────────────────┘                     │
│                                                             │
│  turn 4 ──▶ tool calls ──▶ SharedContext.update()           │
│  ...                                                        │
│  [overflow] ──▶ compaction ──▶ SharedContext.snapshot()      │
│                                 作為 summary message        │
│                                 清除舊 messages             │
│  turn N+1: 從 shared context 繼續                            │
│                                                             │
│  ┌────────────────────────────────────┐                     │
│  │  Shared Context Space              │                     │
│  │  (per-session structured document) │                     │
│  │                                    │                     │
│  │  ## Goal                           │                     │
│  │  ## Files                          │                     │
│  │  ## Discoveries                    │                     │
│  │  ## Actions Taken                  │                     │
│  │  ## Current State                  │                     │
│  └────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

**關鍵：一個結構，三個消費者**

| 消費者 | 怎麼用 |
|--------|--------|
| Main session (compaction) | overflow 時作為 summary message，取代 compaction agent |
| Main session (continuation) | compaction 後從 shared context 恢復脈絡 |
| Subagent | dispatch 時作為首條 message 的 prefix |

---

## Module Design

### 1. `session/shared-context.ts` (NEW)

Session-level 的結構化知識空間。

```typescript
export namespace SharedContext {
  interface Space {
    sessionID: string
    version: number            // 每次 update 遞增
    updatedAt: number
    goal: string
    files: FileEntry[]
    discoveries: string[]
    actions: ActionEntry[]
    currentState: string
  }

  interface FileEntry {
    path: string
    lines?: number
    summary?: string           // assistant 對此檔的分析摘要
    operation: "read" | "edit" | "write" | "grep_match"
    addedAt: number            // turn timestamp
  }

  interface ActionEntry {
    tool: string
    summary: string
    turn: number               // which assistant turn
    addedAt: number
  }

  // --- Lifecycle ---

  // 取得 session 的 shared context，不存在則回 undefined
  export async function get(sessionID: string): Promise<Space | undefined>

  // 從 assistant turn 的 tool parts 增量更新
  export async function updateFromTurn(input: {
    sessionID: string
    parts: MessageV2.Part[]
    assistantText: string       // assistant 本 turn 的文字（用來萃取 goal/discoveries）
    turnNumber: number
  }): Promise<void>

  // 產生可注入的文字快照
  export async function snapshot(sessionID: string): Promise<string | undefined>

  // 內部：budget 管理，壓縮舊條目
  async function consolidate(space: Space, budget: number): Promise<Space>
}
```

### 2. 儲存層

Shared context 使用現有的 `Storage` 機制，key 為 `["shared_context", sessionID]`。

```typescript
// 讀取
const space = await Storage.read<Space>(["shared_context", sessionID])

// 寫入（增量更新後）
await Storage.write(["shared_context", sessionID], space)
```

不引入新的持久化層，與 session messages 同生命週期（session 刪除時一併清除）。

### 3. 增量更新邏輯

`updateFromTurn()` 的核心邏輯：

```
Input: 本 turn 的 parts[] + assistantText
  │
  ├─ 1. 走訪 tool parts
  │    ├─ read  → files[] append { path, lines, operation: "read" }
  │    ├─ glob  → files[] append matched paths (operation: "grep_match")
  │    ├─ grep  → files[] append matched files (operation: "grep_match")
  │    ├─ edit  → files[] upsert { path, operation: "edit" }
  │    │         actions[] append "Edit: {path}"
  │    ├─ write → files[] upsert { path, operation: "write" }
  │    │         actions[] append "Write: {path}"
  │    ├─ bash  → actions[] append "Bash: {cmd} → exit {code}"
  │    ├─ task  → actions[] append "Task: {description} → {agent}"
  │    └─ other → actions[] append "{tool}: {summary}"
  │
  ├─ 2. 從 assistantText 萃取 goal（若 goal 尚未設定）
  │    簡單啟發式：取第一段含「目標」「需要」「要做」等語義的句子
  │    或取 assistantText 前 200 chars
  │
  ├─ 3. 從 assistantText 萃取 discoveries
  │    啟發式：含「發現」「原因是」「因為」「root cause」「注意」
  │    「important」「key finding」等 pattern 的句子
  │
  ├─ 4. 更新 currentState
  │    用 assistantText 的最後一段（通常是 "接下來要..." 或 next steps）
  │
  ├─ 5. files[] 去重（同 path 的 entry 合併，保留最新 operation）
  │
  └─ 6. consolidate(budget) 若超出
```

### 4. `snapshot()` 輸出格式

```xml
<shared_context session="{sessionID}" version="{N}" entries="{M}">
## Goal
Implement context sharing between orchestrator and subagents

## Files
- packages/opencode/src/session/compaction.ts (303 lines, read) — compaction budget, prune logic
- packages/opencode/src/tool/task.ts (1196 lines, read+edit) — worker pool, dispatch
- packages/opencode/src/session/prompt.ts (1100 lines, read) — prompt loop

## Discoveries
- Subagent sessions are fully isolated; only parentID links them
- AGENTS.md only injected for main agents, not subagents
- Position-based prune protects last 2 turns + 40k tokens

## Actions Taken
- Read 5 core session files for architecture analysis
- Identified 3 token waste hotspots

## Current State
Analysis complete. Ready to implement context-digest.ts as first module.
</shared_context>
```

### 5. Dispatch 注入（同步）與 Compaction 時序

**核心約束**：Compaction 重寫 message chain，必須在 turn 邊界同步執行。Prompt loop 正在使用的 chain 不能被背景修改。

#### task.ts：只做注入（同步），不觸發 compaction

```
task() 被呼叫
    │
    ├─ [同步] SharedContext.snapshot() → snapshot
    │
    ├─ snapshot 為空？
    │   └─ YES → 只傳 task prompt（現有行為）
    │
    ├─ [同步] 注入 snapshot 到 subagent msg[0]
    │
    └─ [同步] dispatchToWorker()
         subagent 開始工作...
         task tool 等待 worker 完成（activity-based timeout）
```

#### prompt.ts：turn 邊界統一處理所有 compaction

```
turn N 完成（assistant response + tool results 都已寫入）
    │
    ├─ SharedContext.updateFromTurn()    ← 增量更新
    │
    ├─ 本 turn 是否包含已完成的 task tool call?
    │   └─ YES → idle compaction 評估
    │        │
    │        ├─ inspectBudget() → utilization
    │        │
    │        ├─ utilization < threshold (0.6)?
    │        │   └─ 跳過
    │        │
    │        └─ utilization ≥ threshold
    │            └─ compactWithSharedContext()（同步）
    │                 snapshot 作為 summary
    │                 重寫 message chain
    │
    └─ turn N+1 開始（從新 chain 讀取）
```

**為什麼在 turn 邊界？**

- Compaction 本質上是重寫 prompt loop 正在讀取的 message chain
- Turn 邊界是唯一安全的 mutation point——上一輪已完成，下一輪尚未開始
- 與現有 overflow compaction 共用同一個 safe point，邏輯一致
- 避免 async compaction 與 task tool 的 heartbeat polling / activity tracking 產生 race condition

**為什麼 60% 門檻？**

- 給 main session 的後續 turns 留足空間（剩餘 40% ≈ 50k tokens on 128k model）
- Subagent 完成後 main session 可能需要多個 turns 消化結果
- 太高（如 80%）可能來不及——幾個 read + grep 就會推到 overflow
- 太低（如 20%）沒有意義——壓了也省不了多少

### 6. Compaction 觸發路徑

兩個觸發條件，同一個執行點（turn 邊界），共用 `compactWithSharedContext()`：

```
路徑 A: Idle compaction（turn 包含 task dispatch）
  turn 完成 → updateFromTurn() → 偵測到 task tool call
    → inspectBudget() → utilization ≥ 0.6
    → SharedContext.snapshot() 作為 summary
    → 同步重寫 message chain
    → 省掉 compaction agent LLM call

路徑 B: Overflow compaction（現有觸發）
  inspectBudget().overflow === true
    → SharedContext.snapshot() ─┬─ 有內容 → 作為 summary（省 LLM call）
                                └─ 無內容 → fallback 到現有 compaction agent
```

**關鍵差異**：路徑 A 在 60% 就壓，路徑 B 在 ~90% 才壓。觸發條件不同，但執行路徑完全一樣——都在 turn 邊界同步跑 `compactWithSharedContext()`。

### 7. `tool/task.ts` 修改

**只做注入**，不做 compaction：

```typescript
// 在 Session.create() 之後、dispatchToWorker() 之前
if (!params.session_id) {  // 非 continuation
  const contextSnapshot = await SharedContext.snapshot(ctx.sessionID)
  if (contextSnapshot) {
    // [同步] 注入 shared context 到 subagent
    const seedMsg = await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "user",
      sessionID: session.id,
      time: { created: Date.now() },
      // ... model/format from parent
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: seedMsg.id,
      sessionID: session.id,
      type: "text",
      synthetic: true,
      text: contextSnapshot + "\n\n---\n\n" + taskPromptText,
      time: { start: Date.now(), end: Date.now() },
    })
  }
}

// dispatchToWorker() — 注入完成後 dispatch，無 compaction 邏輯
```

### 8. `prompt.ts` 修改

Turn 邊界：增量更新 + idle compaction 評估（同步）：

```typescript
// assistant turn 完成後（result 處理之後、prune 之前）
if (config.compaction?.sharedContext !== false && !session.parentID) {
  const assistantParts = await MessageV2.parts(processor.message.id)
  const assistantText = assistantParts
    .filter(p => p.type === "text")
    .map(p => p.text)
    .join("\n")

  // 1. 增量更新 shared context
  await SharedContext.updateFromTurn({
    sessionID,
    parts: assistantParts,
    assistantText,
    turnNumber: step,
  })

  // 2. Idle compaction：本 turn 包含 task dispatch → 評估是否提前壓縮
  const hasTaskDispatch = assistantParts.some(
    p => p.type === "tool" && p.tool === "task" && p.state.status === "completed"
  )
  if (hasTaskDispatch) {
    await SessionCompaction.idleCompaction({
      sessionID,
      model: processor.model,
      config,
    })
  }
}
```

---

## Data Flow — 完整生命週期

```
Session 開始
    │
    ▼
Turn 1: user request → assistant reads 5 files, analyzes
    │
    ├──▶ [turn 邊界] SharedContext.updateFromTurn()
    │    → goal: "Implement feature X"
    │    → files: [a.ts, b.ts, c.ts, d.ts, e.ts]
    │    → discoveries: ["a.ts uses pattern Y", "b.ts depends on c.ts"]
    │    → currentState: "Analysis complete, ready to implement"
    │    → estimated size: ~600 tokens
    │    → context utilization: ~35%
    │    → 無 task dispatch → 跳過 idle compaction
    │
    ▼
Turn 2: assistant dispatches task(coding)
    │
    │  [task tool 執行中]
    │    ├─ SharedContext.snapshot() → ~600 tokens
    │    ├─ inject snapshot into subagent msg[0]
    │    ├─ dispatchToWorker()
    │    └─ 等待 worker 完成...
    │
    │    Subagent sees:
    │      <shared_context> (600 tokens) + task prompt
    │      → knows files, structure, decisions
    │      → only reads a.ts and b.ts (the ones it needs to edit)
    │      → saves ~24k tokens vs reading all 5
    │
    │  [task tool return]
    │
    ├──▶ [turn 邊界] SharedContext.updateFromTurn()
    │    → actions: ["Task: implement feature X → coding agent"]
    │
    ├──▶ [turn 邊界] idle compaction 評估（偵測到 task dispatch）
    │    → utilization 35% < 60% threshold
    │    → 跳過（不值得壓）
    │
    ▼
Turn 3-8: more exploration, edits, subagent calls...
    │
    ├──▶ SharedContext 持續增量更新
    │    → context utilization 逐漸上升: 40% → 55% → 65%
    │
    ▼
Turn 9: assistant dispatches task(review)
    │
    │  [task tool 執行中]
    │    ├─ SharedContext.snapshot() → ~1200 tokens → inject
    │    ├─ dispatchToWorker() → subagent 開始工作
    │    └─ 等待 worker 完成...
    │
    │  [task tool return]
    │
    ├──▶ [turn 邊界] SharedContext.updateFromTurn()
    │
    ├──▶ [turn 邊界] idle compaction 評估（偵測到 task dispatch）
    │    → utilization 65% ≥ 60% threshold
    │    → compactWithSharedContext()（同步）
    │    → snapshot 作為 summary，重寫 message chain
    │    → main session context 降回 ~15%
    │    ✓ 在 turn 邊界同步執行，無 race condition
    │    ✓ 省掉 compaction agent LLM call
    │
    ▼
Turn 10: main session 從 compacted chain 開始
    │
    ├──▶ SharedContext.updateFromTurn() → 從 version N 繼續增量
    │    → 剩餘空間充裕（~85% available）
    │
    ▼
... (continues)
```

---

## Edge Cases

1. **Subagent 的 shared context**：subagent 不維護自己的 shared context space（它們的 session 通常短命）。只有 main session（`!parentID`）才建立/更新。
2. **Nested subagent**：若 subagent dispatch sub-subagent，sub-subagent 收到的是 subagent session 的 messages（現有行為），不是 main session 的 shared context。
3. **Goal 更新**：若使用者在對話中改變目標，`updateFromTurn()` 中偵測到新的 goal 語義時覆蓋舊 goal。
4. **Files 去重**：同一個 path 多次出現時（先 read 後 edit），合併為一條，operation 更新為最新操作。
5. **Consolidate 壓力**：若 session 非常長（50+ turns），files 和 actions 可能很多。`consolidate()` 策略：合併同目錄的 files 為一條、移除最舊的 actions（保留最近 20 條）。

---

## Config Surface

```jsonc
// opencode.json
{
  "compaction": {
    "auto": true,               // existing
    "prune": true,              // existing
    "sharedContext": true,              // NEW: 啟用 shared context space (default true)
    "sharedContextBudget": 8192,       // NEW: shared context 自身的 token budget (default 8192)
    "opportunisticThreshold": 0.6      // NEW: dispatch 時觸發 compact 的使用率門檻 (default 0.6)
  }
}
```

---

## What This Replaces

| 現有機制 | 新機制中的對應 | 狀態 |
|----------|---------------|------|
| `compaction.ts process()` 呼叫 compaction agent 產生 free-form summary | `SharedContext.snapshot()` 直接作為 summary | 取代（但保留 fallback） |
| 無（subagent 只收到 task prompt string） | `SharedContext.snapshot()` 注入 subagent 首條 message | 新增 |
| 無（main session 的知識只存在 message history 中） | `SharedContext.updateFromTurn()` 增量維護結構化知識 | 新增 |

## What This Does NOT Replace

| 現有機制 | 狀態 | 原因 |
|----------|------|------|
| `compaction.ts prune()` — position-based tool output 清除 | 保留 | prune 處理的是 message history 中的原始 output，shared context 處理的是知識摘要層；兩者互補 |
| `message-v2.ts` compacted flag 處理 | 保留 | 這是 `toModelMessages()` 的底層機制，shared context 不改變它 |
| `preloaded-context.ts` — dir listing + README | 保留 | 這是 session 初始化的靜態 context，與 shared context 的動態知識不衝突 |
