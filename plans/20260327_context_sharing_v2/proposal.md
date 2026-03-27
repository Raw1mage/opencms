# Context Sharing v2: True Parent-Child Message Forwarding

## Problem

現有 SharedContext 機制只複製 ~8K tokens 的結構化摘要給 subagent，導致：

1. **資訊不足**：Parent 累積的 60%+ context（plan、discoveries、debug history）壓縮到 8K，嚴重失真
2. **重讀浪費**：Child 為了工作必須重新讀取 parent 已讀過的檔案（~21K tokens/plan），等於 parent 付過的成本再付一次
3. **回饋太淺**：Child 做完 20 rounds 的工作，parent 只收到幾百 tokens 的 structured diff
4. **經濟學錯誤**：
   - By-token providers（OpenAI）有 automatic prompt caching，stable prefix = cache hit ≈ 免費
   - By-request providers（Copilot）context size 完全不影響成本
   - 兩種模型都不需要省 context

## Solution

**Fork model**：Child session 的 LLM calls 包含 parent 的完整 message history 作為 stable prefix。

```
Child LLM call:
  system: [SYSTEM.md, environment]
  messages: [
    ...parent messages (read-only, stable prefix → cache hit),
    ---separator---
    ...child own messages
  ]
```

## Scope

### IN
- Forward path: child 每輪 LLM call prepend parent messages
- Return path: parent continuation 後能讀取 child 的 messages
- 保留 SharedContext 用於 compaction（不刪除）

### OUT
- 多 child 並行（維持 single-child invariant）
- SharedContext 結構改動（保持現有 Space model）
- Compaction pipeline 改動
