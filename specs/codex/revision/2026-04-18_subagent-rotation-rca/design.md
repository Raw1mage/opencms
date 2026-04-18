# Design: subagent-rotation-rca

## Context

Parent: `specs/codex/provider_runtime/` (living) + 跨進 `packages/opencode/src/session/` 與 `packages/opencode/src/tool/`。本 revision 以 RCA 為主，Fix scope 待 Phase C 結論確定。

## Goals / Non-Goals

**Goals**
- 完整描述 subagent rate-limit escalation chain 的每個節點、資料流與 race window
- 列舉可能的 RCA 候選，並規劃 instrumentation 以驗證
- 列舉每個候選 RCA 的 fix option

**Non-Goals**
- 本 design.md 不選定 fix；Phase C 完成後再回來補 `## Chosen Fix` 段落
- 不改 `Session.pinExecutionIdentity` 的核心語意
- 不觸碰 Bus 核心、rotation3d 選帳號邏輯

## Escalation Chain — 完整路徑

```
Subagent worker (child process)
├─ 1. Child hits 429
│   processor.ts:1260 (child rate-limit branch)
│
├─ 2. Cumulative escalation guard
│   processor.ts:1264-1279
│   MAX_CUMULATIVE_ESCALATIONS 超過 → fail fast
│
├─ 3. Child publishes event
│   processor.ts:1289 — await Bus.publish(RateLimitEscalationEvent, {
│     sessionID, currentModel, error, triedVectors })
│   (comment: "bridged to parent via stdout")
│
├─ 4. Child waits
│   processor.ts:1301 — await ModelUpdateSignal.wait(sessionID)
│   model-update-signal.ts: 30s timeout, single pending per sessionID,
│   new wait() cancels previous
│
└─ 5. On resume, apply model + continue
    processor.ts:1307-1328 — reset fallbackAttempts, triedVectors.clear()

Parent process
├─ 6. Receives event
│   task.ts:412-413 — Bus subscriber routes to handleRateLimitEscalation
│
├─ 7. Lookup worker
│   task.ts:442 — workers.find(w => w.current?.sessionID === childSessionID)
│
├─ 8. Run rotation3d
│   task.ts:480 — LLM.handleRateLimitFallback(
│     currentProviderModel, "account-first", triedSet,
│     new Error(error), accountId, sessionIdentity, {silent: true})
│
├─ 9a. If no fallback found
│   task.ts:496-508 — DO NOT push parent.execution (would re-hit 429)
│   intentional silence → child ModelUpdateSignal times out at 30s
│   (Fix B1 added 2026-04-18)
│
└─ 9b. If fallback found
    task.ts:526-547 — worker.proc.stdin.write(
      JSON.stringify({type: "model_update", sessionID, providerId,
        modelID, accountId}) + "\n")
    + Session.pinExecutionIdentity({sessionID, model: newModel})

Worker stdin handler (same worker process as Subagent)
└─ 10. Validates + resolves
    session.ts:313-326 — ModelUpdateSignal.resolve(sessionID, {
      providerId, modelID, accountId })
    sends {type: "model_updated", sessionID, resolved} ack back
```

## Identified Race Windows

- **RW-1 `wait()` cancels prior pending** — `model-update-signal.ts:32-36` 顯示若同 sessionID 再發一次 `wait()`，舊的 pending 被 `clearTimeout` + `pending.delete()`。如果 child 在短時間內連發兩次 escalation（例如 pre-flight 一個 + retry path 一個），第二次 wait 會讓第一次的 parent `resolve()` 變 no-op。第二個 wait 若沒有對應的第二次 parent 回覆就會 timeout。
- **RW-2 Parent handler 非序列化** — `handleRateLimitEscalation` 是普通 async function，沒有 per-session mutex。若同一 session 的兩個 event 幾乎同時抵達，兩次 `LLM.handleRateLimitFallback` 與兩次 `stdin.write` 都會發生。worker 只會 resolve 第一個到達的（其餘都 no-op），但 `pinExecutionIdentity` 也被寫兩次，可能以後者覆蓋前者。
- **RW-3 Worker lookup race** — parent 用 `workers.find(w => w.current?.sessionID === childSessionID)`。若 worker 處理完 child A 立刻被重用到 child B，lookup 可能找錯或找不到。Escalation event 的 sessionID 是快照，worker pointer 是即時；不一致就漏傳 `model_update`。
- **RW-4 rotation3d 找不到 fallback** — 所有 codex 帳號都被 rate-limit；或 sessionIdentity 約束讓選不到；或 triedVectors 已耗盡候選。parent 沉默（Fix B1 的刻意設計）→ child 30s timeout → fail fast。此路徑**對使用者呈現是卡 30 秒後出錯**，不是 rotation bug，而是「沒可用帳號」。
- **RW-5 Bus publish 延遲** — `await Bus.publish(...)` 若有多 subscriber 同步處理（Bus 為 sync chain），publish 本身可能 block child process 數百 ms。量測需要。
- **RW-6 stdin backpressure / exit** — `worker.proc.stdin.write()` 若 worker 正在 teardown 或 stdin closed，write 可能 throw（有 catch 在 task.ts:541-547）。理論上應該被 log，但若 worker 意外 exit 後 stdin write 卻成功（kernel buffer），`model_updated` ack 就消失。

