# Event: Webapp CPU spike crash + 思考鏈卡慢 (fetch wrapper / Bus event storm / reactive console.log)

Date: 2026-03-14
Status: Fixed
Branch: cms
Workspace: /home/pkcs12/projects/opencode

## Symptom

- Webapp 在 subagent 工作時崩潰，bun process 飆到 100% CPU 後死亡
- 前端出現大量 504/502 錯誤
- 前端 `resolveScopedSelection` 在 console 無限刷出
- VIRT 77G（虛擬地址空間膨脹），RSS ~600MB
- 反向代理 (crm.sob.com.tw) 回傳 504 Gateway Timeout
- Subagent 每次 server restart 短暫恢復後又卡住
- **LLM 思考鏈極度卡慢**：GPT 5.4 Medium thinking 簡單讀檔任務需 5-11 分鐘，最後只吐出簡短結論。idle CPU 持續 38%+，即使沒有 active subagent

## Trigger

送指令讓 agent 工作（GPT 5.4 Medium thinking），subagent 啟動後 server 逐漸不可達。

## Impact Timeline

1. **Phase 1 — 崩潰 (Bug 1 + Bug 3)**：subagent 啟動 → fetch wrapper per-request overhead + 前端 reactive cascade → server 100% CPU → 死亡 → 504/502
2. **Phase 2 — 修復崩潰但仍卡慢**：移除 fetch wrapper + console.log 後 server 不再死亡，但 idle CPU 仍 38%，思考鏈仍需 5-11 分鐘
3. **Phase 3 — 定位 Bus event storm (Bug 2)**：`pinExecutionIdentity` 5×/loop 無條件 publish → Storage I/O + SSE + snapshot scan 飽和 event loop → LLM stream 延遲
4. **Phase 4 — 修復 Bus storm 後 idle CPU <11%**，思考鏈恢復正常
5. **Phase 5 — 發現靜默 retry loop (Bug 4)**：session identity 阻止跨 provider rotation + 所有同 provider accounts rate limited → circuit breaker 只 log 不 break → 無限 retry → CPU 72% + 前端無任何 error toast

## Root Cause

四個獨立 bug，均由 commit `a17ee24602` (fix(web): make MCP session open switch sessions via loopback control) 及同期 session identity 系列 commits (`327c53e4d7`, `d089d94731`) 引入：

### Bug 1: server.ts — fetch wrapper causes event loop blocking (致命)

```typescript
// BEFORE (broken):
const appFetch = App().fetch
// ...
fetch(request: Request, server: Bun.Server<any>) {
  const headers = new Headers(request.headers)
  headers.delete("x-opencode-loopback")
  const remote = server.requestIP(request)
  const address = remote?.address?.trim().toLowerCase()
  if (address === "127.0.0.1" || address === "::1") {
    headers.set("x-opencode-loopback", "1")
  }
  return appFetch(new Request(request, { headers }))
}
```

在 Bun.serve 的 fetch handler 中包裝了 loopback 檢測邏輯：
- `new Request(request, { headers })` 斷開與原始 TCP socket 的關聯
- 即使改為 `request.headers.set()` 直接修改（第一輪修復），`server.requestIP()` + headers 操作 per-request 的開銷在高並發下仍導致 event loop 阻塞
- Health endpoint 從 2ms 退化到 1.5s → 反向代理 timeout → 504
- 最終 bun process 100% CPU → 死亡

**第一輪修復**（不夠）：移除 `new Request()` clone，改為直接修改 `request.headers`。CPU 從 100% 降到 90%，health latency 1.5s，仍會 504。

**最終修復**：完全移除 fetch wrapper，恢復 `fetch: App().fetch`。Loopback 檢測移到 `web-auth.ts` 的 `isTrustedLoopbackRequest()` 中按需執行（只在 auth 路徑觸發，不影響每個請求）。

```typescript
// AFTER (fixed) — server.ts:
fetch: App().fetch   // no wrapper, zero overhead

// AFTER (fixed) — web-auth.ts isTrustedLoopbackRequest:
// 不再依賴 x-opencode-loopback header injection
// 直接檢查 URL hostname + 無 proxy headers
```

### Bug 2: pinExecutionIdentity Bus event storm (致命 — 思考鏈卡慢根因)

```typescript
// BEFORE (broken):
export async function pinExecutionIdentity(input: { ... }) {
  return update(input.sessionID, (draft) => {
    draft.execution = nextExecutionIdentity({ current: draft.execution, model: input.model })
  }, { touch: false })
}
```

`pinExecutionIdentity` 在 processor.ts 的 `while(true)` loop 中被呼叫 5 次（line 237, 320, 365, 876, 980）。每次呼叫都經由 `Session.update()` 發布 `Bus.publish(Event.Updated)`，即使 identity 完全沒有變化。

這導致：
- 每個 LLM 請求循環產生 5 個 `session.updated` Bus 事件
- 每個事件通過 SSE 推送到前端
- 前端 `use-status-monitor.ts` 監聽 `session.updated` → 觸發 `requestRefresh()` → 呼叫 `/api/v2/session/top` → 執行 `SessionMonitor.snapshot()` 掃描所有 messages
- Storage write (每次 update 都寫入磁碟) 加劇 event loop 負載
- 最終表現：event loop 飽和，LLM stream token 處理延遲，思考鏈從秒級退化到 5-11 分鐘

**修復**：在 `pinExecutionIdentity` 中先讀取當前 session，比較 identity 是否相同，相同則直接 return，跳過 update 和 Bus 事件。

