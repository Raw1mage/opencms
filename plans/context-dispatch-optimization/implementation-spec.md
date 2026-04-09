# Implementation Spec: Context Dispatch Optimization

## Goal

優化 subagent context dispatch 的 token 成本：Codex 走 fork（最優），non-Codex 走 checkpoint（減量）。

## Architecture Discovery (2026-04-09)

原計畫假設 `llm.ts` 有 `codexSessionState` Map — **不存在**。實際架構：

- Codex provider 透過 `transport-ws.ts` 的 `WsSessionState` 管理 `lastResponseId`（in-memory）
- 持久化透過 `continuation.ts` → `ws-continuation.json`（file-backed，keyed by sessionId）
- `tryWsTransport()` 在 fresh WS connection 時會 **清除** `previous_response_id`（line 434）
- `streamText()` 的 `providerOptions` 不會帶 `previousResponseId`（codex provider 自己管）

**Fork 機制需要改的層：codex-provider transport（而非 llm.ts）**

## Scope

### IN

- Phase 1: Codex fork dispatch — 跨 session 繼承 `previousResponseId`
- Phase 2: Checkpoint-based dispatch — non-Codex 路徑（獨立）

### OUT

- 修改 `llm.ts`（不需要）
- Subagent taxonomy / daemon agent（已拆到獨立計畫）

## Phase 1: Codex Fork Dispatch

### 改動清單

1. **`packages/opencode-codex-provider/src/types.ts`**
   - `ContinuationState` 加 `isForkSeed?: boolean`

2. **`packages/opencode-codex-provider/src/transport-ws.ts`**
   - `tryWsTransport()` fresh connection path (line 427-444)：若 continuation 有 `isForkSeed`，保留 `previous_response_id`，不清除
   - 使用後清除 `isForkSeed` flag

3. **`packages/opencode-codex-provider/src/continuation.ts`**
   - 已有 `updateContinuation()` — 可直接用，無需改

4. **`packages/opencode-codex-provider/src/index.ts`**
   - Export `getContinuation` + `updateContinuation`（若尚未 export）

5. **`packages/opencode/src/session/index.ts`**
   - `Session.Info` 加 `codexForkResponseId?: string`

6. **`packages/opencode/src/tool/task.ts`**
   - Model 解析後，若 `providerId === "codex"`：
     - Import `getContinuation` from codex-provider
     - 讀 parent continuation → 取 `lastResponseId`
     - 傳給 `Session.create({ codexForkResponseId })`
   - Worker dispatch 前：`updateContinuation(childSessionId, { lastResponseId, isForkSeed: true })`

7. **`packages/opencode/src/session/prompt.ts`**
   - Line 833：若 `session.codexForkResponseId` 存在 → skip parentMessagePrefix loading

### 資料流

```
task.ts dispatch (parent session, Codex)
  │
  ├─ getContinuation(parentSessionId) → { lastResponseId: R_N }
  │
  ├─ Session.create({ codexForkResponseId: R_N })
  │
  ├─ updateContinuation(childSessionId, { lastResponseId: R_N, isForkSeed: true })
  │
  └─ spawnWorker(childSessionId)
       │
       ├─ prompt.ts: session.codexForkResponseId → skip parentMessagePrefix
       │
       ├─ llm.ts → streamText() → codex provider.doStream()
       │
       └─ transport-ws.ts:
            ├─ getSession(childSessionId) → reads continuation → lastResponseId = R_N
            ├─ fresh WS: isForkSeed=true → keep previous_response_id = R_N
            ├─ server: continues from parent R_N + child input
            ├─ response.completed → lastResponseId = C_1, isForkSeed cleared
            └─ subsequent calls: normal delta chain C_1 → C_2 → ...
```

### Regression Guard

- Non-Codex provider：`codexForkResponseId` undefined → parentMessagePrefix 正常載入 → 行為不變
- Codex but parent 沒有 responseId：`getContinuation()` returns `{}` → fork 不啟動 → 走現有路徑

### Fork Failure

- Server rejects `previous_response_id` → transport 已有 `CONTINUATION_INVALIDATED` 處理
- Child retries with fresh connection → no parent context → accepted degradation（child 有 task prompt，可獨立工作）
- Log warning 讓開發者知道 fork 失敗

## Phase 2: Checkpoint-Based Dispatch

（獨立於 Phase 1，改動集中在 `task.ts` + `prompt.ts`）

- 在 `task.ts` non-Codex dispatch 路徑，呼叫 `SessionCompaction.loadRebindCheckpoint(parentSessionID)`
- 若 checkpoint 存在，組合精簡 prefix 取代 full history
- 若不存在，fallback 到 full history（log 記錄原因）

## Validation

- Phase 1：`[CODEX-WS] REQ` log 顯示 child 第一 round `delta=true`，inputItems 不含 parent history
- Phase 1：non-Codex dispatch 行為不變
- Phase 2：有 checkpoint 時 child first-round token count < 10K
