# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State

- rotation.executed 事件已在後端定義並 publish（llm.ts）
- 前端 event-reducer.ts 已有 `case "rotation.executed"` handler
- 前端 session-status-sections.tsx 已有 rotation chain card 渲染
- 前端 types.ts 已擴展 LlmHistoryEntry 含 from/to 欄位
- **但**：事件無法到達前端，因為 global-sync.tsx directory routing 靜默 drop
- 暫時 hack：toast handler 裡解析 `->` 字串推 llm_history（不穩定）
- 事件系統普查完成：65 define (28 files) / 152 publish (37 files) / 432 debugCheckpoint (41 files) / 11 GlobalBus.emit (6 files) / 41 subscribe (16 files) / 12 ToastShow (6 files) — 總計 713 呼叫點 / 96 唯一檔案
- **設計方向確認**：採用 DDS 風格 Topic/Subscription 模型，subscriber-driven output

## Stop Gates In Force

- Phase 1 部署後必須驗證：session/message 不 regress + rotation 到達 card
- Phase 2 的 subscriber API 設計需要 review 後才進 Phase 3
- broadcast-first 效能如有 >5ms per event 影響，需回退

## Build Entry Recommendation

**從 Phase 1 Task 1.1 開始**：修改 `global-sync.tsx` 的 event listener，將 directory exact-match 改為 broadcast-to-all-children。這是最小改動、最大收益的切入點——修復後所有後端 Bus 事件都能到達前端 event-reducer。

具體改動點：`packages/app/src/context/global-sync.tsx` lines 416-438（directory routing block）。

改動邏輯：
```typescript
// 改前：
const child = children.children[directory]
if (!child) return

// 改後：
for (const [dir, child] of Object.entries(children.children)) {
  if (directory !== "global" && normalizeDirectoryKey(dir) !== directory) continue
  applyDirectoryEvent({ event, directory: dir, ...child })
}
```

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
- [x] Root cause identified (directory routing drop in global-sync.tsx)
- [x] Phase 1 is self-contained and immediately executable
- [x] Event system census complete (65 define / 152 publish / 432 debug / 11 global / 41 subscribe / 12 toast — 713 calls / 96 files)
- [x] Design direction confirmed: DDS-style Topic/Subscription, subscriber-driven output