```typescript
// AFTER (fixed):
export async function pinExecutionIdentity(input: { ... }) {
  const current = await get(input.sessionID)
  if (current && sameExecutionIdentity(current.execution, input.model)) {
    return current  // no update, no Bus event
  }
  return update(...)
}
```

### Bug 3: local.tsx — console.log in SolidJS reactive context (前端)

```typescript
// BEFORE (broken):
const resolveScopedSelection = (sessionID?: string) => {
  const a = agent.current()
  if (!a) return undefined
  if (sessionID) {
    const m1 = ephemeral.model[buildModelScopeKey(a.name, sessionID)]
    console.log(`[local.model] resolveScopedSelection(${sessionID}): a.name=${a.name}, m1=`, m1)
    // ...
    console.log(`[local.model] resolveScopedSelection(${sessionID}) result:`, res)
    return res
  }
}
```

在 SolidJS reactive context 中用 `console.log` 列印 Proxy 物件：
- `console.log` 存取 Proxy 的所有屬性 → 建立新的 reactive subscriptions
- 每次 subscription 觸發 → 重新計算 → 再次 `console.log` → 無限 cascade
- 前端 CPU 飆高，SSE 瘋狂重連，進一步加劇 server 負載

**修復**：移除 debug console.log，直接 return。

### Bug 4: processor.ts — circuit breaker 只 log 不 break（靜默 infinite retry）

Processor 的 `while(true)` loop 中有三層 circuit breaker，但第 2、3 層**只 log 不 break**：

| Circuit Breaker | 設計意圖 | Bug |
|---|---|---|
| `MAX_CONSECUTIVE_ERRORS` (5) | 連續失敗就停 | ✅ 有 break |
| `MAX_FALLBACK_ATTEMPTS` (8) | fallback 太多次就停 | ❌ 只 log，fall through 到 `SessionRetry.retryable()` → `continue` |
| `MAX_CONSECUTIVE_NULL_FALLBACKS` (2) | 帳號耗盡就停 | ❌ 只 log，fall through 到 `SessionRetry.retryable()` → `continue` |

rate limit error → `isModelTemporaryError` → 找不到 fallback（session identity 阻止跨 provider） → circuit breaker 觸發但不 break → fall through → `SessionRetry.retryable()` 回傳 truthy → `continue` → 永遠不會到達 `Bus.publish(Error)` → **前端永遠收不到 error toast**。

每次重試都呼叫 `findFallback3D()` 掃描 153 個 candidates → 瘋狂讀 `rotation-state.json` → idle CPU 72% → 思考鏈卡慢。

**修復**：三個 circuit breaker 觸發後都加上 `Bus.publish(Error)` + `SessionStatus.set("idle")` + `break`，確保 error 被 surface 到前端且 loop 停止。

## Files Changed

| File | Change |
|------|--------|
| `packages/opencode/src/server/server.ts` | 完全移除 fetch wrapper，恢復 `fetch: App().fetch` |
| `packages/opencode/src/server/web-auth.ts` | `isTrustedLoopbackRequest` 不再依賴 injected header，改為純 URL hostname + proxy header 檢查 |
| `packages/app/src/context/local.tsx` | 移除 `resolveScopedSelection` 中的 `console.log` |
| `packages/opencode/src/session/index.ts` | `pinExecutionIdentity` 增加 identity 比較，unchanged 時跳過 update/Bus 事件 |
| `packages/opencode/src/session/processor.ts` | 三個 circuit breaker 都加上 error surfacing + `break`，防止靜默 infinite retry |

## Lessons Learned

1. **不要在 Bun.serve fetch handler 包任何 per-request wrapper** — `new Request()` 會斷開 socket affinity；即使只做 `server.requestIP()` + headers 操作，在高並發下也會阻塞 event loop。Loopback/auth 邏輯應在 middleware 層按需執行。
2. **永遠不要在 SolidJS reactive context 中 console.log Proxy 物件** — 會觸發 property access → 建立 subscriptions → 無限 reactive cascade。如需 debug，用 `untrack(() => console.log(...))` 或在 reactive context 外部打 log。
3. **Bun VIRT 高不代表 OOM** — 77G VIRT 但 RSS 600MB 是正常的。Bun 使用大量 mmap，VIRT 不反映實際記憶體壓力。判斷記憶體問題要看 RSS。
4. **CPU 100% + server alive (health OK) ≠ server working** — 如果 event loop 被阻塞，health endpoint 可能偶爾回應但所有業務請求都 timeout。監控應結合 CPU% 和 request latency。
5. **idempotent guard 對 hot-path 函數至關重要** — `pinExecutionIdentity` 被呼叫 5×/loop，每次無條件觸發 Storage write + Bus publish + SSE push + 前端 snapshot scan。加上 `sameExecutionIdentity` 比較後，99% 的呼叫直接 return，idle CPU 從 38% 降到 <11%。
6. **Bus event cascade 是隱形殺手** — 後端發一個 `session.updated` → SSE → 前端 debounce timer reset → snapshot scan。高頻事件讓 debounce 失效（timer 不斷被 clear/reset），最終前端和後端都飽和。
7. **Circuit breaker 必須 break** — 只 log 不 break 的 circuit breaker 是假安全感。在 `while(true)` loop 中，任何 `continue` 路徑都必須確認所有 circuit breaker 已經被正確處理。Fall through 到 retry 邏輯的 comment 是危險的 — 因為 retry 邏輯本身也是 `continue`。
8. **靜默失敗比崩潰更危險** — 用戶無法從 UI 得知系統在做無意義的 retry。所有 circuit breaker 觸發時都必須 surface error 到前端（`Bus.publish(Error)` + toast notification），而非僅寫 server log。
