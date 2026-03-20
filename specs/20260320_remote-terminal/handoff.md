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

- Phase 0（Discovery & Design）部分完成
- 核心概念已確立：大腦在本地、手腳在遠端、SSH tunnel 作為傳輸層
- Spec artifacts 已建立，waiting for：
  - Remote agent binary 技術選型決策（task 0.5）
  - 現有 tool dispatch 架構盤點（task 0.4）
  - Remote agent protocol 細節定義（task 0.6）

## Stop Gates In Force

- **技術選型 gate**: remote agent binary 的語言選擇需使用者明確決策後才可進入 Phase 1
- **抽象化 gate**: 若現有 tool dispatch 耦合度過高，需先完成重構才可進入 Phase 3
- **延遲 gate**: 若 SSH tunnel round-trip > 500ms，需重新評估架構（加入批次操作或 prefetch）

## Build Entry Recommendation

1. 先執行 task 0.4（盤點現有 tool dispatch 架構）
2. 與使用者確認 task 0.5（技術選型）
3. 完成 task 0.6（protocol 定義）後，Phase 0 結束
4. 從 Phase 1（Remote Agent Binary）開始實作

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
- [ ] Remote agent binary 技術選型已確認
- [ ] 現有 tool dispatch 架構盤點完成
- [ ] Remote agent protocol schema 定義完成
