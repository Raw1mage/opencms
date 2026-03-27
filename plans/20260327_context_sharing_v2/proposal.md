# Context Sharing v2: True Parent-Child Message Forwarding

## Lineage

本計畫是 `specs/shared-context-structure/`（SharedContext v1）的演進。

- **V1**（已完成已 merge）：per-session structured digest，8K budget，dispatch 時注入 snapshot
- **V2**（本計畫）：直接 forward parent messages 給 child，取代 snapshot injection

V1 的 infrastructure（SharedContext Space、updateFromTurn、idle/overflow compaction）保留為 compaction 用途。

## Original Requirement Wording

V1 proposal 紀錄的原始需求：
> "能不能考慮直接 context share 搭配適當的動態 compaction 策略"

V1 選擇了「structured digest + 8K budget」路線。本次回歸使用者原始意圖：**真正的 context sharing**。

## Problem

V1 SharedContext 機制只複製 ~8K tokens 的結構化摘要給 subagent，導致：

1. **資訊不足**：Parent 累積 60%+ context（plan、discoveries、debug history）壓縮到 8K，嚴重失真
2. **重讀浪費**：Child 必須重新讀取 parent 已讀過的檔案（一個 plan ~5-8.5K tokens × 6 files ≈ 21K tokens）
3. **回饋太淺**：Child 做完 20 rounds，parent 只收到幾百 tokens 的 `mergeFrom()` structured diff
4. **經濟學錯誤**：
   - **By-token providers**（OpenAI）：automatic prompt caching 使 stable prefix ≈ 免費（82% cache hit rate）
   - **By-request providers**（GitHub Copilot）：context size 完全不影響成本
   - 兩種計費模型都不需要省 context

## Solution

**Fork model**：Child session 的每一輪 LLM call 包含 parent 的完整 message history 作為 stable prefix。

```
Child LLM call:
  system: [SYSTEM.md, environment]
  messages: [
    ...parent messages (read-only, stable prefix → automatic cache hit),
    ---separator---
    ...child own messages (task prompt + child's work)
  ]
```

回饋方向：parent continuation 後能讀取 child 的 message history。

## Quantified Impact

### 現狀（V1: 8K snapshot injection）
- Dispatch context: 8K tokens（嚴重失真）
- Child 重讀 plan files: ~21K tokens（重複成本）
- Child 20 rounds × 重讀 context: ~420K tokens
- 回饋：幾百 tokens structured diff

### 目標（V2: full parent context forwarding）
- Dispatch context: parent context size（cache hit → ≈ 0 incremental cost）
- Child 重讀: 0
- 回饋：完整 child transcript accessible

## Scope

### IN
- Forward path: child 每輪 LLM call prepend parent messages as stable prefix
- Return path: parent continuation 後能存取 child messages
- SharedContext V1 infrastructure 降級為 compaction/observability 用途

### OUT
- 多 child 並行（維持 single-child invariant）
- SharedContext Space 結構改動
- Compaction pipeline 核心邏輯改動
- 多層嵌套（grandchild context）

## Risk

1. **Context limit**：Parent 200K + child work → 接近 272K ceiling
   - 緩解：child compaction 正常運作
2. **Parent compaction 時序**：parent 在 child 執行期間 idle → 不會觸發 compaction → 低風險
3. **Message 格式相容性**：`MessageV2.toModelMessages()` 已能處理 → 低風險

## WIP Reference
- Beta branch: `beta/context-sharing-v2`（含初步 forward path 實作）
- V1 spec: `specs/shared-context-structure/`
