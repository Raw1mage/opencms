# Mobile reconnect collapses active session into 「載入更早訊息」 repeatedly

## Summary

手機使用中，如果螢幕關閉、網路中斷或瀏覽器重新連回同一個正在工作的 session，原本可見的 session 內容會反覆被收折，只剩「載入更早訊息」提示。

## Impact

- 使用者在手機上無法穩定追蹤正在執行的 session。
- 點擊「載入更早訊息」後可以暫時展開內容。
- 只要有新訊息產生，先前展開的內容又會再次收折。
- 對長時間 autonomous run 特別嚴重，因為使用者會只看到「載入更早訊息」，看不到最新進度與上下文。

## Reproduction Steps

1. 在手機瀏覽器打開一個正在工作的 opencode session。
2. session 仍在產生或接收訊息時，關閉手機螢幕、切換網路，或讓連線暫時中斷。
3. 重新打開手機並回到同一個 session。
4. 觀察原本 session 內容被收折成「載入更早訊息」。
5. 點擊「載入更早訊息」展開內容。
6. 等待任何新訊息產生。
7. 觀察內容再次被收折，只剩「載入更早訊息」。

## Expected Behavior

- 手機重新連線後，active session 應保留可讀的目前上下文。
- 使用者手動展開 earlier messages 後，新訊息 append 不應重置展開狀態。
- 新訊息產生時，message list 不應重新套用錯誤的 pagination / compaction boundary。

## Actual Behavior

- reconnect 後 session 內容會被收折到「載入更早訊息」。
- 手動展開後，只要有新訊息產生，又會再次收折。
- 結果是手機畫面反覆看不到 active session 內容。

## Hypothesis

這看起來像 mobile reconnect 後的 message virtualization / pagination state 問題。可能是增量訊息更新時，client 重新套用了「earlier messages collapsed」邊界，卻沒有保留使用者已展開的 range 或 scroll state。

## Acceptance Criteria

- Mobile reconnect 不會把 active session 歷史內容強制收折到「載入更早訊息」。
- 點擊展開 earlier messages 後，新訊息 append 不會讓內容再次收折。
- 若系統需要保留 pagination，應只折疊真正較舊且不在 active viewport 的歷史訊息，不影響目前正在工作的 session 區段。

## Notes

- 原本誤發到 GitHub issue `Raw1mage/opencms#6`，已關閉；此檔才是正確 handoff 位置。

## Resolution — RESOLVED (2026-06-02, commit `4b8e124df`, deployed + mobile smoke-tested)

真因**不是** pagination/virtualization，而是 client 端視窗位移 `turnStart` 未隨陣列縮短重新夾緊：

- 手機重連（visibilitychange / online / SSE-reconnect）→ `onViewingResync` → `forceReload` → `loadMessages` 用 `reconcile()` 把 store 縮回 platform tail（mobile=20）。
- `turnStart`（`renderedUserMessages = msgs.slice(turnStart)` 的位移）只在 `[params.id, messagesReady()]` 變動時重算，**陣列縮短時不重算** → stale `turnStart >= 新長度` → `renderedUserMessages` 回傳空陣列 → timeline **變黑畫面**，只剩「載入更早訊息」。
- 使用者校正優先序：「上線看最新 OK、蓋掉舊的不是問題；痛點是正在看一半被抹成黑畫面」。eviction 砍 oldest-first、永遠留 cap 則，砍不到最新內容 → 黑畫面純是 `turnStart` 越界。

**修法**（[session.tsx](../packages/app/src/pages/session.tsx)）：
1. `renderedUserMessages`：`start >= msgs.length` 時回傳現有最新訊息，不再回 `emptyUserMessages` → 永不開天窗。
2. 新增 clamp effect：`visibleUserMessages` 縮短時把 `turnStart` 夾回 `max(0, len - turnInit)`，只往下調、不跟 backfill 打架。

**附帶修正**：LRU eviction 的「保護正在看的 session」原本對齊錯——`workspace.activeSessionId` 由 server 算，只在 `Session.Event.Created` 設 `active:true`，等於「該 directory 最後**建立**的 session」非「正在看的」。於是在 [event-reducer.ts](../packages/app/src/context/global-sync/event-reducer.ts) 加 route-level `_viewingSessionId`（`setViewingSession`/`clearViewingSession`，mount/切換設、navigate-away 清），併入 `buildProtectedSessionIds`。
