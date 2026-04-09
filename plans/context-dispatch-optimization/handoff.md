# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read design.md / spec.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding

## Required Reads

- implementation-spec.md
- design.md
- spec.md
- tasks.md
- `packages/opencode/src/tool/task.ts` — dispatch 邏輯全覽
- `packages/opencode/src/session/llm.ts` — codexSessionState 結構
- `packages/opencode/src/session/prompt.ts` — parentMessagePrefix 注入
- `packages/opencode/src/session/compaction.ts` — loadRebindCheckpoint

## Current State

- Phase 1-2 尚未開始
- `REBIND_BUDGET_TOKEN_THRESHOLD` 已從 1000 改為 40_000（2026-04-01）
- Codex delta `previousResponseId` 機制已在 `llm.ts` 實作並運作中
- V2 context sharing 已穩定運作（Anthropic/Gemini cache hit 92-99%）

## Stop Gates In Force

- Codex fork 實作前：audit `llm.ts` hash bypass 不造成 stale responseId

## Build Entry Recommendation

從 Phase 1（Codex Fork Dispatch）開始，改動最小且收益最大。Phase 2 可獨立進行。

## Origin

拆分自 `/plans/subagent-evolution/`（Phase 1 + Phase 2）。
