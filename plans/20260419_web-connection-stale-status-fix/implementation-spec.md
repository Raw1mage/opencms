# Implementation Spec — web connection stale status fix

## Goal

- 讓 web frontend 在弱網路 / reconnect / stale event stream 下，正確顯示 connection 與 runtime authority，避免假 running / 假 stuck / 假 elapsed。

## Scope

### IN

- Connection state machine for web global event stream
- Active-child footer stale-state handling
- Elapsed / stale counter authoritative refresh rules
- Reconnect / reload / foreground resume / online rehydrate contract
- Input blocking during degraded/reconnecting states
- Toast / banner level operator feedback

### OUT

- 不重寫 backend event bus / SSE protocol
- 不重做 subagent worker lifecycle
- 不把所有 web realtime store 改成新架構
- 不自動建 fallback execution path

## Baseline Findings

- `packages/app/src/pages/session/monitor-helper.ts` 目前以 `now - latestUpdate` 算 `elapsed`，這不是 worker 真實 runtime。
- `packages/app/src/pages/session/session-side-panel.tsx` 直接把這個 elapsed 呈現在 process card 上。
- `reload web 後 footer 消失` 顯示先前 footer 很可能是 stale projection，而非 authoritative active-child。
- 既有事件 `docs/events/event_20260327_subagent_status_projection_consistency.md` 已證明本系統曾出現 child running projection stale 問題。

## Assumptions

- Backend 仍以 `session.status`、`session.active-child.updated`、session snapshot / monitor data 作為 authority source。
- 弱網路下，frontend 可能失去部分 event，但 reload/reconnect 後仍能透過 snapshot API 取回權威狀態。

## Stop Gates

- 若目前沒有可單次取得 authoritative active-child + session status 的 API/snapshot 組合，需先補 authority source，再實作 UI 收斂。
- 若 `monitor-helper` 的 display card 被多處重用，修改 elapsed 語義前需確認不會破壞其他監控頁面。
- 若輸入封鎖會與既有 abort/stop 流程衝突，需先定義 degraded 狀態下哪些控制仍可用。

## Critical Files

- `packages/app/src/context/global-sdk.tsx`
- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/pages/session/monitor-helper.ts`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/pages/error.tsx`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/session/monitor.ts`

## Desired Runtime Contract

### 1. Connection State Machine

- States: `connected` / `reconnecting` / `degraded` / `resyncing` / `blocked`
- `connected` only after authoritative stream or snapshot revalidation succeeds.
- `reconnecting` is transient transport recovery, not proof of current runtime state.
- `degraded` means UI may be stale; running/footer state must be visually downgraded.

### 2. Authority Rules

- `active-child footer` is not authority by itself.
- After connection loss, existing footer becomes provisional/stale.
- After recovery, frontend must revalidate authoritative state before restoring footer.
- If server reports no active child, footer and counters must be cleared immediately.

### 3. Counter Rules

- Current `elapsed` display must distinguish:
  - true running duration
  - time since last update / stale-since
- On reconnect / reload / resume, local counter must stop and be recomputed from server truth.
- Local counter cannot continue indefinitely across transport loss.

### 4. Input Safety Rules

- In `reconnecting` / `degraded` / `blocked`, prompt input must be disabled.
- Stop/abort controls may remain available if they map to authoritative backend endpoints.
- UI must explain that prompt input is blocked until status revalidation completes.

### 5. Recovery Flow

1. detect transport degradation
2. mark UI as degraded/reconnecting
3. freeze local stale-sensitive counters
4. fetch authoritative snapshot(s)
5. reconcile session status / active child / latest message/tool state
6. clear stale footer if no authority confirms it
7. re-enable input only after rehydrate success

## Validation Plan

- Simulate event-stream interruption while a subagent footer is visible; verify UI marks stale/degraded rather than continuing fake running.
- Restore connectivity; verify footer either rehydrates from server or disappears if no active child exists.
- Verify elapsed counter resets/recomputes from authority after reconnect.
- Verify prompt input is blocked during degraded/reconnecting and restored after successful rehydrate.
- Verify reload during stale footer does not preserve phantom running state.

## Handoff

- Do not enter build mode until user explicitly instructs execution.
- Build agent must treat this spec as authority for frontend stale-state behavior and reconnect revalidation.
