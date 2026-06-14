# Bug: Mobile repeatedly reset session content to blank after previous fix

## Status

- OBSERVING — 2026-06-11 使用者回饋「好像已經很久沒有這個問題了」；自 2026-06-05 回報後未再復現。期間相關修復（mobile reconnect/load-earlier、mobile drawer project switch 等，見 closed/）可能已間接覆蓋觸發路徑，但本 BR 無獨立 root-cause fix，故不直接 closed。
- Observing since: 2026-06-11
- Exit → closed/: 再 soak 數週 mobile 上無 blank reset 復現。
- Regress → open: 任一次 mobile session 內容再被 reset 成空白（屆時依本檔 Evidence Needed 蒐證）。
- Priority: High
- Type: Regression / RCA

## Background

使用者回報：行動裝置上反覆出現 session 內容被 reset 成空白的症狀。此問題先前修過，但實測仍未完全修好，屬 regression / incomplete fix。

## Symptom

- 在 mobile viewport / 行動裝置使用 session 時，session 內容會反覆 reset 或顯示為空白。
- 使用者描述為「返覆 reset session 內容為空白」。
- 上次相關修補後仍可復現，代表既有 fix 未覆蓋所有觸發路徑。

## Expected Behavior

- mobile session view 不應在 reconnect、navigation、project switch、drawer interaction、resume 或 state refresh 後變成空白。
- session content 應以 server/session storage 為權威重新 hydrate，而不是被 client-side empty state 覆蓋。

## Suspected Areas

- Mobile SSE reconnect / session status resync path。
- Session message hydration / load-earlier cursor path。
- Route navigation or project/session switch causing stale empty local state overwrite。
- Client store reset timing vs server data fetch timing race。
- Previous mobile reconnect/load-earlier fix may只處理部分空白情境。

## Related Issues / History

- `issues/closed/issue_20260602_mobile_reconnect_load_earlier_messages.md`
- `issues/closed/bug_20260518_runloop_message_id_scroll_anchor.md`
- `issues/closed/bug_20260518_session_repetition_loop.md`

## RCA Questions

1. 空白是 server 回傳 empty，還是 client store 被 reset？
2. blank 發生時 session message API / SSE / status API 的最新回應是什麼？
3. 是否只發生在 mobile drawer / project switching / reconnect / background-resume 後？
4. 是否與 message cursor、scroll anchor、load-earlier pagination 或 compaction anchor 有關？
5. 先前 fix 覆蓋的路徑與本次復發路徑是否不同？

## Evidence Needed

- Mobile reproduction steps。
- Blank 發生當下的 client console / server debug log / SSE reconnect records。
- Session id、route、是否剛切 project、是否剛背景恢復、是否剛 reconnect。
- API snapshot：`/session/:id/messages`、session status、client store state 差異。

## Acceptance Criteria

- 找出 mobile blank reset 的實際 root cause，不能只憑 symptom 猜測。
- 加入可觀測 checkpoint，能區分 server-empty 與 client-reset。
- 修復後 mobile reconnect/navigation/resume 不再把既有 session content 清成空白。
- 補 regression coverage 或最小可重現驗證路徑。
