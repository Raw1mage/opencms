# Tasks

## 1. compact_threshold 動態化

- [ ] 1.1 在 codex.ts body transform 中，從 `body.model` 取得 model ID
- [ ] 1.2 用 `Provider.getModel("codex", modelId)` 查詢 `limit.context`
- [ ] 1.3 計算 `compact_threshold = Math.floor(contextLimit * 0.8)`
- [ ] 1.4 查詢失敗時 fallback 到 100000 並 `log.warn`
- [ ] 1.5 替換 codex.ts:755 硬編碼為動態值
- [ ] 1.6 log 記錄實際 threshold 和 model context limit

## 2. 廢除 SessionSnapshot

- [ ] 2.1 刪除 shared-context.ts 中 `SessionSnapshot` namespace（L22-196）
- [ ] 2.2 修改 compaction.ts:110 → `SharedContext.snapshot()`
- [ ] 2.3 修改 compaction.ts:768 → `SharedContext.snapshot()`
- [ ] 2.4 修改 prompt.ts:1310 → `SharedContext.snapshot()`
- [ ] 2.5 修改 prompt.ts:1242 → `SharedContext.snapshot()`
- [ ] 2.6 移除 prompt.ts:1731-1746 `#tag` 解析 + stripping
- [ ] 2.7 移除 prompt.ts:1757 `SessionSnapshot.persistSnapshot()`
- [ ] 2.8 移除 prompt.ts:1748 `(deprecated)` 標記
- [ ] 2.9 移除 AGENTS.md `## SessionSnapshot Tags` 區段
- [ ] 2.10 清除所有 `import { SessionSnapshot }` 殘留
- [ ] 2.11 確認 `bun test` 全過

## 3. 驗證

- [ ] 3.1 啟動 daemon，codex gpt-5.4 session → log 顯示 `compact_threshold: 320000`
- [ ] 3.2 切換 model → threshold 跟隨變化
- [ ] 3.3 Compaction 觸發時 snapshot 為 SharedContext 格式
- [ ] 3.4 `bun test` 全過
