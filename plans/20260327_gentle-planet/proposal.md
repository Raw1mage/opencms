# Proposal

## Why

- SharedContext v1 只把約 8K 的結構化摘要注入 child session，對長任務與大 plan 會產生明顯資訊失真。
- child 需要重讀 parent 已讀過的文件與決策脈絡，造成 token 浪費與回饋深度不足。

## Original Requirement Wording (Baseline)

- "能不能考慮直接 context share 搭配適當的動態 compaction 策略"

## Requirement Revision History

- 2026-03-27: 從 SharedContext v1 的 structured digest 路線，收斂為 context sharing v2 的 true parent-child message forwarding。
- 2026-03-27: 補齊 implementation-spec / handoff / validation contract / diagram artifacts，讓計畫包可直接進入 build mode。

## Effective Requirement Description

1. Child session 的每輪模型呼叫必須帶入 parent session 的完整可見訊息歷史作為 stable prefix。
2. SharedContext v1 保留作 compaction / observability，不再作為 child dispatch 的主要上下文橋接機制。
3. Parent continuation 必須能取得足夠的 child evidence，而不是只依賴淺層 structured diff。

## Scope

### IN

- 定義 forward path：parent messages 作為 child prefix。
- 定義 return path：child completion evidence 回到 parent continuation。
- 定義 compaction interaction、AGENTS skip posture、validation contract、doc sync contract。

### OUT

- 多 child 並行。
- grandchild context sharing。
- SharedContext Space 資料模型重做。
- compaction framework 全面重構。

## Non-Goals

- 不在本輪新增 fallback context bridge。
- 不在本輪讓 parent 下一輪直接重放完整 child transcript 當 prefix。

## Constraints

- 必須遵守 single-child invariant。
- 不允許靠 silent fallback 掩蓋 context 不一致。
- architecture.md 與 event log 必須能反映 V2 成為新真相。

## What Changes

- 以 parent message forwarding 取代 dispatch-time SharedContext snapshot injection。
- 將 child→parent 回饋定義為 continuation evidence contract，而非僅 `mergeFrom()`。
- 把 T9-T12 從口語待測項目改成可執行驗證與 stop gate。

## Capabilities

### New Capabilities

- Full parent-prefix delegation: child 能直接消費 parent 已知上下文，避免重讀。
- Evidence-based continuation: parent continuation 取得可判斷後續動作的 child evidence。

### Modified Capabilities

- SharedContext: 從 primary context bridge 降級為 compaction / observability surface。
- Validation workflow: 從概念性待測項目升級為具體驗證契約。

## Impact

- 影響 `packages/opencode/src/session/prompt.ts`、`packages/opencode/src/tool/task.ts`、`packages/opencode/src/bus/subscribers/task-worker-continuation.ts`、`packages/opencode/src/session/shared-context.ts`。
- 影響 `docs/events/event_20260327_context_sharing_v2.md` 與 `specs/architecture.md` 的長期真相描述。
