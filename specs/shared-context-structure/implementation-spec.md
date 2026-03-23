# Implementation Spec: Shared Context Structure

## Goal

- 建立 session-level 的 shared context space，統一 subagent 知識注入與 compaction 記憶壓縮為單一結構化機制

## Scope

### IN

- `shared-context.ts` 核心模組（Space model、updateFromTurn、snapshot、consolidate）
- Subagent dispatch 注入（同步）+ idle compaction（async）
- Overflow compaction 整合（優先使用 shared context）
- Config 擴展 + telemetry

### OUT

- Worker pool 架構變更
- Per-tool TTL 政策
- 跨 session persistent memory
- Position-based prune 機制變更

## Assumptions

- `part.state.input` 結構穩定，各 tool 的 input 欄位可靠（`file_path`、`pattern`、`command` 等）
- `Storage` 層可靠，單次寫入 ~幾 KB JSON 不構成 I/O 瓶頸
- 啟發式 goal/discoveries 萃取品質可接受（worst case 是空值，不產生錯誤資訊）
- `Session.updateMessage()` + `Session.updatePart()` 的 synthetic message 注入機制已穩定

## Stop Gates

- Phase 1 必須完成且 `SharedContext.updateFromTurn()` 可正確運作，才能進入 Phase 2/3
- `part.state.input` 欄位結構若與預期不符，需停下驗證並調整 processToolPart()
- 注入 synthetic message 時，若 `model` / `agent` / `format` 欄位導致 worker prompt loop 出錯，需停下修正
- 原有 `process()` 的 `compacting` plugin hook 必須保留——若移除會影響其他 plugin

## Critical Files

- `packages/opencode/src/session/shared-context.ts` — **NEW**：核心模組
- `packages/opencode/src/tool/task.ts` — MODIFY：dispatch 注入 + idle compaction
- `packages/opencode/src/session/compaction.ts` — MODIFY：overflow 路徑整合
- `packages/opencode/src/session/prompt.ts` — MODIFY：turn 完成後觸發更新
- `packages/opencode/src/config/config.ts` — MODIFY：新增 config 欄位
- `packages/opencode/src/session/message-v2.ts` — READ：Part 型別定義
- `packages/opencode/src/util/token.ts` — READ：Token.estimate()

## Structured Execution Phases

- **Phase 1: Shared Context Space — 核心結構與增量更新**：建立 `shared-context.ts`，實作 Space model、Storage CRUD、processToolPart、updateFromAssistantText、deduplicateFiles、consolidate、snapshot；修改 prompt.ts 在 turn 完成後觸發；新增 config 欄位
- **Phase 2: Subagent 注入 + Idle Compaction（turn 邊界同步）**：修改 task.ts 在 dispatch 前注入 snapshot；在 prompt.ts turn 邊界偵測 task dispatch 並評估 idle compaction；新增 compactWithSharedContext() + idleCompaction() 到 compaction.ts；telemetry
- **Phase 3: Overflow Compaction 整合**：修改 compaction.ts 的 process() 優先使用 shared context；shared context 為空時 fallback 到現有 compaction agent

## Validation

- V1: main session 多次 tool call 後，`SharedContext.get()` 回傳正確結構
- V2: dispatch subagent 時，subagent 首條 message 包含 shared context snapshot
- V3: dispatch 後 utilization < 60% → idle compaction 跳過
- V4: task dispatch turn 完成後 utilization ≥ 60% → idle compaction 在 turn 邊界同步執行
- V5: overflow compaction 觸發時使用 shared context 作為 summary
- V6: `config.compaction.sharedContext = false` 完全停用，回退現有行為
- V7: shared context 為空時（新 session 首次 turn）不影響任何現有流程
- V8: `session_id` continuation 不重複注入 shared context
- V9: shared context budget 生效：超出時 consolidate 正確壓縮
- V10: `opportunisticThreshold = 1.0` 停用 idle compaction
- V11: idle compaction 不影響 turn 邊界後的正常流程
- V12: telemetry 事件包含 shared context 指標

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.

---

# Detailed Phase Specifications

## Phase 1: Shared Context Space — 核心結構與增量更新

### 1.1 建立 `packages/opencode/src/session/shared-context.ts`

**依賴**：
- `Storage` — 持久化（`["shared_context", sessionID]`）
- `Session.messages()` / `MessageV2.parts()` — 讀取 turn 資料
- `Token.estimate()` — budget 管理

**資料模型**：

