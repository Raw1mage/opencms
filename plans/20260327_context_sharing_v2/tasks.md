# Context Sharing v2 — Tasks

## Phase 1: Forward Path (parent → child)

- [ ] T1: `prompt.ts` — 加入 parent message loading（loop 外，session.parentID check）
- [ ] T2: `prompt.ts` — child LLM call messages array prepend parent messages + separator
- [ ] T3: `task.ts` — 移除 SharedContext snapshot injection 邏輯（promptParts.unshift 段落）
- [ ] T4: `task.ts` — 移除 `injectedSharedContextVersion` metadata field

## Phase 2: Return Path (child → parent)

- [ ] T5: `task-worker-continuation.ts` — parent continuation message 包含 child assistant 關鍵輸出
- [ ] T6: `task-worker-continuation.ts` — 保留 `mergeFrom()` 但不再作為唯一回饋管道

## Phase 3: Cleanup & Stabilization

- [ ] T7: SharedContext injection 相關 code 標記為 compaction-only
- [ ] T8: 評估 child skip AGENTS.md 邏輯是否仍合適（觀察行為品質）
- [ ] T9: 驗證 child compaction 不進入 oscillation（parent prefix 過大場景）

## Phase 4: Validation

- [ ] T10: 驗證 child 第一輪 LLM call 包含完整 parent history
- [ ] T11: 驗證 by-token provider cache hit rate（stable prefix）
- [ ] T12: 驗證 by-request provider 無成本影響
- [ ] T13: Event log (`docs/events/event_20260327_context_sharing_v2.md`)
- [ ] T14: Architecture sync (`specs/architecture.md`)

## Dependencies

- T2 depends on T1
- T4 depends on T3
- T5 depends on T1+T2（forward path 先完成才能驗證 return path）
- T10-T12 depends on Phase 1+2 完成
- T13-T14 depends on all

## Decision Gates

- [ ] D1: Phase 1 完成後，觀察 child 行為品質，決定 T8（AGENTS.md skip 是否移除）
- [ ] D2: Phase 3 完成後，決定是否需要 child compaction 額外保護（T9）
