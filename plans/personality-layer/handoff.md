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

- Plan 剛建立，尚未開始實作
- codex-efficiency plan（Phase 1-4）已完成，此 plan 是後續的 prompt pipeline 重構
- 當前 codex provider 可正常對話，但使用的是 `codex_header.txt`（opencode 自己的 header），而非原廠 per-model driver prompt

## Stop Gates In Force

- SG-1: 拆 `useInstructionsOption` 時若其他 provider prompt 壞掉，需逐一排查
- SG-2: personality 替換後若 prompt 超過 context window，需加截斷

## Build Entry Recommendation

- 從 Phase 1 開始（bug fix），獨立可交付
- Phase 1 完成後立即驗證 codex 和其他 provider 的 prompt output
- Phase 2-3 可以在 Phase 1 穩定後再開始

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
