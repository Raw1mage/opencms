# Bug: claude-cli 上游 stall 被「靜默等 240s + 誤導訊息 stream idle timeout」蓋掉;wire 不可見、429/SSE-error 可能漏接

- **Date**: 2026-06-01
- **Severity**: High(使用者一句話就卡 240s,且錯誤訊息「stream idle timeout」誤導——可能真因是限流/過載/帳號/上游異常,卻全被一個計時器訊息蓋掉。debug.log 不記 wire,無法診斷)
- **Component**:
  - LLM stream watchdog（`packages/opencode/src/session/llm.ts` 的 `UpstreamIdleClose` / `streamIdleTimeoutMs`,claude=240s）
  - claude provider 錯誤接收（`packages/provider-claude/src/provider.ts:276` HTTP 狀態檢查；`sse.ts:350` `case "error"`）
  - 診斷可觀測性（debug.log 不記 upstream HTTP 狀態/回應）
- **Status**: CLOSED — covered by provider-aware idle watchdog fix `0658e7e15` and follow-up wire diagnostics

---

## 1. 症狀
claude-cli session 送一則訊息後:
- 畫面紅字 `stream idle timeout after 240000ms`。
- 上游從 `LLM.stream started` 起 **240 秒一個 token 都沒回**,watchdog abort(`UpstreamIdleClose`,`isRetryable:true`)。
- **跨帳號重現**（訂閱到期帳號 + 換新帳號都發生）。

## 2. 證據（2026-06-01,ses_18d7f02eeffeppnzk3alvUWtlS）
```
02:21:09.392  LLM.stream started（auth 載入、packet prepared 都成功）
   ↓ 240s 無任何 chunk / 無 error / 無 429
02:25:33      WARN stream idle timeout — aborting  UpstreamIdleClose elapsedMs:240000
```
- 中間 log 只有 SQLite 連線池(內部),**無上游活動**。
- `msgsLen:13`、prompt 約 100K——**不是巨大 context**。
- 02:42:58 換帳號後同 pattern 再現。

## 3. 已排除的錯誤假設（誠實留痕,避免重蹈）
- ❌ **「100K 冷 prefill 太慢」**：100K prefill 該秒~數十秒,不該 240s。證偽。
- ❌ **「rate-limit(log 有 429/529)」**:那些是 **substring 誤判**——「429」是時間戳毫秒 `.429`,「RATE_LIMIT」是 config key。**debug.log 內無真 rate-limit 訊號**。
- ❓ **「畸形結構導致」**：convert.ts 確有 sanitize gap（見 `bug_20260601_claude_convert_orphan_tooluse_consecutive_assistant.md`），但畸形通常 → **400(會被 surface)**,非 hang。400-vs-hang 對不上,**未證實**。

## 4. 確定的事實
- code **有**接乾淨 HTTP 錯誤(provider.ts:276 `if(!response.ok) throw`)與 **SSE error event**(sse.ts:350 `case "error"`)。
- 但兩者**都沒觸發** → 上游**既非乾淨 4xx/5xx、也沒送 SSE error event**,而是 **200 收了連線、然後靜默**(accept-then-hang)。
- watchdog 是最後兜底,**砍對了**(真有 stream 卡住),但**訊息誤導**(讓使用者以為是 idle/網路,而非可能的上游/帳號問題)。

## 5. 兩個獨立的修法

### 5A. 可觀測性(blocker,要先做)：抓 wire
debug.log 不記 HTTP 來回 → 無法判斷上游到底回什麼。
- 用 aisecurity sidecar（127.0.0.1:7731）`--debug-capture` 抓一次 claude-cli ↔ Anthropic 實際交換。
- 或在 provider/llm 層加一條 **request/response 狀態 + 首 byte 計時** 的 debug log（記 HTTP status、有沒有 SSE event、到首 chunk 多久)。
- **這是定案 root cause 的前提**——在此之前不要再猜。

### 5B. 錯誤訊息誠實化 + 更快 surface（無論 root cause 為何都該做）
- watchdog timeout 的訊息別只說「stream idle」。改成誠實列出可能因:「上游 240s 無回應——可能限流/過載/帳號/上游異常,非本地問題」。
- 考慮對 claude-cli **首 chunk 計時**(time-to-first-token)單獨設一個較短的 gate + 明確訊息,跟「mid-stream idle」分開(現在混在一個 240s)。
- `isRetryable:true` → 確認 retry/rotation 是否真的接手了(本次顯示 error 給使用者 = 可能沒接手,或接手前先顯示)。

## 6. Related
- watchdog 起源:本 plan 開場修過 `90s→240s false-abort`(commit 0658e7e15)。240s 對「真卡住」是對的,問題在**訊息**與**診斷盲區**。
- `bug_20260601_claude_session_poisoned_by_failed_turn.md`（每次 timeout 後 session 被污染,可能讓同一 session 反覆撞 stall）。
