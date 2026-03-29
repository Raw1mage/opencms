# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read design.md 的 AI SDK 架構分析
- Phase 1 是純分析，不改程式碼

## Required Reads

- implementation-spec.md
- design.md（特別是 AI SDK 架構分析和 streamText pipeline 圖）
- tasks.md
- proposal.md

## Current State

- CUSTOM_LOADER 已停用（cms branch），codex 走 AI SDK path 正常運作
- Phase 1-2 的 fetch interceptor 功能（prompt_cache_key、turn_state）已在線運作
- Phase 3-4 的功能（WS transport、compaction）在 CodexLanguageModel 裡，未被使用
- codex-stream-compat worktree 有 WS 併發修復 + debug log，未 merge（已過時）

## Stop Gates In Force

- SG-1: @ai-sdk/openai responses adapter 的欄位支援度
- SG-2: fetch interceptor additive transform 安全性

## Build Entry Recommendation

- 從 Phase 1.1 開始：讀 @ai-sdk/openai 的 responses adapter source code
- 不需要 worktree — 純分析工作

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
