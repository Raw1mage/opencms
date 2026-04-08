# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read proposal.md before coding
- Materialize tasks.md into runtime todos before coding

## Required Reads

- implementation-spec.md
- proposal.md
- tasks.md
- `refs/codex/codex-rs/codex-api/src/common.rs` — upstream protocol 定義
- `packages/opencode/src/plugin/claude-native.ts` — zero-config plugin 參考模板

## Prerequisite

- **`plans/compaction-hotfix/` 必須先完成**（compact_threshold 動態化 + SessionSnapshot 廢除），否則 codex plugin 會帶入已知問題

## Current State

- Plan 初稿完成，Phase 1 (upstream 分析) 尚未開始
- refs/codex submodule 在 `rust-v0.0.2504301132`，需 fetch 最新

## Key Code References

| 位置 | 用途 |
|------|------|
| `plugin/codex.ts` (960 行) | 現有 auth + fetch interceptor — 拆解對象 |
| `plugin/codex-websocket.ts` (653 行) | WS transport — 搬進 plugin |
| `plugin/codex-native.ts` (318 行) | FFI binary — 搬進 plugin |
| `plugin/claude-native.ts` (205 行) | zero-config plugin 參考模板 |
| `plugin/index.ts` | plugin 註冊點 |
| `provider/provider.ts:1260-1300` | codex model 定義 — 搬進 plugin |
| `session/llm.ts:717` | AI SDK streamText 呼叫點 — codex 路徑需改 |
| `refs/codex/codex-rs/codex-api/src/common.rs` | upstream protocol types |
| `refs/codex/codex-rs/core/src/client.rs` | upstream client 實作 |

## Stop Gates In Force

- `@opencode-ai/plugin` 介面不足 → 需先擴展
- AI SDK message format 不可分離 → fork 或 wrapper
- Rate limit tracking 無法在 plugin 層整合 → 定義協議

## Build Entry Recommendation

**Phase 1 (Upstream 分析) 先做**。產出 native protocol spec 和差異清單後，Phase 2-3 的設計才有依據。不要跳到實作。

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Proposal is complete
- [x] Tasks are defined
- [ ] Prerequisite plan (compaction-hotfix) completed
- [ ] Phase 1 upstream 分析 completed
- [ ] Phase 2-3 設計文件 completed（design.md）
