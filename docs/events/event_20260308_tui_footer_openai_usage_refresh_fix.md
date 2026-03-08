# Event: TUI Footer OpenAI Usage Refresh Fix

Date: 2026-03-08
Status: Done

## 1. 需求

- 補回 TUI prompt footer 的 OpenAI 用量更新機制。
- 避免背景持續輪詢；只在使用中或真正需要顯示時更新。
- 加入 1 分鐘 refresh gate，降低用量 API 請求頻率。

## 2. 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260308_tui_footer_openai_usage_refresh_fix.md`

### OUT

- 不修改 OpenAI quota backend fetcher / storage schema
- 不新增全域 timer-based quota polling
- 不調整 Web prompt footer 行為

## 3. 任務清單

- [x] 設計 TUI quota refresh gate
- [x] 實作 on-demand + 1 minute refresh policy
- [x] 更新 architecture contract
- [x] 執行 targeted validation

## 4. Debug Checkpoints

### Baseline

- RCA 已確認：TUI footer 的 OpenAI quota 在 2026-03-08 refactor 後只綁 `quotaRefresh`，而 `quotaRefresh` 只由 assistant turn completion 驅動。
- 若首次 fetch 失敗或回 `null`，footer 不會自行恢復，除非再完成一次 assistant turn。
- 使用者額外要求：不要用固定背景輪詢補救，應改成「使用中才更新」並用 1 分鐘快取/節流。

### Execution

- 在 `prompt/index.tsx` 新增 `OPENAI_QUOTA_REFRESH_MIN_MS = 60_000`。
- 新增 `lastQuotaRefreshAt` signal，統一記錄最近一次 TUI footer 主動觸發 quota refresh 的時間。
- 新增 `currentQuotaFamily` 與 `requestOpenAIQuotaRefresh()`：
  - 只在當前 provider family = `openai` 時允許刷新
  - 若距離上次刷新未滿 60 秒，直接跳過
- 保留 `lastCompletedAssistant` 事件驅動，但改為走上述 gate。
- 額外加上一個 provider relevance effect：當使用者切到 OpenAI model、footer 真的需要顯示 OpenAI 用量時，允許做一次 on-demand hydrate；但仍受 60 秒 gate 保護。
- `footerTick` 定時器保留給 elapsed/account label，不再承擔 quota 輪詢責任。

### Validation

- `bunx tsc --noEmit -p packages/opencode/tsconfig.json`
  - 通過
- `bunx eslint packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - 通過
- gate scenario simulation（以目前實作的條件做狀態機驗證）
  - `switch to openai after idle >60s` => 觸發 refresh
  - `assistant completes within 60s` => 不觸發 refresh
  - `assistant completes after 61s` => 觸發 refresh
  - `switch away from openai` => 不觸發 refresh
  - `switch back to openai within 60s` => 不觸發 refresh
  - 結論：符合「使用中才更新 + 1 分鐘 gate」需求
- 程式碼層驗證：
  - `codexQuota` 仍使用既有 `getOpenAIQuotaForDisplay()`，未破壞 backend stale-while-refresh 流程
  - quota refresh 不再依賴固定 timer；只在 OpenAI footer relevant 時的初次 hydrate 或新 assistant turn 完成時觸發
  - 同一 TUI session 內最短 refresh 間隔為 60 秒，避免密集請求
- Architecture Sync: Updated
  - 已把 `docs/ARCHITECTURE.md` 的 TUI footer quota contract 改為 event-driven + 60s gate，並明確註記 footer timer 不做 quota polling
