# Event — Codex WS context overflow hotfix (2026-04-29)

## 需求

使用者回報近期頻繁出現：`Codex WS: Your input exceeds the context window of this model. Please adjust your input and try again.`，且 Claude 的未提交修改目標是先停止 double 報錯。使用者明確要求直接 hotfix，且不接受降低 Codex `272K` context limit。

## 範圍 (IN)

- 保留/強化 compaction 前切斷 Codex `previous_response_id` chain 的止血方向。
- 強化 Codex WS context overflow 時的 continuation invalidation 訊號。
- 避免 synthetic `?` nudge 成為預設行為，降低訊息流污染與重試噪音。
- 不降低 `gpt-5.5` / Codex 的 272K context 設定。

## 範圍 (OUT)

- 不調降 model context window。
- 不新增 silent fallback。
- 不重啟 daemon / gateway；若需要生效，後續只走 `restart_self`。
- 不做完整 context epoch / anchor-id 架構改造；本次限 hotfix。

## 任務清單

- [x] 1. 建立 XDG 白名單備份。
- [x] 2. Hotfix Codex WS overflow invalidation 與 per-account continuation 清理。
- [x] 3. Hotfix empty-response 行為，移除預設 synthetic `?` 自動 nudge。
- [x] 4. Focused validation 與 architecture sync 檢查。

## Debug checkpoints

### Baseline

- `debug.log` 顯示 2026-04-29 18:47 / 18:55 已在其他 session 發生同樣 Codex WS context overflow。
- 當前 session token stats 快速累積，顯示 local context/WS hidden context 可能不同步。
- 最近 commits 集中於 compaction 與 Codex `previous_response_id` chain reset。

### Instrumentation Plan

- Codex WS boundary：檢查 `previous_response_id`、`lastInputLength`、overflow error handling。
- Compaction boundary：確認 LLM compaction call 前已切 chain。
- Prompt loop boundary：避免 empty-response 自動 nudge 污染 message stream。

### Execution

- XDG 白名單備份建立於 `/home/pkcs12/.config/opencode.bak-20260429-1927-codex-ws-hotfix/`，只包含允許清單內的 auth/config 檔。
- 新增 `invalidateContinuationFamily(sessionId)`，清除 base session key 與所有 `sessionID:accountId` continuation shard 的 `lastResponseId` / `lastInputLength`。
- Codex WS stale-length reset、compaction/rebind、same-provider account switch 改用 continuation family invalidation。
- Codex WS context overflow path 先設定 `state.continuationInvalidated = true`，再 invalidate chain 並回報 provider error。
- Empty-response guard 改為 fail-fast：不再自動寫入 synthetic `?` user turn。
- `specs/architecture.md` 已補充 Codex WS continuation family reset hotfix。

### Root Cause

- 初步判斷：compaction/rebind 使 local messages context 換代，但 Codex WS server-side `previous_response_id` hidden context 可能仍沿用舊鏈，造成 local 估算與 server 實際上下文不同步。
- 進一步修正點：舊修法只清 base `sessionID` continuation；但 transport 存在 per-account shard (`sessionID:accountId`) restore path。若 compaction 或 account switch 後從 shard 取回舊 `lastResponseId`，仍可能復用 stale server-side chain。

### Validation

- `bun test packages/opencode-codex-provider/src/transport-ws.test.ts packages/opencode/src/session/compaction.test.ts packages/opencode/src/session/compaction-run.test.ts packages/opencode/src/session/compaction.regression-2026-04-27.test.ts` — 47 pass / 0 fail。
- `bun run typecheck` under `packages/opencode` — failed on pre-existing unrelated errors (codex-provider `convert.ts` AI SDK drift, CLI command arg count drift, TUI `sessionId` vs `subSessionID`, server route/schema drift, workflow-runner patch shape). No reported errors in changed files: `continuation.ts`, `transport-ws.ts`, `compaction.ts`, `prompt.ts`.
- Architecture Sync: Updated `specs/architecture.md` continuation-invalidated section with family-level reset and overflow invalidation behavior.

## Remaining

- Full root-cause hardening should add explicit context epoch / anchor id binding to continuation state. This hotfix intentionally does not lower 272K context and does not implement the larger epoch refactor.