```typescript
export namespace SharedContext {
  export interface Space {
    sessionID: string
    version: number
    updatedAt: number
    budget: number             // config-driven, default 8192
    goal: string
    files: FileEntry[]
    discoveries: string[]
    actions: ActionEntry[]
    currentState: string
  }

  export interface FileEntry {
    path: string
    lines?: number
    summary?: string
    operation: "read" | "edit" | "write" | "grep_match" | "glob_match"
    updatedAt: number
  }

  export interface ActionEntry {
    tool: string
    summary: string
    turn: number
    addedAt: number
  }
}
```

**核心函式**：

#### `updateFromTurn()`

```typescript
export async function updateFromTurn(input: {
  sessionID: string
  parts: MessageV2.Part[]
  assistantText: string
  turnNumber: number
}): Promise<void> {
  const config = await Config.get()
  if (config.compaction?.sharedContext === false) return

  const budget = config.compaction?.sharedContextBudget ?? 8192
  let space = await get(input.sessionID) ?? createEmpty(input.sessionID, budget)

  // 1. Tool parts → files[] / actions[]
  for (const part of input.parts) {
    if (part.type !== "tool" || part.state.status !== "completed") continue
    processToolPart(space, part, input.turnNumber)
  }

  // 2. assistantText → goal / discoveries / currentState
  updateFromAssistantText(space, input.assistantText)

  // 3. Dedup files
  space.files = deduplicateFiles(space.files)

  // 4. Budget check & consolidate
  if (Token.estimate(serialize(space)) > budget) {
    space = consolidate(space, budget)
  }

  space.version++
  space.updatedAt = Date.now()
  await save(space)
}
```

#### `processToolPart()`

每種 tool 的處理邏輯：

| Tool | files[] | actions[] |
|------|---------|-----------|
| `read` | append `{ path, lines: countLines(output), operation: "read" }` | — |
| `glob` | append matched paths as `glob_match` | `"Glob: {pattern} → {N} files"` |
| `grep` | append matched files as `grep_match` | `"Grep: {pattern} → {N} matches"` |
| `edit` | upsert `{ path, operation: "edit" }` | `"Edit: {path}"` |
| `write` | upsert `{ path, operation: "write" }` | `"Write: {path}"` |
| `apply_patch` | upsert each affected file | `"Patch: {N} files"` |
| `bash` | — | `"Bash: {cmd_first_20_chars} → exit {code}"` |
| `webfetch` | — | `"WebFetch: {url}"` |
| `task` | — | `"Task({agent}): {description}"` |
| `skill` | — | `"Skill: {name}"` |
| others | — | `"{tool}: completed"` |

**Input 欄位存取**：tool part 的 `state.input` 包含 tool call 的 parameters（如 `file_path`, `pattern`, `command`）。`state.output` 是 tool 的回傳結果。

#### `updateFromAssistantText()`

簡單啟發式萃取，不呼叫 LLM：

```typescript
function updateFromAssistantText(space: Space, text: string): void {
  // Goal: 只在尚未設定時填入
  if (!space.goal && text.length > 0) {
    // 取前 200 chars，截到句尾
    space.goal = extractFirstSentence(text, 200)
  }

  // Discoveries: 含特定 pattern 的句子
  const discoveryPatterns = [
    /發現|原因是|因為|root cause|注意|important|key finding|需要注意/i,
    /the reason|it turns out|notably|crucially|discovered that/i,
  ]
  for (const sentence of splitSentences(text)) {
    if (discoveryPatterns.some(p => p.test(sentence))) {
      if (!space.discoveries.includes(sentence.trim())) {
        space.discoveries.push(sentence.trim())
      }
    }
  }

  // Current State: 取最後一段（通常是 next steps）
  const paragraphs = text.split(/\n\n+/).filter(Boolean)
  if (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1].trim()
    if (last.length > 10 && last.length < 500) {
      space.currentState = last
    }
  }
}
```

#### `deduplicateFiles()`

```typescript
function deduplicateFiles(files: FileEntry[]): FileEntry[] {
  const map = new Map<string, FileEntry>()
  for (const f of files) {
    const existing = map.get(f.path)
    if (!existing || f.updatedAt > existing.updatedAt) {
      map.set(f.path, {
        ...f,
        // 若 operation 升級（read → edit），保留更高階的
        operation: existing ? higherOp(existing.operation, f.operation) : f.operation,
        // 保留摘要
        summary: f.summary || existing?.summary,
      })
    }
  }
  return Array.from(map.values())
}
```

#### `consolidate()`

當 shared context 超出 budget 時的壓縮策略：

