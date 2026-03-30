# Event: Codex rate-limit RCA

Date: 2026-03-30
Status: Done

## 1. 需求

- 深入了解目前 Codex provider 為什麼這麼頻繁遇到 rate limit。
- 只做 RCA / evidence gathering，不在本輪直接修改 runtime。

## 2. 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/plugin/codex.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/plugin/codex-websocket.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/codex-compaction.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/account/quota/openai.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/account/rate-limit-judge.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts`
- `/home/pkcs12/projects/opencode/specs/codex/websocket/`

### OUT

- 不修改 provider / websocket / quota runtime
- 不調整 rotation3d 或 fallback policy
- 不做修補實作，只記錄根因與後續建議

## 3. 任務清單

- [x] 讀取 architecture 與既有 quota / websocket 文件
- [x] 盤點 Codex HTTP / WS / compact / usage endpoints 與 auth surface
- [x] 追查 rate-limit / usage-limit / connection-limit 的分類點
- [x] 檢查是否有 client-side amplification（WS fallback、retry、connection churn）
- [x] 收斂根因與後續建議

## 4. Conversation Highlights

- 使用者先確認 Codex provider 目前 request 打到哪個 OpenAI 端點。
- 進一步要求深入分析為什麼目前如此頻繁遇到 rate limit。
- 本輪聚焦於 endpoint / transport / quota / retry 行為，不直接改碼。

## 5. Debug Checkpoints

### Baseline

- Codex provider 主請求走 `chatgpt.com/backend-api/codex/*`，不是公開 `api.openai.com/v1/*`。
- repo 已明確建模 Codex 5h / 7d 配額窗口，代表 rate limit 不一定是 client bug，也可能是帳號真的耗盡。
- WebSocket transport 已升格為正式 spec，但實際 runtime 仍有 WS-first + HTTP fallback 路徑，需要檢查是否重送同一 logical turn。

### Instrumentation Plan

- 檢查 `codex.ts` 的 endpoint rewrite、HTTP auth、WS fallback 入口。
- 檢查 `codex-websocket.ts` 的 WS headers、response.create send、first-frame timeout、retry / reconnect policy。
- 檢查 `openai.ts` 與 `rate-limit-judge.ts`，確認 quota 資料來源與 backoff 邏輯。
- 檢查 `session/processor.ts`，確認 runtime 是否已知高頻 retry 會觸發 server-side abuse detection。

### Execution

- 確認 HTTP endpoint 為 `https://chatgpt.com/backend-api/codex/responses`，compaction endpoint 為 `/responses/compact`，quota endpoint 為 `/backend-api/wham/usage`。
- 確認 WS endpoint 為 `wss://chatgpt.com/backend-api/codex/responses`，且使用 `Authorization`、`chatgpt-account-id`、`originator`、`OpenAI-Beta` headers。
- 確認 `usage_limit_reached` / quota wording 會進入 `QUOTA_EXHAUSTED` 判定，並根據 live quota 決定 5h / 7d backoff。
- 確認 WS transport 會先 `ws.send({type:"response.create", ...})` 發出真實上游 request，若 10 秒內沒收到 first frame，則本地將 WS 標記失敗並 fallback 到 HTTP，造成同一 logical turn 可能被送兩次。
- 確認每個 session 預設都可能走 WS-first；WS path 允許 connect retry，account change 時也會強制 reconnect，代表大量短生命週期 session / subagent 可能額外消耗 WS connection budget。
- 確認 `session/processor.ts` 已明寫需要限制 fallback / error spirals，避免高頻 retry 觸發 server-side abuse detection / IP bans。

### Root Cause

高信心根因是「真實帳號 quota + client-side amplification」的組合，而不是單一 bug：

1. **真實 Codex 帳號額度耗盡**
   - repo 明確把 Codex / OpenAI 視為有 5h + weekly（或 free plan weekly-only）窗口。
   - `usage_limit_reached` 會被當成真 quota exhaustion 處理，而不是單純暫時性網路錯誤。

2. **WS-first + first-frame timeout + HTTP fallback 可能重送同一回合**
   - WS 路徑在 timeout 前已經 `ws.send(...)`。
   - 若 first frame 10 秒內未到，runtime 本地放棄 WS 並立即改走 HTTP。
   - 因此同一個 user turn 可能形成兩次上游請求，放大 quota 壓力。

3. **WS connection churn 可能觸發連線上限**
   - 每個 session 都可能先試 WS。
   - connect retry 與 account-change reconnect 會提高連線建立次數。
   - 在大量短生命週期 session / subagent 情境下，較容易撞到 `websocket_connection_limit_reached`。

4. **rotation / fallback 雖有護欄，但在持續耗盡期仍會增加總嘗試數**
   - runtime 有 8 次 fallback / 5 次 consecutive errors 等保護。
   - 它不是無限迴圈 bug，但在配額已緊張時，仍可能進一步放大 aggregate pressure。

### Validation

- `packages/opencode/src/plugin/codex.ts:13`
  - HTTP endpoint = `https://chatgpt.com/backend-api/codex/responses`
- `packages/opencode/src/provider/codex-compaction.ts:26`
  - compact endpoint = `https://chatgpt.com/backend-api/codex/responses/compact`
- `packages/opencode/src/account/quota/openai.ts:26`
  - usage endpoint = `https://chatgpt.com/backend-api/wham/usage`
- `packages/opencode/src/plugin/codex.ts:602-619`
  - HTTP auth uses Bearer token + `ChatGPT-Account-Id`
- `packages/opencode/src/plugin/codex-websocket.ts:104-116`
  - WS auth uses Bearer token + `chatgpt-account-id` + `originator` + `OpenAI-Beta`
- `packages/opencode/src/plugin/codex-websocket.ts:319-322`
  - WS path sends real upstream `response.create`
- `packages/opencode/src/plugin/codex-websocket.ts:336-353`
  - first-frame timeout disables WS and returns `null`
- `packages/opencode/src/plugin/codex.ts:773-796`
  - caller falls back to HTTP when WS returns `null`
- `packages/opencode/src/account/rate-limit-judge.ts:547-561`
  - live quota decides 7d / 5h backoff for Codex/OpenAI
- `packages/opencode/src/account/quota/openai.ts:120-145`
  - quota model explicitly normalizes paid and weekly-only windows
- `packages/opencode/src/session/processor.ts:214-226`
  - runtime explicitly guards against retry spirals that could trigger abuse detection / IP bans

Architecture Sync: Verified (No doc changes)
- 本輪只做 RCA，未改變模組邊界、資料流或 runtime contract；因此不更新 `specs/architecture.md`。

## 6. 後續建議

1. 在單一 logical turn 上增加 correlation instrumentation：串起 `session_id`、WS send、first-frame timeout、HTTP fallback，證明是否真的雙送。
2. 統計 WS session creation / reconnect churn，確認 `websocket_connection_limit_reached` 是否與 subagent/session 數量正相關。
3. 若要修補，優先評估：
   - 降低 WS first-frame timeout duplication risk
   - 降低短生命週期 session 的 WS 連線 churn
   - 在 quota 已明確 exhausted 時更早 fail-fast，而不是再走額外 transport / fallback 嘗試