## Candidate RCA Hypotheses

1. **H1 — 無 fallback 路徑被觸發**：使用者手頭多個 codex 帳號同時 rate-limit。parent 找不到 fallback → 沉默 → child 30s timeout。驗證方式：Phase A 量測 `handleRateLimitFallback` 回傳值是否為 null。
2. **H2 — escalation chain latency 高**：chain 本身正常，但 round-trip >2s 使得使用者先看到 error 再看到 rotation，感覺像「沒 rotate」。驗證方式：Phase A 在 chain 5 點加 log 看時間。
3. **H3 — 雙 escalation 造成 stuck**：child 連發兩次 escalation（pre-flight 一次 + retry 一次）命中 RW-1，第一次被吃掉。驗證方式：Phase A log 每次 `wait()` / `resolve()` 配對。
4. **H4 — UI 雙渲染**：chain 本身沒問題，但 UI 把同一個 error event 顯示兩次，造成「rotation 沒發生」的錯覺。驗證方式：Phase B 比對後端 log 與 TUI 顯示。
5. **H5 — Worker lookup race**：parent 找錯 worker 或找不到，log 只會 warn 不會讓使用者看到明確錯誤（task.ts:444, 451）。驗證方式：Phase A log 每次 `workers.find` 結果與命中 session。

## Fix Options (per candidate)

- **For H1**：UI 顯示 `[no rotation available — N accounts exhausted]` 取代泛型 rate-limit error。Code 改動小，使用者體驗大幅改善。
- **For H2**：量化後決定。若 chain latency 主要在 Bus publish → 改 Bus subscriber 用 microtask；若主要在 stdin write → 預先 pipe；若在 rotation3d → 快取上次選帳號的 metadata。
- **For H3**：`ModelUpdateSignal.wait()` 不取消舊 pending、改為佇列 queue（每次 resolve pop 一個）；或於 child side dedupe escalation publish。
- **For H4**：TUI context sync 層加 requestID + ts 去重；或在 rotation in-flight 時 suppress 錯誤顯示。
- **For H5**：Worker lookup 改從 `workers` + `activeRequests` 雙索引確認；或 event 本身夾帶 workerID，parent 直接 by workerID 找。

## Risks / Trade-offs

- 全部都要 Phase A instrument log 才能確定；在沒有量測前不做 code 修改
- 一旦加 log，可能找到多個並存問題 — Phase C 結論可能要 split 成多個 follow-up revision
- 若 RCA 結論指向 Bus 架構或 pinning 語意改動，需 escalate 為 `provider_runtime` 的 extend / refactor mode

## Critical Files

- `packages/opencode/src/session/processor.ts` (line 1260-1400 區段)
- `packages/opencode/src/tool/task.ts` (line 410-560 區段)
- `packages/opencode/src/session/model-update-signal.ts` (整檔 69 行)
- `packages/opencode/src/cli/cmd/session.ts` (line 300-330 stdin handler)
- `packages/opencode/src/session/llm.ts` (handleRateLimitFallback 實作)
- `packages/opencode/src/account/rotation3d.ts` (findFallback 實作)

## Open Questions

- `RateLimitEscalationEvent` 的 Bus 發送路徑：child process → parent process 需經 stdout 轉傳嗎？還是有 IPC channel？需確認 Bus 跨 process 橋接機制。
- `triedVectors` 內容是否包含「已 timeout 的帳號」？若只有「嘗試過」而不含「沒信心」，rotation3d 可能把剛 timeout 的帳號再挑一次。
- UI 兩次錯誤訊息的 event 來源：是 provider 端發兩次、還是 TUI reducer 重覆處理？
