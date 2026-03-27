# Context Sharing v2 — Tasks

## Phase 1: Forward Path (parent → child)

- [ ] T1: `prompt.ts` — 加入 `getParentMessages()` helper，讀取 parent session 的 messages
- [ ] T2: `prompt.ts` line 1055 — child session 的 `messages` array prepend parent messages + separator
- [ ] T3: `task.ts` — 移除 SharedContext snapshot injection 邏輯（`promptParts.unshift` 段落）
- [ ] T4: `prompt.ts` — 移除 child session 跳過 AGENTS.md 的邏輯（line 1052），因為 parent messages 已包含完整指令脈絡

## Phase 2: Return Path (child → parent)

- [ ] T5: `task-worker-continuation.ts` — parent continuation 時，將 child 的 key assistant messages 注入 continuation message
- [ ] T6: 評估是否需要讓 parent prompt loop 自動 prepend 最近完成的 child messages

## Phase 3: Cleanup

- [ ] T7: SharedContext injection 相關 code 標記為 compaction-only（不再用於 dispatch）
- [ ] T8: `shared-context.ts` — `formatForInjection()` / `snapshotDiff()` 保留但標記為 compaction 用途

## Phase 4: Validation

- [ ] T9: 驗證 child 第一輪 LLM call 包含完整 parent history
- [ ] T10: 驗證 cache hit rate（OpenAI sessions）
- [ ] T11: 驗證 child compaction 不影響 parent messages
- [ ] T12: Event log + architecture sync
