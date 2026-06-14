# BR: subagent finish=content-filter 被回報為 status=success（靜默任務丟失）

- **日期**：2026-06-11
- **嚴重度**：High（orchestrator 被誤導，任務靜默丟失，無任何 anomaly 訊號）
- **來源 session**：parent `ses_14ceb2fceffehTP6rE3wuUb65y`（bodesign repo，component vault ingestion 任務）
- **狀態**：OBSERVING — Bug 1 已修（`3e2263bec`，新增 `content_filter` status）· Bug 3 已修（`b35a22a22`）· Bug 2 拆出至 `issue_20260611_dispatch-first-contract-break.md` 並已修（`ce2c7ce92`）。全部修復已隨 2026-06-11 3R 部署。修復留痕：`docs/events/event_20260611_subagent_content_filter_false_success.md`。
- **Observing since**: 2026-06-11
- **Exit → closed/**: soak 數日內 content-filter 擊殺的 subagent 均正確回報 `status=content_filter`（不再 false success）
- **Regress → open**: 再次出現 content-filter 子代理被回報 success / 任務靜默丟失

## 現象

連續兩個 coding subagent 在數秒內被 provider content filter 擊殺，但 runtime 全程把它們當成正常完成：

| Subagent | 存活 | output tokens | tool calls | finish reason | 回報給 orchestrator |
|---|---|---|---|---|---|
| `ses_14c660225ffeWNwRKXbvSaG68k` | 18s | 3 | 0 | `content-filter` | `finished (status=success)` |
| `ses_14c650a03ffeETj45mlvIt1JRB` | ~5s | — | 0 | `content-filter` | `finished (status=success)` |

兩次使用幾乎相同的任務書（~4KB，內容為元件 MPN 清單 + 檔案路徑 + ingestion 指示，無任何敏感內容），高機率為 provider 過濾器 false positive。觸發特徵不明（供應商黑箱），但同 prompt 連殺兩次顯示具重現性。

## Bug 1（主要）：content-filter 無狀態映射，fall through 成 success

`PendingSubagentNotice` 的 status 枚舉：`success / error / canceled / rate_limited / quota_low / worker_dead / silent_kill`。

assistant message 的 `finish: "content-filter"` 不在映射表內 → 被當成 clean stop → 回報 `status=success`。

**影響**：一個 3-token、零 tool call、零產出的失敗任務被包裝成「完成」。orchestrator 若不主動 `read_subsession` 比對 elapsed/token 數，會直接採信並繼續流程——任務靜默丟失。本案是靠「18 秒不可能完成收料任務」的人為懷疑才抓到。

**期望行為**（擇一，建議前者）：
1. 新增 `content_filter` status，notice 帶 finish reason，讓 orchestrator 能決策（換 prompt 重派 / 換 model / 上報使用者）。
2. 至少映射為 `error` 並在 errorDetail 帶 `finish=content-filter`。

可加防線：subagent finish 時 `output_tokens < N && tool_calls == 0` 即不得標 success（廉價的 sanity gate，同時涵蓋其他異常 finish reason）。

## Bug 2：dispatch-first 契約被打破

第二次 dispatch 的 `task()` tool result 直接回傳 `Subagent ses_14c650a03ffe... completed successfully.`（同步完成語氣），而非標準的 `dispatched (jobId=...) Running in background`。疑似 worker 在 dispatch 返回前就已死亡，dispatch 路徑撞上已終結 session 時走了錯誤的回覆分支。

## Bug 3（同族，順帶）：daemon 3R 後殭屍 job 狀態不收斂

同一個 parent session 中，daemon 3R 把執行中的 subagent `ses_14cb70315ffewsUoMvc87iLeAX` 打斷後：
- `list_subagents` 永遠顯示該 job `status=running`（lastActivity 停在 3R 前，elapsedMs 持續增長）
- `cancel_task(jobId)` 回 `not_found`——runtime 已不認得這個 job，卻仍把它列在 running 清單

異常終結路徑（3R / content-filter / worker 猝死）的 job 狀態機都沒有收斂到終態，建議一併修：daemon 啟動時掃描 orphan job 記錄並標記 `worker_dead`。

## 重現

1. 對 coding subagent dispatch 一份會觸發 provider content filter 的 prompt（本案 prompt 存於 parent session `ses_14ceb2fceffehTP6rE3wuUb65y` 的 task 呼叫記錄，可直接重放）。
2. 觀察 PendingSubagentNotice：`status=success`。
3. `read_subsession` 確認 assistant message `finish: "content-filter"`、output tokens ≈ 3、零 tool call。

## 佐證

- 子 session 全文：`ses_14c660225ffeWNwRKXbvSaG68k`（step-finish reason=content-filter, tokens: output=3, cache write=133,627）
- bodesign event log：`event_search "content-filter"` → `feature/component_vault/event_2026-06-10_component-vault-thesmart-products-34-26-16156-chun_8mygu6`
