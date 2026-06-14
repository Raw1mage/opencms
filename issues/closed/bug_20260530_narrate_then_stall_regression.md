# Bug: 「只宣告不動作」(narrate-then-stall) — claude-cli SSE 截斷流靜默結束 turn

- **Date**: 2026-05-30
- **Severity**: High (turn 靜默死掉，破壞可用性 + 信任；fail-silent 違反天條)
- **Component**: `packages/provider-claude/src/sse.ts` `parseAnthropicSSE`
- **Status**: CLOSED — observing soak accepted; first-chunk false-abort and truncation root causes fixed and deployed.
- **Observing since**: 2026-05-30 18:52。**Exit → closed/**: 使用者日常用 claude-cli session(尤其大 prompt-cache)數日無 `stream first-chunk timeout` / 空 turn 復發。**Regress → open**: 若再現且查得新 root cause,退回 `issues/` root(DIAG + DB 查法已備)。

## 症狀（第一手回報）

- 新 session、claude-cli 帳號 → 「只宣告不動作」/「文字宣告後整個 turn 就結束」/「無回應」
- 開不開 thinking 都會發生
- 切換到 codex 也救不了
- 「早上開始出問題」，在 invalid_grant 那批 commit 之前就有

## 決定性證據（session DB 一手紀錄）

故障 session `ses_1890b118affepkRtLL16NJfhbq`，查 `parts` / `messages` 表，整個 session 唯一的空 turn：

| msg | time | finish | tokens_total | parts | part types |
|---|---|---|---|---|---|
| `…8L6dRw` | 11:42:09 | **`<empty>`** | **0** | **1** | **只有 `step-start`** |

- `error_json` 空 → 這個空 turn **沒被當錯誤**，runloop 靜默結束。
- finish 是**空字串**（不是 `"other"`）→ 證明 stream **根本沒走到 `message_stop`**（若到了，`mapFinishReason(undefined)` 會給 `"other"`）。是**截斷的 stream**。
- 之後 11:42:37 起恢復正常 `tool-calls` → 偶發性截斷，非永久壞。

## Root Cause（causal chain，已讀完整 SSE 控制路徑）

`parseAnthropicSSE` 的 reader done-branch（`sse.ts` 舊 69-77 行）在 stream 結束時**無條件** `controller.close()`，完全不檢查是否曾收到 `message_stop`：

```
message_start 到（step-start emit）
 → 連線在 content_block / message_stop 之前斷
 → reader.read() done=true
 → flush remainder + controller.close()
 → 從未 emit finish，也從未 emit error
 → host 收到零 content、finishReason="unknown"、tokens=0 的 stream
 → runloop 無法 advance（prompt.ts:3380 終結判定 unknown 不續跑）→ turn 靜默結束
 → 使用者見「無回應 / 只說不做」
```

Anthropic Messages API SSE 合約：`message_stop` 是**保證必到**的終結事件。沒收到它就 close = 截斷 = 真實錯誤，不該靜默吞掉。

### 為何吻合每條線索

| 線索 | 解釋 |
|---|---|
| 早上開始 | 今早 00:34–03:21 claude-cli SSE/OAuth 改動（`4e246de7d` OAuth host、`e85bb5e55` thinking-signature round-trip、`0ee1f5ceb` thinking-effort、`6cfd9f59a` SSE stop_reason）提高截斷機率 |
| thinking on/off 都中 | SSE 傳輸層問題，與 thinking 無關 |
| 切 codex 救不了 | **結構性**：codex provider 有 `empty-turn-classifier.ts`（6 cause family + retry/nudge）正視空 turn；claude provider **零防護** |
| DB finish 空、tokens 0 | stream 在 message_stop 前斷，host 收到 unknown finish |
| 我先前的 `[DIAG:claude-resp]` 埋點抓不到 | 埋點在 `message_stop` 分支裡，而故障**根本沒到 message_stop**——埋錯位置 |

### 證據等級

- **DB 一手紀錄**（決定性）：`ses_1890b118affe…8L6dRw` 空 turn fingerprint。
- **完整 SSE 程式碼**：parseAnthropicSSE done-branch 無 terminal guard。
- **對照組**：codex 有 empty-turn-classifier，claude 沒有。
- （作廢假設）：稍早一版誤把根因歸到「前端 streaming-gate 隱藏 running tool」，並把修復寫到不存在的 `packages/app/.../ToolCallBlock.tsx`（路徑幻覺）。讀真實前端碼（`packages/ui/message-part.tsx:978` ToolPartDisplay 無條件渲染）後否決；DB 證據進一步證明是後端空 turn，非前端渲染。

## Fix

`packages/provider-claude/src/sse.ts`：

1. 加 `sawMessageStop` 旗標，`message_stop` 分支設為 true。
2. reader done-branch：若 `!sawMessageStop`，emit `{type:"error", error}`（含 production tally + lastStop），再 close。
3. host `provider.ts` 既有 `case "error": throw value.error` 接住 → 觸發 retry/rotation，**fail fast**，符合天條（禁 silent fallback）。

選 emit-error（而非 synthesize 假 finish）的理由：截斷 = 真實傳輸錯誤，應顯式報錯讓 rotation 接手，不可偽造完成。

## Validation

- 新增 `packages/provider-claude/src/sse.test.ts`（claude provider 先前**零 SSE 測試**——正是缺陷溜過的缺口）：
  - well-formed stream → finish=stop、無 error ✅
  - truncated stream（無 message_stop）→ emit error（含 "message_stop"）、無 synthetic finish ✅
  - 完全空 stream → 也 error，不靜默 ✅
  - mapFinishReason 對照 ✅
  - **4/4 pass**
- 待：restart_self 部署 claude provider，重現確認截斷 turn 走 retry 而非空 turn。

## Blast Radius

- 影響所有 claude-cli session 的截斷 stream（偶發網路/上游斷流）。
- 修復僅在 done-branch 加 terminal guard，well-formed stream 行為不變（sawMessageStop=true → 不 emit error），無回歸面。

---

## UPDATE 2026-05-30（晚間）— 真正的高頻主因：first-chunk watchdog 誤殺

上方 SSE 截斷流修復（`ce94aad7c`）是**真實但次要**的缺陷（罕見的上游斷流）。部署後使用者**仍然**反覆遇到「只說不做」，於是用第一手證據重新偵查，找到**高頻主因**——與 SSE 無關。

### 決定性證據（debug.log + journal，本機 daemon）

- `stream first-chunk timeout — aborting` 在我自己的 session `ses_188bb5576ffe` 觸發兩次：17:12 `elapsedMs=60067`、17:55 `elapsedMs=60049` — 精準卡在 60000ms。
- `bus.session.error`: `UpstreamIdleClose{source:first-chunk, isRetryable:true}` → 但 session 落到 `state:waiting_user` / `stopReason:assistant_error`，**未重試**，assistant message 存成全 0 token 空殼 = 「只說不做」。
- 對照鄰居同型 session `ses_1886854b2ffe`：DIAG 顯示健康 turn 的 first-token 延遲達 **178 秒**（16:58 req → 17:01 resp），正常完整回應 → 證明 claude-opus + 大 prompt-cache first-token >60s 是**正常行為**。

### Root Cause（causal chain）

`packages/opencode/src/session/llm.ts` 的 **first-chunk watchdog**（`STREAM_FIRST_CHUNK_TIMEOUT_MS = 60_000`，commit `81e90fb9fb` 2026-05-27）原本是為 **codex** 的 0-byte wedge 止血，但**無條件套用所有 provider**。claude-opus 在 200K+ prompt-cache 脈絡下，server 端「讀快取 + thinking」常 >60s 才吐第一個 token → 60s 門檻把健康 stream 在開口前砍掉 → abort 雖標 `isRetryable:true` 卻落到 `waiting_user` → 空 turn。

| 線索 | 用 watchdog 解釋 |
|---|---|
| 早上開始 | session 的 prompt-cache 養肥到 first-token 穩定破 60s，踩中 3 天前才加的看門狗死線 |
| thinking on/off 都中 | 是 stream-start 計時，與 thinking 內容無關 |
| 切 codex 救不了 | 壞的是**通用** watchdog，不是 claude provider streaming |
| 我先前 `[DIAG:claude-resp]` 抓不到 | 該埋點在 `message_stop`，而誤殺發生在**第一個 chunk 都還沒到** |

### Fix（commit `fb11a58a2`）

first-chunk watchdog 改 family-gated：`const FIRST_CHUNK_WATCHDOG_FAMILIES = new Set(["codex"])`，僅 codex 武裝此計時器。90s chunk-idle watchdog 維持通用（每 chunk re-arm，只抓 mid-stream wedge，claude 穩定 streaming 不誤觸）。

未改 60s 常數（對 codex 仍合理）、未改 `isRetryable→retry` 消費鏈（獨立次缺陷，留待後續評估）。

### Validation（已部署 + 行為驗證）

- restart_self 部署：binary build 18:28、`FIRST_CHUNK_WATCHDOG_FAMILIES` 在 binary 內、daemon pid 2887853 跑新碼。
- **行為層**：部署後 24 分鐘內 15 次真實 claude 請求，`first-chunk timeout` = **0 筆**（debug.log + journal 雙確認）；`DIAG:claude-resp` 全 `ok mapped=tool-calls`。
- 對照鐵證：部署前同一 session 17:12/17:55 被砍兩次；部署後零誤殺。

### 留痕

- Plan: `plans/stream-watchdog_claude-first-chunk-false-abort/`（刻意停 `proposed`，DD-4 記錄不為過 gate 偽造 IDEF0/GRAFCET）。
- 兩個缺陷都修了：主因（watchdog）+ 次因（SSE 截斷）。本 issue 可在使用者日常驗證一段時間無復發後移 `closed/`。
