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
- 計畫已完成，尚未開始實作
- 所有關鍵檔案已分析完畢，行為理解已記錄在 design.md 中

## Stop Gates In Force
- 如果 scrollbox prepend 後無法穩定維持視口位置，需暫停 Phase 2 並評估 scrollbox patch 方案
- 如果分頁 API 讓短 session（<20 條消息）體驗變差，需加入 threshold 判斷
- 任何改動不得破壞現有 compact / prune 流程

## Build Entry Recommendation
- 從 Phase 1（Backend Pagination API）開始，因為前端改動依賴後端 API
- Phase 2 開始前，先做 task 2.1（scrollbox PoC）驗證 prepend 穩定性
- Phase 3 依賴 Phase 1 + 2 完成

## Execution-Ready Checklist
- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
