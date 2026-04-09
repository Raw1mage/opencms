# Tasks

## 1. Codex Fork Dispatch

- [x] 1.1 `codex-provider/types.ts`：`ContinuationState` 加 `isForkSeed?: boolean` flag
- [x] 1.2 `codex-provider/transport-ws.ts`：fresh connection path 檢查 `isForkSeed` — 若存在，保留 `previous_response_id`，不清除 continuation
- [x] 1.3 `session/index.ts`：`Session.Info` 加 `codexForkResponseId?: string`，`Session.create()` + `createNext()` 透傳
- [x] 1.4 `tool/task.ts`：model 解析後，若 `providerId === "codex"`，讀 parent continuation → seed child continuation + 更新 session info
- [x] 1.5 `session/prompt.ts`：child session startup 偵測 `codexForkResponseId` → skip parentMessagePrefix
- [ ] 1.6 驗證：Codex subagent 第一 round `[CODEX-WS] REQ` log 顯示 `delta=true`；non-Codex dispatch 行為不變

## 2. Checkpoint-Based Dispatch

- [ ] 2.1 在 `task.ts` non-Codex dispatch 路徑，呼叫 `SessionCompaction.loadRebindCheckpoint(parentSessionID)`
- [ ] 2.2 若 checkpoint 存在，組合 `[synthetic summary message + messages after lastMessageId]` 作為 parentMessagePrefix
- [ ] 2.3 若 checkpoint 不存在，fallback 到 full history（現有行為，log 記錄原因）
- [ ] 2.4 驗證：有 checkpoint 時 child first-round token count 大幅縮減；無 checkpoint 時行為不變
