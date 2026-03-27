# Tasks

## 1. Forward Path Contract

- [x] 1.1 `prompt.ts` — 加入 parent message loading（loop 外，session.parentID check）
- [x] 1.2 `prompt.ts` — child LLM call messages array prepend parent messages + separator
- [x] 1.3 `task.ts` — 移除 SharedContext snapshot injection 邏輯（promptParts.unshift 段落）
- [x] 1.4 `task.ts` — 移除 `injectedSharedContextVersion` metadata field

## 2. Return Path Contract

- [x] 2.1 `task-worker-continuation.ts` — parent continuation message 包含 child assistant 關鍵輸出
- [x] 2.2 `task-worker-continuation.ts` — 保留 `mergeFrom()` 但不再作為唯一回饋管道

## 3. Stabilization And Validation

- [x] 3.1 SharedContext injection 相關 code 標記為 compaction-only
- [x] 3.2 評估 child skip AGENTS.md 邏輯 — 保留現狀，等待驗證證據
- [ ] 3.3 驗證 child compaction 不進入 oscillation（對應 T9）
- [ ] 3.4 驗證 child 第一輪 LLM call 包含完整 parent history + separator（對應 T10）
- [ ] 3.5 驗證 by-token provider cache reuse（對應 T11）
- [ ] 3.6 驗證 by-request provider 成本不受 full prefix 影響（對應 T12）

## 4. Documentation Sync

- [x] 4.1 建立 / 對齊 event log (`docs/events/event_20260327_context_sharing_v2.md`)
- [ ] 4.2 同步 `specs/architecture.md` 為 V2 真相（對應 T14）
- [ ] 4.3 回填驗證證據與決策結論到 event / architecture
