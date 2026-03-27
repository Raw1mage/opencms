# Context Sharing v2 — Design

## Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                    FORWARD PATH                          │
│                                                          │
│  Parent Session                    Child Session          │
│  ┌─────────────┐                  ┌─────────────┐        │
│  │ m1 (user)   │──────────────────│ m1 (user)   │ parent │
│  │ m2 (asst)   │   read-only     │ m2 (asst)   │ prefix │
│  │ m3 (user)   │   stable prefix │ m3 (user)   │ (cache │
│  │ m4 (asst)   │   (auto cached) │ m4 (asst)   │  hit)  │
│  │ ...         │                  │ ...         │        │
│  │ mN (asst)   │                  │ mN (asst)   │        │
│  └─────────────┘                  ├─────────────┤        │
│                                   │ SEPARATOR   │        │
│                                   ├─────────────┤        │
│                                   │ task prompt │ child  │
│                                   │ c1 (asst)   │ own    │
│                                   │ c2 (user)   │ msgs   │
│                                   │ ...         │        │
│                                   └─────────────┘        │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    RETURN PATH                           │
│                                                          │
│  Parent Session                    Child Session          │
│  ┌─────────────┐                  ┌─────────────┐        │
│  │ continuation │◄─── summary ────│ child asst   │        │
│  │ message      │    of child's   │ messages     │        │
│  │              │    key outputs  │              │        │
│  └─────────────┘                  └─────────────┘        │
│                                                          │
│  SharedContext   ◄─── mergeFrom() (preserved for         │
│  Space (parent)       compaction/observability)           │
└─────────────────────────────────────────────────────────┘
```

## Cache Economics

```
Round 1 (cold start):
  parent prefix: 160K tokens (full cost, cache write)
  child prompt:   5K tokens
  total input:  165K tokens

Round 2+ (cache hit):
  parent prefix: 160K tokens (cached → ~10% cost or free)
  child context:  15K tokens (growing)
  total input:  175K tokens (effective cost: ~31K)

By-request providers:
  parent prefix: 160K tokens (zero cost regardless)
  No economic penalty for full context
```

## V1 vs V2 Comparison

| Aspect | V1 (SharedContext) | V2 (Message Forwarding) |
|---|---|---|
| Context given to child | 8K structured digest | Full parent messages |
| Information loss | High (compression) | Zero |
| Child re-read cost | ~21K tokens/plan | 0 |
| Dispatch cost | 8K tokens | Parent context (cached) |
| Return quality | Structured diff (~hundreds tokens) | Full child transcript |
| SharedContext role | Primary bridge | Compaction/observability only |
| Code complexity | SharedContext + injection + relay | Message prepend (simpler) |

## Key Implementation Details

### Parent Message Loading (One-Time)

- Loaded **once** before the prompt loop, not every round
- Uses `MessageV2.filterCompacted()` — respects parent's compaction state
- If parent was compacted, child sees compacted history (shorter, more focused)

### Separator Message

```typescript
{
  role: "user",
  content: [{
    type: "text",
    text: "--- You are now operating as a delegated subagent. Above is the parent session's full context. Your assigned task follows below. ---"
  }]
}
```

Purpose: clear boundary so LLM knows parent context ends and task begins.

### Child Compaction Safety

- `inspectBudget()` sees total tokens (parent + child)
- Compaction compresses child's own messages only
- Parent prefix is immutable — not affected by child compaction
- Potential oscillation: parent 80% + child keeps compacting → acceptable (cooldown prevents thrashing)
