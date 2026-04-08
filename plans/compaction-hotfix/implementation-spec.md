# Implementation Spec

## Goal

恢復 client-side compaction 機制，並將 compaction summary 來源從 SessionSnapshot（依賴 AI 打 tag）切換為 SharedContext（自動收集）。

## Scope

### IN

- codex.ts:755 — compact_threshold 動態化
- shared-context.ts — 刪除 SessionSnapshot namespace
- compaction.ts — 4 個 snapshot 呼叫點改用 SharedContext
- prompt.ts — 移除 #tag 解析/stripping + snapshot 來源切換
- AGENTS.md — 移除 SessionSnapshot Tags 規範

### OUT

- AI SDK 層、transport 層、autonomous runner、其他 provider — 不修改

## Assumptions

- Codex API 的 `context_management.compact_threshold` 接受任意正整數
- SharedContext.snapshot() 輸出格式可直接被 compactWithSharedContext 消費
- SharedContext.updateFromTurn() 已正常運作（標記 deprecated 只是歷史原因）

## Stop Gates

- compact_threshold 調高後 Codex API 回 error → 找 server 接受上限
- SharedContext.snapshot() 為空時 compaction 無 summary → 需要 fallback 到 LLM compaction（已有此路徑）
- Client + server 雙重壓縮衝突 → 調整 threshold 比例

## Critical Files

- `packages/opencode/src/plugin/codex.ts:755` — 硬編碼 compact_threshold
- `packages/opencode/src/session/shared-context.ts:22-196` — SessionSnapshot namespace（刪除對象）
- `packages/opencode/src/session/shared-context.ts:198+` — SharedContext namespace（升為主力）
- `packages/opencode/src/session/compaction.ts:110,768` — snapshot 呼叫點
- `packages/opencode/src/session/prompt.ts:1242,1310,1731-1757` — snapshot 呼叫點 + #tag 邏輯
- `packages/opencode/src/provider/provider.ts:1299` — codex model context limit 定義
- `AGENTS.md` — SessionSnapshot Tags 規範

## Structured Execution Phases

### Phase 1: compact_threshold 動態化

1. 從 request body `model` 欄位查詢 `Provider.getModel("codex", modelId).limit.context`
2. 計算 `compact_threshold = Math.floor(contextLimit * 0.8)`
3. 查詢失敗 → `log.warn` + fallback 100K（AGENTS.md 第一條：不可靜默 fallback）
4. 記錄實際 threshold 到 log

### Phase 2: 廢除 SessionSnapshot，Compaction 改用 SharedContext

1. 刪除 shared-context.ts 中 `SessionSnapshot` namespace
2. 修改 compaction.ts:110, 768 和 prompt.ts:1310, 1242 的 4 個 `SessionSnapshot.snapshot()` → `SharedContext.snapshot()`
3. 移除 prompt.ts:1731-1746 的 `#tag` 解析 + stripping
4. 移除 prompt.ts:1757 的 `SessionSnapshot.persistSnapshot()`
5. 移除 prompt.ts:1748 的 `(deprecated)` 標記
6. 移除 AGENTS.md 中 SessionSnapshot Tags 規範
7. 清除所有殘留 `import { SessionSnapshot }`

## Validation

- compact_threshold 在 gpt-5.4 = 320K，gpt-5.1-codex-mini = 102K
- Model 切換時 log 顯示 threshold 變化
- Compaction 觸發時 log 顯示 SharedContext 格式（Goal / Discoveries / Accomplished）
- `#tag` 行不再被 strip（留在 assistant text 中，但不影響功能）
- `bun test` 全過

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