1. Actions：只保留最近 20 條，舊的移除
2. Files：同目錄超過 5 個檔案的合併為 `"{dir}/ ({N} files, read+edit)"`
3. Discoveries：只保留最近 10 條
4. 若仍超出，按時間移除最舊的條目

#### `snapshot()`

```typescript
export async function snapshot(sessionID: string): Promise<string | undefined> {
  const space = await get(sessionID)
  if (!space || (space.files.length === 0 && space.actions.length === 0)) {
    return undefined
  }
  return formatSnapshot(space)
}

function formatSnapshot(space: Space): string {
  const lines: string[] = []
  lines.push(`<shared_context session="${space.sessionID}" version="${space.version}">`)

  if (space.goal) {
    lines.push(`## Goal`, space.goal, "")
  }

  if (space.files.length > 0) {
    lines.push(`## Files`)
    for (const f of space.files) {
      const meta = [f.lines ? `${f.lines} lines` : null, f.operation].filter(Boolean).join(", ")
      const suffix = f.summary ? ` — ${f.summary}` : ""
      lines.push(`- ${f.path} (${meta})${suffix}`)
    }
    lines.push("")
  }

  if (space.discoveries.length > 0) {
    lines.push(`## Discoveries`)
    for (const d of space.discoveries) {
      lines.push(`- ${d}`)
    }
    lines.push("")
  }

  if (space.actions.length > 0) {
    lines.push(`## Actions Taken`)
    for (const a of space.actions) {
      lines.push(`- ${a.summary}`)
    }
    lines.push("")
  }

  if (space.currentState) {
    lines.push(`## Current State`, space.currentState, "")
  }

  lines.push(`</shared_context>`)
  return lines.join("\n")
}
```

---

## Phase 2: Subagent 注入 + Idle Compaction（turn 邊界同步）

### 2.1 修改 `packages/opencode/src/tool/task.ts` — 只做注入

**位置**：`Session.create()` 之後、`dispatchToWorker()` 之前（~L1046）

task.ts **不做任何 compaction**。只負責同步注入 shared context 到 subagent 首條 message。

```typescript
// [同步] 注入 shared context 到 subagent
if (!params.session_id) {  // 非 continuation
  const contextSnapshot = await SharedContext.snapshot(ctx.sessionID)
  if (contextSnapshot) {
    const taskPromptText = typeof params.prompt === "string"
      ? params.prompt
      : params.prompt.content

    const seedMsg = await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "user",
      sessionID: session.id,
      agent: agent.name,
      model: { providerId: model.providerId, modelID: model.modelID, accountId: model.accountId },
      time: { created: Date.now() },
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

// dispatchToWorker() — 注入完成後直接 dispatch，無 compaction 邏輯
```

### 2.2 修改 `packages/opencode/src/session/prompt.ts` — turn 邊界 idle compaction

**位置**：assistant turn 完成後（updateFromTurn 之後、下一 turn 開始前）

Idle compaction 的觸發與評估都在 prompt.ts 的 turn 邊界，與 overflow compaction 共用同一個 safe point。

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

  // 2. Idle compaction：本 turn 包含已完成的 task dispatch → 評估是否提前壓縮
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

### 2.3 `idleCompaction()` — 新增到 `compaction.ts`

Turn 邊界同步執行，評估 utilization 決定是否壓縮：

```typescript
export async function idleCompaction(input: {
  sessionID: string
  model: Provider.Model
  config: Awaited<ReturnType<typeof Config.get>>
}): Promise<void> {
  const threshold = input.config.compaction?.opportunisticThreshold ?? 0.6
  if (threshold >= 1.0) return  // 停用

  const messages = await Session.messages({ sessionID: input.sessionID })
  const lastAssistant = messages.findLast(m => m.info.role === "assistant")
  if (!lastAssistant || lastAssistant.info.role !== "assistant" || !lastAssistant.info.tokens) return

  const budget = await inspectBudget({
    tokens: lastAssistant.info.tokens,
    model: input.model,
  })
  const utilization = budget.usable > 0 ? budget.count / budget.usable : 0

  if (utilization < threshold || !budget.auto) {
    debugCheckpoint("compaction", "idle compaction skipped", {
      utilization: Math.round(utilization * 100), threshold,
    })
    return
  }

  const snapshot = await SharedContext.snapshot(input.sessionID)
  if (!snapshot) return  // 無 shared context → 跳過

  await compactWithSharedContext({
    sessionID: input.sessionID,
    snapshot,
    parentID: lastAssistant.id,
    auto: true,
  })
  debugCheckpoint("compaction", "idle compaction completed", {
    utilization: Math.round(utilization * 100), threshold,
    freedTokens: budget.count - Token.estimate(snapshot),
  })
}
```

### 2.4 `compactWithSharedContext()` — 新增到 `compaction.ts`

Shared context compaction 的共用入口（idle + overflow 共用）：

```typescript
export async function compactWithSharedContext(input: {
  sessionID: string
  snapshot: string
  parentID: string
  auto: boolean
}): Promise<void> {
  const msg = await Session.updateMessage({
    id: Identifier.ascending("message"),
    parentID: input.parentID,
    role: "assistant",
    sessionID: input.sessionID,
    mode: "compaction",
    agent: "compaction",
    summary: true,
    // ... cost, tokens, model, time 等欄位
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.snapshot,
    time: { start: Date.now(), end: Date.now() },
  })

  if (input.auto) {
    const continueMsg = await Session.updateMessage({ /* ... */ })
    await Session.updatePart({
      text: "Continue if you have next steps, or stop and ask for clarification.",
      synthetic: true,
      // ...
    })
  }

  log.info("compaction via shared context", {
    tokens: Token.estimate(input.snapshot),
  })
  Bus.publish(Event.Compacted, { sessionID: input.sessionID })
}
```

### 2.5 Telemetry

在 `TaskWorkerEvent.Assigned` 事件中增加：

```typescript
sharedContextInjected: boolean
sharedContextTokens: number
sharedContextVersion: number
```

Idle compaction 結果透過現有 `Event.Compacted` + debugCheckpoint 觀測。

---

## Phase 3: Overflow Compaction 整合

### 3.1 修改 `packages/opencode/src/session/compaction.ts` 的 `process()`

Overflow compaction（現有觸發路徑）也優先使用 shared context：

```typescript
export async function process(input: { ... }) {
  const config = await Config.get()

  // NEW: 優先使用 shared context 作為 summary
  if (config.compaction?.sharedContext !== false) {
    const contextSnapshot = await SharedContext.snapshot(input.sessionID)
    if (contextSnapshot) {
      await compactWithSharedContext({
        sessionID: input.sessionID,
        snapshot: contextSnapshot,
        parentID: input.parentID,
        auto: input.auto,
      })
      return "continue"
    }
  }

  // FALLBACK: 現有 compaction agent 邏輯（原封不動保留）
  const userMessage = input.messages.findLast(...)
  const agent = await Agent.get("compaction")
  // ... 現有的 LLM call 邏輯
}
```

### 3.2 修改 `prompt.ts` — turn 完成後觸發增量更新

```typescript
// assistant turn 完成後（result 處理之後、prune 之前）
if (config.compaction?.sharedContext !== false && !session.parentID) {
  // 只有 main session 維護 shared context
  const parts = await MessageV2.parts(processor.message.id)
  const textParts = parts.filter(p => p.type === "text").map(p => p.text).join("\n")
  await SharedContext.updateFromTurn({
    sessionID,
    parts,
    assistantText: textParts,
    turnNumber: step,
  })
}
```

### 3.3 Config

在 compaction config schema 新增：

```typescript
sharedContext: z.boolean().default(true),
sharedContextBudget: z.number().default(8192),
opportunisticThreshold: z.number().min(0).max(1).default(0.6),
```

---

## 影響範圍

| 檔案 | 變更類型 | 說明 |
|------|----------|------|
| `src/session/shared-context.ts` | **NEW** | 核心模組：Space model, updateFromTurn, snapshot, consolidate |
| `src/tool/task.ts` | MODIFY | dispatch 前注入 shared context snapshot |
| `src/session/compaction.ts` | MODIFY | process() 中優先使用 shared context 作為 summary |
| `src/session/prompt.ts` | MODIFY | turn 完成後觸發 updateFromTurn |
| `src/config/config.ts` | MODIFY | 新增 sharedContext, sharedContextBudget config 欄位 |

## 風險與緩解

| 風險 | 緩解 |
|------|------|
| 啟發式萃取 goal/discoveries 品質不足 | 初期可接受——worst case 是 goal 為空或 discoveries 漏掉，不會產生錯誤資訊。品質可迭代改進 |
| shared context 自身膨脹 | consolidate() 以 budget 硬限保護；最壞情況是觸發 consolidate 後損失一些舊知識 |
| compaction fallback 路徑測試不足 | shared context 停用時（config/首次 turn/space 為空），必須完整走原有 compaction agent 路徑；需要明確的 integration test |
| Storage 寫入頻率（每個 turn） | 單次寫入是一個 JSON serialize + 磁碟寫入，~1ms 等級，不構成瓶頸 |
