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

**Decision**: cache key 改為 sessionID + questions array 的 canonical JSON hash。hash 使用 `crypto.subtle.digest("SHA-1")` 再取 hex（非安全用途，只要穩定即可）；fallback 到小型純 JS FNV-1a 實作以免 SSR / non-secure context 崩潰。canonical JSON 序列化保證 key 順序穩定。

**Why**:
- sessionID 隔離跨 session 的 cache leak
- content hash 確保 AI 重問同題（新 request.id）能命中舊輸入
- 完全不動 Bus event schema、不動 server-side
- SHA-1 相較 FNV 碰撞極低，對 UI state 足夠；沒有安全考量

**Alternative considered**: 用 request.id 直接比對（現況）。Rejected：重問新 id。
**Alternative considered**: server 端保留 stable question fingerprint 當成 id。Rejected：需要改 ask() 簽名、Bus payload、所有 downstream consumer，得不償失。

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
| [packages/opencode/src/tool/question.ts](../../packages/opencode/src/tool/question.ts) | 把 ctx.abort 傳給 Question.ask | 一行 call-site patch |
| [packages/opencode/src/session/prompt-runtime.ts](../../packages/opencode/src/session/prompt-runtime.ts) | AbortController 建立與釋放 | `cancel(reason)` + `abort(reason)` + log |
| [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts) | `SessionPrompt.cancel` wrapper | 增加 reason 轉傳 |
| [packages/opencode/src/server/routes/session.ts](../../packages/opencode/src/server/routes/session.ts) | `/session/:id/abort` → `SessionPrompt.cancel` | 帶入 `"manual-stop"` |
| [packages/opencode/src/session/processor.ts](../../packages/opencode/src/session/processor.ts) | rate-limit fallback rotation 呼叫 abort | 帶入 `"rate-limit-fallback"` |
| [packages/opencode/src/session/monitor.ts](../../packages/opencode/src/session/monitor.ts) | watchdog trigger（若有 cancel 呼叫） | 帶入 `"monitor-watchdog"` |
| [packages/app/src/components/question-dock.tsx](../../packages/app/src/components/question-dock.tsx) | Webapp QuestionDock cache | cache key 改 sessionID + hash |
| [specs/architecture.md](../architecture.md) | 新增「Question abort lifecycle」一段 | SSOT |
| `docs/events/event_2026-04-19_question-abort-fix.md` | 事件紀錄 | 新檔 |

## Out-of-scope Files（明確不動）

- TUI: `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx`（沒 cache 機制，待下個 feature parity PR）
- ACP: `packages/opencode/src/acp/agent.ts`
- Permission: `packages/opencode/src/permission/**`
- LLM provider 層
