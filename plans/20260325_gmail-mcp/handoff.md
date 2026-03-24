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

- Phase 1 草稿已建立：`gmail/client.ts` 和 `gmail/index.ts` 已寫入磁碟但尚未 review
- Phase 2-6 尚未開始
- 所有 plan artifacts 已完成

## Stop Gates In Force

- GCP Console 未啟用 Gmail API → 需使用者手動操作後才能做 end-to-end 測試
- OAuth re-auth 後 Calendar 功能異常 → 需確認 scope 合併正確性
- Build 有 type error → 修復後才能進入驗證

## Build Entry Recommendation

- 從 Phase 1 開始：review 現有 `gmail/client.ts` 和 `gmail/index.ts` 草稿
- Phase 2（Registry）和 Phase 3（OAuth）是核心改動，需特別注意 Calendar 向下相容
- Phase 3 是最關鍵的改動（泛化 OAuth），建議由主代理親手完成而非委派

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
