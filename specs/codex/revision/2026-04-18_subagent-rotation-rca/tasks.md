# Tasks: subagent-rotation-rca

## Phase A — Instrument & Observe

- [ ] A.1 在 `processor.ts:1289` `RateLimitEscalationEvent` publish 前後加 log：`[rot-escalation] subagent publish session=<id> account=<tail> elapsed=0`
- [ ] A.2 在 `task.ts:480` parent `handleRateLimitEscalation` 收到 event 時 log：`[rot-escalation] parent recv session=<id> elapsed=<ms-from-publish>`
- [ ] A.3 在 `handleRateLimitFallback` 返回時 log：`[rot-escalation] parent fallback-done new-account=<tail> elapsed=<ms>`
- [ ] A.4 在 stdin `model_update` 發送 / 收到點 log：`[rot-escalation] stdin-send` / `[rot-escalation] stdin-recv`
- [ ] A.5 在 `ModelUpdateSignal.resolve()` / `wait()` 返回點 log 該次 wait 實際耗時
- [ ] A.6 `./webctl.sh dev-refresh`、觀察日常 log，至少採集一次自然觸發的 rotation 事件

## Phase B — Reproduce

- [ ] B.1 設計可重現條件：手動把某 codex 帳號設為 quota-exhausted（或用 mock）；觸發 subagent task
- [ ] B.2 確認 escalation chain 在無 parent 負載下 <1s 完成
- [ ] B.3 加 parent 負載（同時跑長 prompt）重測，量測延遲
- [ ] B.4 確認「同 request ID 兩次」是否為 UI 雙渲染：比對後端 log 該時間點的實際 HTTP 請求數

## Phase C — Root Cause Analysis

- [ ] C.1 根據 Phase A / B 數據寫 `design.md` 的 `## RCA Findings` 段落，列出：
  - 哪一段是瓶頸？（publish / parent-handle / fallback / stdin / resolve）
  - 是延遲問題還是正確性問題？
  - 是否為 race condition？（兩次 escalation、兩次 model_update 等）
  - UI 雙渲染的來源
- [ ] C.2 據此列出候選修復策略於 `design.md` 的 `## Fix Options` 段落
- [ ] C.3 與使用者確認採用哪個 fix option 再進 Phase D

## Phase D — Fix & Regression

- [ ] D.1 實作選定 fix
- [ ] D.2 加整合測試：subagent + quota-exhausted account → rotation 在 <1s 完成
- [ ] D.3 加整合測試：concurrent escalation 情境不會造成雙 model_update
- [ ] D.4 Phase A 的 debug log 精簡：保留有用欄位、去除 verbose

## Phase E — Close

- [ ] E.1 `docs/events/event_2026-04-18_subagent_rotation_rca.md` 記錄 RCA + fix
- [ ] E.2 `specs/codex/provider_runtime/design.md` 補 cross-reference
- [ ] E.3 Beta worktree merge + branch 刪除
