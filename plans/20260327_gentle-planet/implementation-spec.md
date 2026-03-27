# Implementation Spec

## Goal

- 將 context sharing v2 補成完整可執行計畫包：以 parent message forwarding 取代 SharedContext snapshot injection，並明確定義驗證、stop gates 與文件同步契約。

## Scope

### IN

- 補齊 context sharing v2 的 implementation-spec 與 handoff artifacts。
- 明確定義 forward path / return path / compaction interaction 的 execution contract。
- 把驗證項目（T9-T12）從待測描述改成可執行 validation contract。
- 同步 event 與 architecture 文件工作要求。

### OUT

- 不在本輪新增 multi-child parallelism。
- 不在本輪擴展到 grandchild context sharing。
- 不重做 SharedContext data model。
- 不修改 core compaction pipeline 的總體策略。

## Assumptions

- 核心程式碼實作已大致存在於 `beta/context-sharing-v2` / `cms`，本輪主要是補齊計畫契約與收尾 requirements。
- Child 仍維持 single-child invariant 下的 delegated execution。
- Parent message prefix 採 worker/prompt-loop start 時載入一次，而不是每輪重新讀 parent store。
- SharedContext v1 不刪除，保留作 compaction / observability 用途。

## Stop Gates

- 若實際程式碼與計畫對「parent prefix 載入時機」不一致，必須停下來統一 spec/design/tasks。
- 若實測顯示 child compaction 出現 oscillation 而現有 cooldown 無法穩定抑制，必須停下來決定是否新增額外保護。
- 若 parent continuation 實際無法取得足夠 child evidence，需停下來重新定義 return-path contract。

## Critical Files

- `plans/20260327_context_sharing_v2/proposal.md`
- `plans/20260327_context_sharing_v2/spec.md`
- `plans/20260327_context_sharing_v2/design.md`
- `plans/20260327_context_sharing_v2/tasks.md`
- `docs/events/event_20260327_context_sharing_v2.md`
- `specs/architecture.md`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/bus/subscribers/task-worker-continuation.ts`
- `packages/opencode/src/session/shared-context.ts`

## Structured Execution Phases

- Phase 1: Validate and lock the forward path contract for parent-message prefix loading.
- Phase 2: Validate and lock the return path contract for child-to-parent evidence relay.
- Phase 3: Validate compaction interaction, AGENTS skip posture, and runtime stability.
- Phase 4: Sync event and architecture docs so V2 replaces stale V1 authority text.

## Validation

- T9: Reproduce a large-parent-context child run and verify child compaction does not oscillate indefinitely; capture evidence from logs/checkpoints.
- T10: Verify the child's first LLM call includes full parent history plus separator.
- T11: Verify by-token provider cache behavior shows stable-prefix reuse after the first child round.
- T12: Verify by-request providers do not incur additional cost sensitivity from full parent prefix.
- T13: Record evidence and decisions in `docs/events/event_20260327_context_sharing_v2.md`.
- T14: Update `specs/architecture.md` so SharedContext / task-worker-continuation sections match V2 reality.

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md / handoff.md before coding or validation.
- Build agent must treat tasks.md as the canonical checklist and update it immediately when validation/doc sync lands.
- Build agent must stop on any mismatch between current code behavior and the V2 plan assertions.
