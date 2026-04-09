# Proposal: Context Dispatch Optimization

## Why

- Subagent context dispatch 對 Codex（Responses API）每次重送 100K token parent history，無法命中 parent 的雲端 cache，浪費大量成本。
- Codex 是 state-reference cache（認 `previousResponseId`，不認內容），content-based provider（Anthropic/Gemini）不受影響。
- Rebind checkpoint 已存在但只用於 daemon restart recovery，可複用於 subagent dispatch 減量。

## Original Requirement Wording

- "subagent context optimization"
- Codex subagent 每次啟動都付出 100K token cache write 代價

## Effective Requirement Description

1. Codex subagent dispatch：傳遞 parent `previousResponseId`（fork），child 從 parent 雲端 state 繼續，第一 round 只送 task
2. Checkpoint-based dispatch：有 checkpoint 時用 summary+steps 取代 full history（all providers）
3. 兩者可疊加：Codex 走 fork（最優），non-Codex 走 checkpoint（減量）

## Scope

### IN

- Codex fork dispatch（previousResponseId 傳遞）
- Checkpoint-based dispatch（provider-agnostic fallback）

### OUT

- Subagent taxonomy 正式化（→ `/plans/subagent-taxonomy/`）
- Daemon agent（→ `/plans/daemon-agent/`）
- 跨 provider 的 cache 機制統一
- Anthropic/Gemini context dispatch 路徑（stable prefix 已有效）

## Constraints

- Codex fork 只對 `providerId === "codex"` 生效，不影響其他 provider
- Checkpoint dispatch 是 opportunistic，不 blocking
- Non-Codex provider 行為完全不變（regression guard）

## What Changes

- `task.ts`：dispatch 時讀取 parent codexSessionState，傳遞 previousResponseId
- `prompt.ts`：child session 判斷 Codex fork 時跳過 parentMessagePrefix 注入
- `llm.ts`：暴露 `getCodexResponseId()`，新增 `seedCodexForkState()`，first-call hash bypass

## Impact

- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/compaction.ts`（checkpoint dispatch 路徑）
