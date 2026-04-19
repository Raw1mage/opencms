# Proposal — web connection stale status fix

## Why

- 弱網路、SSE 中斷或 reconnect 期間，web 前端會保留舊的 control-plane 投影，造成假 running / 假 stuck 顯示。
- `subagent footer` 在連線不佳時可能長時間維持舊狀態；reload 後又消失，顯示它不是可靠 authority。
- 前端目前的 elapsed / stale counter 會延續本地累加，但網路恢復後沒有被 authoritative status 正確覆寫。

## Problem Statement

1. UI 將 stale projection 當成真實 runtime state。
2. reconnect / reload 後沒有一致的 authoritative rehydrate contract。
3. 弱網路期間，使用者仍可能繼續輸入，進一步放大錯誤感知。

## Proposed Direction

- 為 web frontend 引入明確的 connection-state contract。
- 將 active-child / running footer / elapsed counter 降級為「需經 authoritative revalidate 的可疑狀態」，而不是本地真相。
- 在 reconnect / reload / foreground resume / online 後，強制重新驗證 session status、active child、latest tool/message state。
- 當 connection 進入 degraded / reconnecting 時，顯示明確提示並阻止進一步輸入，直到 authoritative resync 完成。

## Planning Boundary

- 本 plan 僅產出修復規格與執行任務，不進入 build mode。
- 不重做 SSE 協議。
- 不以 silent fallback 掩蓋 authority 缺失。

## What Changes

- Define a connection-state contract for degraded/reconnecting web runtime states.
- Reclassify active-child footer and elapsed counters as authority-sensitive UI surfaces.
- Require reconnect/reload/resume revalidation before restoring footer and input.

## Capabilities

- Detect degraded transport as a first-class UI state.
- Rehydrate session status and active-child authority after recovery.
- Block unsafe prompt input until runtime authority is restored.

## Impact

- `packages/app/src/context/global-sdk.tsx`
- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/pages/session/monitor-helper.ts`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/components/prompt-input.tsx`
