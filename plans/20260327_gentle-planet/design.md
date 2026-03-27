# Design

## Context

- SharedContext v1 已完成並 merge，但它的 dispatch-time snapshot injection 無法滿足「真正 context share」的原始需求。
- 現有 V2 實作方向已在 code 與 beta branch 出現，規劃缺口主要在 execution contract、validation contract、doc sync 與 diagram completeness。

## Goals / Non-Goals

**Goals:**

- 鎖定 parent→child full-message forwarding 的 forward path 契約。
- 鎖定 child→parent continuation evidence 的最低可接受契約。
- 讓 active plan package 可直接成為 build-mode handoff 依據。

**Non-Goals:**

- 不新增 multi-child 或 grandchild 擴展。
- 不把 SharedContext 完全移除。

## Decisions

- Parent prefix 採 prompt-loop start 一次性載入，而不是每輪重新讀 parent store，藉此兼顧一致性與成本穩定。
- Dispatch 移除 SharedContext snapshot injection，避免 parent context 同時以 message prefix 與 snapshot 雙重出現。
- Return path 以 child completion evidence 為最低契約；可接受 summary-style relay，但不可只剩 `mergeFrom()`。
- 暫時保留 child skip AGENTS.md 邏輯；是否升級為 child 也載入 AGENTS.md，需等實測證據再決策。

## Data / State / Control Flow

- Forward path：`prompt.ts` 於 child prompt-loop start 讀取 parent messages → 轉成 model messages → prepend 到 child 每輪模型呼叫。
- Dispatch path：`task.ts` 建立 child 任務 prompt，但不再插入 SharedContext snapshot。
- Return path：`task-worker-continuation.ts` 在 child completion 後取用 child transcript evidence，組成 parent synthetic continuation。
- Compaction path：`shared-context.ts` 仍維持 per-session space 更新；child compaction 只壓 child-owned history，不改動 read-only parent prefix。

## Risks / Trade-offs

- Parent prefix 過大可能讓 child 更頻繁接近 compaction ceiling -> 以 cooldown 與明確 T9 壓測驗證，目前不提前新增 fallback guard。
- Summary-style return evidence 比 full transcript replay 保守，但可控制 parent context 壓力 -> 先以最低可接受 evidence contract 收斂。
- 保留 skip AGENTS.md 可節省 system prompt token，但 child 的規範一致性需實測確認 -> 保留為 decision gate D2/D3 類後續觀察點。

## Critical Files

- `plans/20260327_context_sharing_v2/implementation-spec.md`
- `plans/20260327_context_sharing_v2/tasks.md`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/bus/subscribers/task-worker-continuation.ts`
- `packages/opencode/src/session/shared-context.ts`
- `docs/events/event_20260327_context_sharing_v2.md`
- `specs/architecture.md`
