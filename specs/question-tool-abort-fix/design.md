# Design: question-tool-abort-fix

## Context

Question tool 的 pending 生命週期在 2026-04-19 前並未與 stream AbortController 綁定。bug 鏈如下：

1. LLM 呼叫 `question` tool → `tool.execute` 進入 `await Question.ask(...)`，pending 加進 `Instance.state` map
2. stream 在 question pending 時因某原因 abort（最可能是 rate-limit fallback rotation @ [processor.ts:1639-1718](../../packages/opencode/src/session/processor.ts#L1639-L1718)）
3. processor cleanup @ [processor.ts:1769-1785](../../packages/opencode/src/session/processor.ts#L1769-L1785) 把 tool part state 改成 `"error: Tool execution aborted"`
4. pending `Question` promise 因沒掛 AbortSignal，繼續等 reply
5. 使用者看到紅框但 dialog 還在 → 繼續打字 → Submit → `Question.reply` 成功 resolve 舊 promise
6. 但此時 AI SDK stream 已 tear down，resolve 回的 answers 沒有 consumer
7. processor 重跑 / LLM 重看歷史 → 看到 aborted tool part → **重新呼叫 question tool**（新 request.id）
8. QuestionDock 新 mount，cache key 基於 request.id 找不到對應 → 使用者輸入沒回填
9. 使用者感受：認真答 → abort → 再答一次 → 再 abort → ...

## Goals / Non-Goals

### Goals

- 消滅 pending-question 與 stream 生命週期之間的孤兒態
- 讓使用者的手打內容在「AI 重問同題」的情境下自動回填
- 為 stream abort 加 reason telemetry，以便之後追查類似故障

### Non-Goals

- **不解決** rate-limit rotation 是否應在 pending question 期間觸發（屬於另一個產品決策，靠 telemetry 證據再談）
- **不擴充** localStorage 跨 tab 持久化
- **不補** TUI question.tsx 的 cache feature parity
- **不改動** permission 系統（同類 bug 但範圍另算）
- **不升級** Bus event schema（保持 `question.rejected` 相容）

## Decisions

### DD-1 — Question.ask 接受可選 AbortSignal，reuse RejectedError

**Decision**: `Question.ask` 新增可選 `abort?: AbortSignal` 參數。signal 觸發時執行「delete pending + publish `question.rejected` + reject promise with `RejectedError`」三個動作。若 signal 已 aborted（pre-aborted），同步執行這三個動作且**不** publish `question.asked`。

**Why**:
- AbortSignal 是 JS/AI SDK 生態的標準抽象，processor 本來就有 `input.abort`，tool ctx 也有 `ctx.abort`，零新概念
- reuse `RejectedError` 可避免碰到 [processor.ts:961](../../packages/opencode/src/session/processor.ts#L961) 的 `blocked = shouldBreak` 判斷——沿用現有「blocked 狀態」語意，UI 顯示 stopReason = `permission_or_question_gate` 也符合實情
- pre-aborted 不 publish `question.asked` 避免 ghost dialog 閃一下

**Alternative considered**: 新增 `AbortedError` 獨立型別 + 新增 `question.aborted` 事件。Rejected：需要改 TUI / webapp / ACP 三個 consumer，收益只是語意更細；目前沒有 use case 必須區分 aborted vs rejected。

### DD-2 — QuestionDock cache key = `${sessionID}:${hashCanonical(questions)}`

**Decision (v2, 2026-04-19, AMENDED during Phase 3)**: cache key = sessionID + FNV-1a 32-bit hash (8-char hex) of canonical JSON of questions array. canonical JSON = recursive key-sorted serializer. No SubtleCrypto.

~~**Decision (v1, SUPERSEDED by v2)**: SHA-1 via `crypto.subtle.digest` with FNV-1a fallback for SSR / non-secure contexts.~~

**Why (v2)**:
- sessionID prefix isolates cross-session cache leak
- content hash lets AI re-ask of identical question (new `request.id`) hit the previous input
- No server-side / Bus event / SDK type changes
- FNV-1a is synchronous → usable inside SolidJS `createStore(initial)` without races. Async SHA-1 would need "mount with empty state, then `setStore` after digest resolves" — but user typing in the tens-of-ms window between mount and resolve would be overwritten by the cache restore, a regression worse than the original bug
- FNV-1a 32-bit collision probability <10⁻⁸ for <100 distinct questions per session; sessionID prefix drives cross-session collision to near zero
- Cache key is never exposed and never participates in auth — no security concern

**Alternative considered (v1)**: SubtleCrypto SHA-1. Rejected per the race argument above.
**Alternative considered**: use `request.id` directly (status quo before this spec). Rejected: re-ask produces new id.
**Alternative considered**: server-side stable question fingerprint as id. Rejected: requires breaking change to `ask()` signature, Bus payload, and all downstream consumers.

### DD-3 — prompt-runtime.cancel 需要 reason: CancelReason（TypeScript enum-like union）

**Decision**: `cancel(sessionID: string, reason: CancelReason)` 必填 reason；`controller.abort(reason)` 把 reason 轉給 AbortController；log 紀錄 reason 與 `new Error().stack` 首格（去除 framework wrapper）。

enum（union type）:

```ts
export type CancelReason =
  | "manual-stop"           // 使用者按 Stop
  | "rate-limit-fallback"   // processor rotation
  | "monitor-watchdog"      // session monitor / proc-scan watchdog
  | "instance-dispose"      // Instance cleanup (daemon restart / user switch)
  | "replace"               // prompt-runtime.start({ replace: true })
  | "session-switch"        // 使用者切到別 session 而當前 busy
  | "unknown"               // migration 預設值 / 未來新 caller 未補
```

**Why**:
- TypeScript 編譯期把所有 caller 逼到 switch exhaustiveness
- AbortSignal.reason 原生支援任意 value，reason string 可被 downstream（Question.ask handler）直接讀取 → DD-1 的 log reason 正是這個值
- enum 有限集合便於 log grep

**Alternative considered**: 用 free-form string。Rejected：容易變成 snake_case / kebab-case 混雜，log grep 不穩。
**Alternative considered**: 只改 log，不改 signature。Rejected：AbortSignal.reason 這條通道更精確（可傳到 Question.ask 內），單靠 log 無法做到。

### DD-4 — log caller stack top，不使用 Error.captureStackTrace

**Decision**: log 記錄 `new Error().stack?.split("\n")[2]?.trim()` 作為 caller 標記（第 0 行是 "Error"、第 1 行是 cancel 本身、第 2 行才是 caller）。不 perform 完整 stack sanitization。

**Why**:
- 目的只是讓我們知道 abort 在哪被呼叫，不是做 post-mortem
- 效能成本可忽略（cancel 不是 hot path）
- V8 stack format 穩定，第 2 行通常就是 caller

**Risk**: bundler minify 後 function name 消失 → log 拿到的是 mangled name。
**Mitigation**: opencode 非瀏覽器執行環境，是 bun runtime，一般保留原始檔案名 + 行號。Webapp 部分不觸發這段。

### DD-5 — sessionIdentity 用 snake_case canonical serializer

**Decision**: content hash 用的 canonical JSON 走 `JSON.stringify(questions, keys.sort())` 固定欄位順序；不依賴 object insertion order。

**Why**: Solid store 與 Bus event 序列化可能在不同處產生不同 key order，stable hash 必須主動排序。

## Risks / Trade-offs

| Risk | 影響 | Mitigation |
|---|---|---|
| `question.rejected` 被多呼叫一次（stream abort + 人為 reject race） | Bus consumer 重複收到 → 多餘 UI 動畫 | pending map 是單一真相，`delete` 之後再判斷 existing，已在 DD-1 覆蓋 |
| 所有 cancel caller 補 reason 可能遺漏 | TypeScript 強制編譯錯 | 必填參數；無 default |
| Question tool 目前沒有測試 suite | 新行為沒回歸保障 | tasks.md 強制加 unit test |
| cache hash 在極端情況碰撞 | 兩個不同的 question 共用 cache | SHA-1 對 ≤10 個 question 碰撞機率 <2⁻⁶⁰，可接受；加 sessionID prefix 進一步降低 |
| abort handler 的 reject 行為可能影響 orchestrator subagent 等待 | `Question.RejectedError` 既有處理路徑（blocked=shouldBreak）本就 cover | 沿用既有 instanceof 判斷 |

## Critical Files

| 檔案 | 角色 | 本次變動 |
|---|---|---|
| [packages/opencode/src/question/index.ts](../../packages/opencode/src/question/index.ts) | Question state machine | `ask()` 新增 abort 參數，處理 abort handler |
| [packages/opencode/src/question/index.test.ts](../../packages/opencode/src/question/index.test.ts) | Phase 1 unit tests | 6 test cases covering TV1/TV2/TV3 + idempotency |
| [packages/opencode/src/tool/question.ts](../../packages/opencode/src/tool/question.ts) | 把 ctx.abort 傳給 Question.ask | 一行 call-site patch |
| [packages/opencode/src/session/prompt-runtime.ts](../../packages/opencode/src/session/prompt-runtime.ts) | AbortController 建立與釋放 | `CancelReason` union + `cancel(reason)` + `abort(reason)` + log |
| [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts) | `SessionPrompt.cancel` wrapper | 增加 reason 轉傳；stopReason 保留 `manual_interrupt` |
| [packages/opencode/src/server/routes/session.ts](../../packages/opencode/src/server/routes/session.ts) | `/session/:id/abort` + `/session/abort-all` | 帶入 `"manual-stop"` |
| [packages/opencode/src/cli/cmd/session.ts](../../packages/opencode/src/cli/cmd/session.ts) | SIGTERM/SIGINT cleanup + worker cancel msg | 帶入 `"manual-stop"`（survey 補進） |
| [packages/opencode/src/tool/task.ts](../../packages/opencode/src/tool/task.ts) | subagent parent-abort cascade (2 sites) | 帶入 `"parent-abort"`（survey 補進；同步追加 enum 值） |
| [packages/opencode/src/server/killswitch/service.ts](../../packages/opencode/src/server/killswitch/service.ts) | emergency cancel / pause / forceKill | 帶入 `"killswitch"`（survey 補進） |
| ~~[packages/opencode/src/session/processor.ts](../../packages/opencode/src/session/processor.ts)~~ | rate-limit fallback rotation | **不需改**：processor rotation 用 `continue` 不呼叫 cancel（tasks.md 2.6.3 已標 cancelled） |
| ~~[packages/opencode/src/session/monitor.ts](../../packages/opencode/src/session/monitor.ts)~~ | session monitor | **不需改**：monitor 今日未呼叫 cancel（tasks.md 2.6.6 已標 cancelled） |
| [packages/app/src/components/question-dock.tsx](../../packages/app/src/components/question-dock.tsx) | Webapp QuestionDock | cache key 改 sessionID + hash |
| [packages/app/src/components/question-cache-key.ts](../../packages/app/src/components/question-cache-key.ts) | canonicalJson + fnv1a32 + questionCacheKey | 新檔（Phase 3 抽出） |
| [packages/app/src/components/question-cache-key.test.ts](../../packages/app/src/components/question-cache-key.test.ts) | Phase 3 unit tests | 13 test cases covering TV4/TV5/TV6 + serializer + hash |
| [specs/architecture.md](../architecture.md) | 新增「Question Tool Abort Lifecycle」段 | SSOT (Phase 4 已落地) |
| [docs/events/event_2026-04-19_question-abort-fix.md](../../docs/events/event_2026-04-19_question-abort-fix.md) | 事件紀錄 | 新檔（Phase 1/2/3 summary） |

## Out-of-scope Files（明確不動）

- TUI: `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx`（沒 cache 機制，待下個 feature parity PR）
- ACP: `packages/opencode/src/acp/agent.ts`
- Permission: `packages/opencode/src/permission/**`
- LLM provider 層
