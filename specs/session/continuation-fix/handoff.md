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

- RCA 已完成：完整追蹤了 daemon restart + session continuation 的 5 個缺口
- Plan artifacts 已產出：proposal, implementation-spec, spec, design, tasks
- 已有部分相關改動在 working tree 中（apply_patch schema 改為 `input`，repairToolCall 參數修復）— 這些是 Phase 4 的前置工作
- 尚未開始任何 Phase 的正式實作

## Stop Gates In Force

- 如果 Session.Info schema 變更會導致舊 session Zod parse 失敗 → 必須先加 storage migration
- 如果 orphan recovery 會誤判活著的 task → 必須先有 liveness check
- tool input normalization 不能寫回 storage（必須是 read-only transform）

## Build Entry Recommendation

- 從 Phase 1 (Orphan Recovery) 開始：這是最高 impact 且最獨立的 phase
- Phase 3 (Worker Observability) 可與 Phase 1 並行，因為完全不同的文件
- Phase 2 (Version Guard) 在 Phase 1 之後，因為 orphan scan 需要知道 version drift 的 context
- Phase 4 (Tool Input Normalization) 最後做，因為需要先理解 message context assembly 的完整流程
- Phase 5 (Execution Identity) 風險最低，任何時候都可以做

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
- [ ] Build agent has read all artifacts
- [ ] Working tree is clean or changes are committed
