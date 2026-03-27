# Context Sharing v2 — Technical Spec

## Architecture Change

### 現狀
```
Parent session                          Child session
  messages: [m1, m2, ..., mN]            messages: [shared_ctx_8K, task_prompt, c1, c2, ...]
  SharedContext: Space(8K)    ──copy──►   SharedContext: Space(independent)
                              ◄──merge──  (structured diff only)
```

### 目標
```
Parent session                          Child session
  messages: [m1, m2, ..., mN]            LLM call messages: [
  (unchanged)                               ...parent_msgs (read-only prefix),
                                            ---separator---,
                                            task_prompt, c1, c2, ...
                                          ]
                              ◄──read──   child messages (parent can access)
```

## Forward Path: Parent → Child

### 改動位置：`prompt.ts` line 1055

```typescript
// Before (現狀)
messages: [
  ...MessageV2.toModelMessages(sessionMessages, activeModel),
]

// After
messages: [
  ...(session.parentID
    ? await getParentMessages(session.parentID, activeModel)
    : []),
  ...MessageV2.toModelMessages(sessionMessages, activeModel),
]
```

### `getParentMessages()` 實作

```typescript
async function getParentMessages(
  parentSessionID: string,
  model: Provider.Model
): Promise<ModelMessage[]> {
  const parentMsgs = await MessageV2.filterCompacted(
    MessageV2.stream(parentSessionID)
  )
  // Parent messages are complete — convert and return as prefix
  return MessageV2.toModelMessages(parentMsgs, model)
}
```

### Cache 友善性

- Parent messages 在 child 每輪 LLM call 中都是相同的 prefix
- OpenAI/Anthropic automatic prompt caching 會自動命中
- 第一輪 cold start 後，後續每輪的 parent prefix = cached

### 注意事項

1. **不需要 SharedContext injection**：dispatch 時不再需要 inject 8K snapshot，因為 child 已有完整 parent history
2. **不修改 child 的 message storage**：child 仍然在自己的 `["message", childSessionID]` namespace 存自己的 messages
3. **Parent messages 是 read-only**：child 不會寫入 parent 的 message store

## Return Path: Child → Parent

### 現狀問題
Parent continuation 只收到 SharedContext differential snapshot（幾百 tokens），child 做的工作幾乎全部丟失。

### 改動位置：`task-worker-continuation.ts`

Parent continuation message 中，除了現有的 SharedContext diff，額外 prepend child 的 assistant messages 摘要：

```typescript
// 在 continuation message 中加入 child 的關鍵 assistant outputs
const childMsgs = await MessageV2.filterCompacted(
  MessageV2.stream(childSessionID)
)
const childAssistantParts = extractChildSummary(childMsgs)
```

或者更簡單：**parent 的 prompt loop 自己去讀 child 的 messages**，類似 forward path 的反向。但這需要 parent 知道哪個 child 剛完成。

### 推薦做法：Continuation 帶 child transcript reference

```typescript
// task-worker-continuation.ts
const continuationText = [
  childContextSnap ? `${childContextSnap}\n\n---\n\n` : "",
  `Subagent ${childSessionID} completed.`,
  `Child session transcript is available in your context as prefix messages.`,
  `Continue immediately...`,
].join("")
```

但 parent 續跑時，child 的 messages 要能被 parent 的下一輪 LLM call 看到。做法：
- 在 parent 的 message store 中插入一條 synthetic message，引用 child session 的 key outputs
- 或者讓 parent prompt loop 能查詢「最近完成的 child sessions」並將其 messages 注入

## Separator / Role Clarity

在 parent messages 和 child messages 之間需要明確分界：

```typescript
// Separator message between parent and child contexts
{
  role: "user",
  content: [{
    type: "text",
    text: `--- You are now operating as a subagent. Above is the parent session context. Your task follows below. ---`
  }]
}
```

## SharedContext 保留

SharedContext 不刪除，但角色從「唯一 context bridge」退化為：
1. **Compaction 用途**：idle/overflow compaction 仍使用 SharedContext snapshot
2. **Telemetry/Observability**：追蹤 file/action/discovery 的結構化紀錄
3. **不再作為 dispatch injection**：8K snapshot injection 邏輯移除

## Compaction 互動

- Child session 帶了 parent 的 messages prefix → child 的 effective context 更大
- 如果 child context overflow → child 的 compaction 會壓縮，但壓的是 child 自己的 messages + parent prefix
- Parent prefix 是 read-only 的，child compaction 不應修改 parent 的 messages
- **解法**：child compaction 只壓 child 自己的 messages 部分，parent prefix 視為 immutable

## 風險

1. **Context limit**：若 parent 已用 200K context，child 可用空間剩下很少（272K - 200K = 72K）
   - 緩解：child compaction 正常運作，parent prefix 被 cache 不佔額外成本
2. **Parent compaction 影響 child**：若 parent 在 child 執行期間被 compact，child 下一輪拿到的 parent prefix 會變短
   - 緩解：parent 在 child 執行期間是 idle，不會觸發 compaction
3. **多層嵌套**：grandchild 要帶 parent + grandparent 的 messages？
   - 暫不支援，維持 single-child + single-level
