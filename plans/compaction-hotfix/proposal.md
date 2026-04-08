# Proposal

## Why

Codex Plus 帳號在一輪 MVP build cycle 中 3.8 小時燒掉 25% 週 quota，調查發現 client-side compaction 機制全面失效：

1. **compact_threshold 硬編碼 100K**（codex.ts:755）：對 gpt-5.4（400K context）只佔 25%，OpenAI server 在 100K 就壓縮，client compaction threshold 383K 永遠不觸發。整輪開發零次 compaction/checkpoint/snapshot。

2. **Compaction summary 依賴 AI 手動打 `#tag`**：SessionSnapshot 靠 AI 在回覆末尾打 `#fact`/`#decision` 等 tag，不可靠。SharedContext 已自動收集完整工作狀態（Goal, Files, Discoveries, Accomplished），但被標為 deprecated，compaction 不用它。

## Original Requirement Wording (Baseline)

- "幾分鐘用掉 25% 週用量不太正常"
- "compaction/snapshot/checkpoint 在今天這一輪開發中發生了嗎？"
- "這個硬編碼限制一定是錯的。好歹也要根據使用的 model 來動態調整"
- "只留第二個（SharedContext）"
- "snapshot 可以廢了。sharedcontext 的增量落地資訊就足夠 compaction 使用了"

## Requirement Revision History

- 2026-04-08: 從 quota 消耗異常調查中發現 compact_threshold 硬編碼 + client compaction 失效
- 2026-04-08 (rev 1): 確認 SessionSnapshot 應廢除，compaction 改用 SharedContext

## Effective Requirement Description

1. `context_management.compact_threshold` 必須根據 model context limit 動態計算，不可硬編碼
2. 每次 model 切換時 compact_threshold 必須跟著更新
3. 廢除 SessionSnapshot namespace，compaction 改用 `SharedContext.snapshot()`
4. 移除 `#tag` 解析/stripping 邏輯
5. 移除 AGENTS.md 中的 SessionSnapshot Tags 規範

## Scope

### IN

- `packages/opencode/src/plugin/codex.ts:755` — compact_threshold 動態化
- `packages/opencode/src/session/shared-context.ts` — 移除 SessionSnapshot namespace
- `packages/opencode/src/session/compaction.ts` — 4 個呼叫點改用 SharedContext
- `packages/opencode/src/session/prompt.ts` — 移除 #tag 解析/stripping + compaction snapshot 來源切換
- `AGENTS.md` — 移除 SessionSnapshot Tags 規範

### OUT

- AI SDK 層、autonomous runner、WS/HTTP transport、非 codex provider — 不修改
- SharedContext.updateFromTurn() — 不修改（已正常運作）
- Codex provider 重構 — 另案 `plans/codex-refactor/`

## Non-Goals

- 不修改 SharedContext 的資料收集邏輯（已足夠完整）
- 不修改 Codex HTTP/WS transport
- 不修改 autonomous runner

## Constraints

- `context_management` 參數行為由 OpenAI server 控制
- SharedContext.snapshot() 的格式必須能被 `compactWithSharedContext` 直接消費
- 向後相容：已存在的 rebind checkpoint 檔案格式不變

## What Changes

- compact_threshold 從硬編碼 100K 改為 `contextLimit * 0.8`
- Compaction summary 從 SessionSnapshot → SharedContext
- `#tag` 機制移除（AI 不再需要在回覆末尾打 tag）

## Capabilities

### New Capabilities

- **動態 compact_threshold**: 根據 model context limit 自動調整
- **自動化 compaction summary**: 不再依賴 AI 手動打 tag

### Modified Capabilities

- **SharedContext**: 從 deprecated 狀態升為 compaction 唯一 summary 來源

## Impact

- **全 provider**: compaction summary 品質提升（自動收集 > AI 手動 tag）
- **Codex provider**: client compaction 恢復運作，checkpoint/snapshot 正常觸發
- **AI 行為**: 不再需要在回覆末尾打 `#tag`（規範移除）
- **對話品質**: 減少 server 端過度壓縮造成的歷史丟失
