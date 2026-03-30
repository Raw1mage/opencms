# Event: Codex continuation resume testing

Date: 2026-03-30
Status: Aborted

## 1. 需求

- 依使用者提供的最新增量傳輸測試結果，補做兩個續接穩定性驗證：
  1. daemon restart 後，在同一個 session 繼續對話，確認 continuation 是否能從 disk/同 session 狀態恢復。
  2. 長時間 idle 後再送一輪，確認 WebSocket 連線仍存活且 delta transport 仍然生效。
- 本輪不主動追 compaction 導致的 continuation invalidation；該情境使用者已明確排除。

## 2. 範圍

### IN

- `/home/pkcs12/projects/opencode/webctl.sh`
- `/home/pkcs12/projects/opencode/specs/architecture.md`
- `/home/pkcs12/projects/opencode/specs/codex/websocket/`
- `/home/pkcs12/projects/opencode/docs/events/event_20260330_codex_incremental_delta_rca.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260330_codex_websocket_promotion.md`
- daemon / websocket / continuation 相關 runtime log
- 同一 session 下的續接測試證據

### OUT

- 不修改 continuation runtime 實作
- 不主動觸發 compaction invalidation 測試
- 不做 provider policy / fallback policy 調整

## 3. 任務清單

- [x] 讀 architecture 與既有事件，建立 restart / idle 測試基線
- [x] 讀 architecture 與既有事件，建立 restart / idle 測試基線
- [ ] 驗證 daemon restart 後同 session continuation 是否恢復（中止：背景 subagent 執行過久，未取得可用證據）
- [ ] 驗證長 idle 後 WebSocket / delta 是否維持有效（未開始）
- [x] 整理中止狀態並同步 architecture 結論

## 4. Conversation Highlights

- 使用者已完成兩輪基礎驗證：`Round 1: full-context -> CONTINUATION bound`、`Round 2: delta=true inputItems=3/5 -> continuation 成功續接`。
- 現況觀測顯示 SSE 大小已穩定在 566 bytes，不再持續增長；未見 `CONTINUATION_INVALIDATED`、未見文字洩漏、未見 HTTP fallback。
- 目前最大的成本瓶頸是 provider-bound payload / system prompt 指令體積，而非 input items 數量。
- 本輪原定補做「daemon restart 恢復」與「長 idle 後續接」兩個場景。
- 使用者已手動完成 daemon restart，但背景 testing subagent 執行過久；使用者明確要求放棄本次完整驗證，不再等待該子代理結果。

## 5. Debug Checkpoints

### Baseline

- `event_20260330_codex_incremental_delta_rca.md` 已確認 request-side continuation 存在，但 runtime 先前曾有 stale continuation / timeout invalidation 風險。
- `specs/architecture.md` 已記錄 per-user daemon、discovery-first coordination、120s idle timeout，以及 SSE/WebSocket 為 shared backend transport surface。
- 本輪預期證據包含：
  - daemon restart 後是否出現 `ws continuation restored from disk` 與 `hasPrevResp=true`
  - 若發生 `previous_response_not_found`，是否仍能在同 WS 路徑內成功重試並恢復
  - 長 idle 後是否仍保有 WS 連線與 delta request 行為

### Instrumentation Plan

- 透過既有 web runtime 啟動入口 `./webctl.sh dev-restart` 重啟 daemon/runtime。
- 在同一 session 續送下一輪，收集 daemon / websocket log 與 session 行為。
- 再做一輪長 idle 後續接，收集是否仍為 WS + delta 路徑。
- 只接受具體 log / runtime evidence；若沒有證據，不宣稱已驗證。

### Execution

- 已建立測試基線並建立 event。
- testing subagent 已派出，目標是用 `./webctl.sh dev-restart` 後在同一 session 取回 continuation 恢復證據。
- 使用者回報 daemon restart 已完成，但因背景 subagent 執行過久，明確要求放棄本次完整驗證。
- 因未收斂出可用 log / session 證據，本輪不宣稱 restart 恢復或 idle 持續性已驗證成功。

### Root Cause

- 不適用；本輪未完成 restart / idle 驗證，沒有新的 root cause 結論。

### Validation

- 結論：INCONCLUSIVE。
- 已知外部事實：使用者已完成 daemon restart。
- 缺少的關鍵證據：
  - `ws continuation restored from disk`
  - `hasPrevResp=true`
  - `previous_response_not_found` 後同 WS 重試是否成功
  - 長 idle 後仍走 WS + delta 的 log / session 證據

Architecture Sync: Verified (No doc changes)

- 本輪沒有新增模組邊界、資料流或狀態機結論；`specs/architecture.md` 無需更新。
