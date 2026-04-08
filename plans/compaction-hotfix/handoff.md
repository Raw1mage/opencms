# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read tasks.md before coding
- Materialize tasks.md into runtime todos before coding

## Required Reads

- implementation-spec.md
- proposal.md
- tasks.md

## Current State

- Plan 完成，待執行
- 所有 critical files 已確認位置
- Phase 1 改一行，Phase 2 刪多改少

## Key Code References

| 位置 | 用途 |
|------|------|
| `codex.ts:755` | 硬編碼 `compact_threshold: 100000` — Phase 1 修改點 |
| `provider.ts:1299` | codex model `limit: { context: 400000 }` — context limit 來源 |
| `shared-context.ts:22-196` | SessionSnapshot namespace — Phase 2 刪除對象 |
| `shared-context.ts:198+` | SharedContext namespace — Phase 2 升為主力 |
| `compaction.ts:110,768` | snapshot 呼叫點 — 改為 SharedContext |
| `prompt.ts:1242,1310` | compaction snapshot 來源 — 改為 SharedContext |
| `prompt.ts:1731-1757` | #tag 解析 + persistSnapshot — 移除 |

## Stop Gates In Force

- compact_threshold 調高後 Codex API error → 找上限
- SharedContext.snapshot() 為空 → 已有 LLM fallback 路徑
- Client + server 雙重壓縮 → 調整比例

## Build Entry Recommendation

**Phase 1 先做**（一行改動），觀察 compaction 是否恢復觸發。確認後做 Phase 2（SessionSnapshot 廢除）。

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
- [x] Critical files identified
