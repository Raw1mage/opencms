# Context Sharing v2 — Technical Spec

## Architecture Change

### V1 現狀
```
Parent session                          Child session
  messages: [m1, m2, ..., mN]            messages: [shared_ctx_8K, task_prompt, c1, c2, ...]
  SharedContext: Space(8K)    ──copy──►   SharedContext: Space(independent)
                              ◄──merge──  mergeFrom() (structured diff only)
```

### V2 目標
```
Parent session                          Child session
  messages: [m1, m2, ..., mN]            LLM call messages: [
  (unchanged)                               ...parent_msgs (read-only prefix, cached),
                                            ---separator---,
                                            task_prompt, c1, c2, ...
                                          ]
                              ◄──read──   child messages (parent can access on continuation)
```

---

## R1: Forward Path — Parent Messages as Child Prefix

### 改動位置：`prompt.ts`

Child session 的 prompt loop 載入 parent session messages 一次（loop 外），每輪 LLM call prepend。

```typescript
// Before child prompt loop starts (session.parentID check)
let parentMessagePrefix: MessageV2.WithParts[] | undefined
if (session.parentID) {
  parentMessagePrefix = await MessageV2.filterCompacted(
    MessageV2.stream(session.parentID)
  )
}
```

```typescript
// In processor.process() messages array
messages: [
  ...(parentMessagePrefix
    ? [
        ...MessageV2.toModelMessages(parentMessagePrefix, activeModel),
        { role: "user", content: [{ type: "text", text: SEPARATOR }] },
      ]
    : []),
  ...MessageV2.toModelMessages(sessionMessages, activeModel),
]
```

### Scenario: Normal subagent dispatch

- **GIVEN** parent 累積 30 rounds，context ~160K tokens
- **WHEN** child 第一輪 LLM call
- **THEN** messages 包含 parent 160K prefix + separator + child task prompt
- **AND** provider cache misses on first call（cold start）
- **AND** 後續每輪 parent prefix cache hit（stable prefix）

### Scenario: Parent has been compacted

- **GIVEN** parent 已經過 compaction，message history 以 summary 開頭
- **WHEN** child 載入 parent messages
- **THEN** 取得 compacted messages（filterCompacted 已處理）
- **AND** child 看到的是 compacted 後的 parent context

### Scenario: session_id continuation

- **GIVEN** task tool 使用 `session_id` 繼續已有 child session
- **WHEN** child prompt loop 繼續
- **THEN** parent prefix 仍然載入（每次 loop start 都讀）

---

## R2: Remove SharedContext Snapshot Injection

### 改動位置：`task.ts`

移除 dispatch 時的 `SharedContext.get()` → `formatForInjection()` → `promptParts.unshift()` 邏輯。

### Rationale

Child 已有完整 parent messages，8K snapshot 成為冗餘。保留 snapshot 會導致 parent context 出現兩次（messages + snapshot）。

### 保留項目

- `SharedContext.updateFromTurn()` — 仍在 prompt.ts turn boundary 執行
- `SharedContext.snapshot()` — 仍用於 idle/overflow compaction
- `injectedSharedContextVersion` metadata — 移除（不再需要 differential relay）

---

## R3: Return Path — Parent Access to Child Messages

### 改動位置：`task-worker-continuation.ts`

Parent continuation 時，將 child 的 assistant messages 關鍵內容注入 continuation message。

### Option A: Summary injection（推薦）

```typescript
// Extract child's key assistant outputs for parent continuation
const childMsgs = await MessageV2.filterCompacted(MessageV2.stream(childSessionID))
const childSummary = summarizeChildTranscript(childMsgs)
// Include in continuation message
continuationText = [childSummary, "Subagent completed. Continue..."].join("\n\n")
```

### Option B: Full child messages as parent prefix（未來方向）

讓 parent 的下一輪 LLM call 也能 prepend child 的 messages。但這增加 parent context 壓力，暫不實作。

### SharedContext mergeFrom() — 保留

`mergeFrom()` 仍執行，用於更新 parent Space（compaction 用途）。但不再作為唯一回饋管道。

---

## R4: AGENTS.md Skip Logic — 評估

### 現狀

```typescript
// prompt.ts line 1052
...(session.parentID ? [] : instructionPrompts),
```

Child session 跳過 AGENTS.md（instructionPrompts），理由是 subagent 只需 task description + SYSTEM.md。

### V2 考量

Parent messages prefix 已包含 parent 的完整對話脈絡（含 AGENTS.md 影響下的行為），但 **child 的 system prompt 本身沒有 AGENTS.md**。

- **保留 skip**：child 的 AGENTS.md 行為由 parent context 隱含傳遞（parent 按 AGENTS.md 行動，child 看到這些行動的結果）
- **移除 skip**：child 也載入 AGENTS.md，行為更一致（但增加 system prompt token）

暫時保留 skip，觀察 child 行為品質後再決定。

---

## R5: Child Compaction 互動

### 問題

Child 帶了 parent prefix → effective context 更大 → 更容易觸發 compaction。

### 解法

Child compaction 壓的是 child 自己的 messages（sessionMessages），不包含 parent prefix。

`inspectBudget()` 計算時，`tokens.total` 反映 LLM 回傳的完整 token count（含 parent prefix）。Compaction 觸發後，壓縮的是 child session 的 message history，parent prefix 不受影響（read-only）。

**需注意**：compaction 後 child context 大幅縮小，但下一輪 parent prefix 又會被加回。如果 parent 已佔 80% context，child 反覆 compaction 但永遠無法低於 parent prefix size → 可能進入 compaction oscillation。

**緩解**：
- Emergency ceiling 會在極端情況下強制 compact
- Child 的 cooldown 機制防止過頻 compaction
- 若 parent prefix 過大，child 仍能工作（只是每輪可用空間較小）

---

## Files Changed

| File | Change |
|---|---|
| `session/prompt.ts` | 載入 parent messages、prepend to LLM call |
| `tool/task.ts` | 移除 SharedContext injection |
| `bus/subscribers/task-worker-continuation.ts` | 增強 child→parent relay |
| `session/shared-context.ts` | 無結構改動，保留 compaction 用途 |

---

## Migration

- SharedContext V1 infrastructure 不刪除，降級為 compaction-only
- `formatForInjection()` 不再被 dispatch 使用，保留為 compaction snapshot 格式
- Config fields (`sharedContext`, `sharedContextBudget`, `opportunisticThreshold`) 保持不變
