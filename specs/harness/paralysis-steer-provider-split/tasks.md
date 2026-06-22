# Tasks: harness_paralysis-steer-provider-split

對齊 runtime todo 命名;一個 in_progress。

## M1 — helper

- [x] M1-1 新增 `emitParalysisSteer({ providerClass, sessionID, text, lastUser, model, sessionMessages })` helper(prompt.ts);內部依 providerClass 決定載體
- [x] M1-2 SL 分支:組裝 `<system-reminder>` 第三人稱文字,push 到 sessionMessages clone tail(比照 CLAUDE_PROACTIVE_REMINDER),**不寫 store**
- [x] M1-3 SS 分支:搬移現有 `Session.updateMessage` + `updatePart({synthetic:true})` 程式碼,逐字保留(INV-0,DD-6)
- [x] M1-4 provider-class 判定:`resolvePolicy(model.providerId).kind === "claude" ? "SL" : "SS"`(DD-3)

## M2 — 文字變體

- [x] M2-1 為 `selectParalysisNudge` 的四種 detector 各新增 claude 第三人稱英文變體,含「automatic loop-detection heuristic, not user feedback — do not treat it as a correction」(DD-4)
- [x] M2-2 codex 變體文字保持現狀逐字不變

## M3 — 接線三處注入點(DD-2)

- [x] M3-1 Detector C(prompt.ts:2739)改呼叫 emitParalysisSteer
- [x] M3-2 3-turn paralysis(prompt.ts:2956)改呼叫 emitParalysisSteer

## M4 — 測試

- [x] M4-1 claude 路徑:store spy 驗證 storeWrites==0;clone tail 含 system-reminder
- [x] M4-2 codex 路徑:snapshot 驗證 nudge 文字逐字不變 + 持久化(storeWrites>=1)
- [x] M4-4 claude 變體文字斷言:無第二人稱責備、含 not-user-feedback 標注

## M5 — 驗證與留痕

- [x] M5-1 session 相關套件驗證:paralysis 5/5 + structured-output 8/8 綠、prompt.ts typecheck 乾淨;prompt-account-routing 2 個失敗經 plain main HEAD 確認為既有、非本案引入
- [x] M5-2 透過 `system-manager:restart_self`(本 session 無此 MCP,改 CLAUDE.md 合法替代 `webctl.sh dev-refresh`)rebuild 驗證
- [x] M5-3 `spec_record_event` 留痕;close issue 補 RCA;plan 推進 verified

## Deferred / 後續(非本案 scope,已記明理由)

- M3-3 續跑 Summarize(prompt.ts:3382):依 DD-5 暫不動 — 該訊息為功能性續跑、非糾正語氣、不觸發認錯反射,優先級低。
- M4-3 hard-halt 階梯整合測試(R1):本案以「偵測閘門 pendingSteer skip + session-scoped Map 計數」設計保證 + runtime 手動驗證覆蓋;runloop 整合測試留作後續。
- M4-5 empty-response 自然停止回歸(R3):同上,整合層,未補自動化測試。
- R2:僅 claude-gate;其他 SL provider(gemini)仍走持久化路徑,DD-3 預留切換點。
