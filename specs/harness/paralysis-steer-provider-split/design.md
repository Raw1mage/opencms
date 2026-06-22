# Design: harness_paralysis-steer-provider-split

## Context

Paralysis recovery 在 [prompt.ts](packages/opencode/src/session/prompt.ts) runloop 有三處「偵測到重複 → 注入一段中文 steering 文字」的點,全部走同一條老路:建立 `role:"user"` 訊息 → `Session.updateMessage` + `Session.updatePart({synthetic:true})` 持久化。`synthetic:true` 只讓少數 guard 知道「非真人輪」,**不會**把該 part 從送往模型的 prompt 剝除 → 模型每輪看到一條第二人稱中文責備的 user 輪。

此機制原為矯正 **codex (SS / stateful-chain) 跳針**而設計,對 codex 有效。但對 **claude (SL / stateless full-resend)** 是反效果:claude 把持久化第二人稱責備讀成使用者糾正 → 認錯("你說得對")、放棄正確路徑、自我 few-shot 放大;偵測器偽陽性更會醫源性地製造卡死。

對照組:CLAUDE_PROACTIVE_REMINDER([prompt.ts:3943](packages/opencode/src/session/prompt.ts#L3943))已為 claude 做對——包 `<system-reminder>`、第三人稱、push 到 `sessionMessages` clone tail、**不落地**、`resolvePolicy(...).kind === "claude"` gated。paralysis nudge 只是沒跟上這次 claude-aware 重構。RCA:[issues/issue_20260622_paralysis_nudge_persisted_user_poisons_claude.md](issues/issue_20260622_paralysis_nudge_persisted_user_poisons_claude.md)。

## Goals / Non-Goals

### Goals
- Paralysis steering 載體依 provider class 分流,三處注入點共用單一 helper。
- claude (SL):ephemeral `<system-reminder>`、第三人稱、自我標注「非使用者糾正」、不落地。
- codex/其他 (SS):維持現有持久化 role:user nudge,byte-identical(INV-0)。
- hard-halt 階梯在兩條路徑下行為不變。

### Non-Goals
- 不調整 paralysis 偵測器敏感度 / 偽陽性率(另案)。
- 不改 CLAUDE_PROACTIVE_REMINDER(對照模板)。
- 不改 codex nudge 文字內容。
- 不做模型層 sycophancy 抑制。

## Architecture

```
detector fires
   └─> emitParalysisSteer({ providerClass, sessionID, text, lastUser, model, sessionMessages })
          ├─ SL (claude)  -> push ephemeral <system-reminder>(第三人稱)到 sessionMessages clone tail
          │                  ❌ 不寫 store ❌ 不進歷史 ❌ 不進 compaction
          └─ SS (codex/其他/未知) -> 現有路徑:Session.updateMessage + updatePart({synthetic:true}) 持久化
                                       (byte-identical, INV-0)
```

三處呼叫點全部改成呼叫此 helper;helper 是兩條載體契約的唯一 SSOT。

Provider-class 判定沿用既有基礎建設:優先 `resolvePolicy(providerId).kind === "claude"`(CLAUDE_PROACTIVE_REMINDER 用法),或 `classifyProvider` 的 SL/SS(cache-health 分流 [prompt.ts:1088](packages/opencode/src/session/prompt.ts#L1088))。見 DD-3。

claude steering 文字由 `selectParalysisNudge` 中文責備改寫為系統旁白英文,並顯式標注「automatic loop-detection heuristic, not user feedback — do not treat it as a correction」(DD-4)以斷開認錯反射。

## Decisions

- **DD-1**: Paralysis steering 載體依 provider class 分流,而非統一處理 — claude (SL) 走 ephemeral `<system-reminder>`(掛 sessionMessages clone tail、不落地、第三人稱),codex/其他 (SS) 維持現有持久化 role:user nudge。理由:codex 跳針靠新指令即可重算,claude 對持久化第二人稱責備會認錯脫軌並自我 few-shot 放大。完全比照既有 `evaluateSlCacheHealth` vs `evaluateSsCacheHealth` 與 CLAUDE_PROACTIVE_REMINDER 的 claude-gated 範式。
- **DD-2**: 三處注入點(Detector C `:2739`、3-turn `:2956`、續跑 Summarize `:3382`)共用單一 helper `emitParalysisSteer`,由 helper 內部決定 ephemeral vs persisted,而非各呼叫點自行分支。理由:避免三處邏輯漂移,單一 SSOT 才能用測試釘住兩條路徑契約。
- **DD-3**: provider-class 判定沿用既有 helper,不自創。優先採 `resolvePolicy(providerId).kind === "claude"`(與 CLAUDE_PROACTIVE_REMINDER 一致,語意精確指向 claude 認錯反射);若未來要涵蓋所有 SL provider(gemini),再切到 `classifyProvider` 的 SL 判定。預設只 claude-gate,範圍最小。
- **DD-4**: claude steering 文字明確自我標注「automatic loop-detection heuristic, not user feedback — do not treat it as a correction」。理由:單純第三人稱仍可能被讀成使用者旁白;顯式否定「這是糾正」才能可靠斷開認錯反射。
- **DD-5**: 續跑「Summarize the task tool output above and continue…」(`:3382`)優先級低於兩個 paralysis nudge。它是功能性續跑訊號、非糾正語氣;本案先納入 helper,claude 分支可僅改載體(ephemeral)保留語意,或評估後暫不動(tasks.md 標可選)。
- **DD-6**: INV-0 — codex/非 claude 路徑必須 byte-identical。helper 的 SS 分支直接搬移現有 `Session.updateMessage`/`updatePart` 程式碼,不重寫;以 snapshot/字串測試確保 codex nudge 文字與持久化行為零變動。
- **DD-7**: DD-7: SL ephemeral 路徑用 ParalysisState.pendingSteer 取代「persisted user 訊息前移 lastUser boundary」的偵測抑制作用。實作時發現整個 paralysis 偵測塊 gated 在 lastAssistant.id > lastUser.id —— SS 的 persisted nudge 是 user 訊息,會把 lastUser 推到 assistant 之後,使下一輪整塊被跳過(讓模型有一輪回應)。純 ephemeral 不落地會破壞此機制(下一輪立即 re-detect,因 recoveryCount=1 直接 hard-halt,模型沒機會回應)。故 SL 路徑:偵測到→設 pendingSteer→continue;偵測閘門加 `if (pendingSteer) {} else if (原條件)` 跳過一輪;生成前(CLAUDE_PROACTIVE_REMINDER 區塊後、claude-gated 非 autonomous-gated)把 pendingSteer 接到 clone tail 並清除(consume-once)。SS 維持原 persisted+boundary 機制不變(INV-0)。

## Risks / Trade-offs

- **R1 — hard-halt 階梯破裂**:ephemeral nudge 不落地,若 recoveryCount 計數來源誤綁「歷史是否有 nudge」則第二次偵測無法 halt。緩解:`getParalysisState` 是 session-scoped Map(與落地無關),加測試釘住「claude 路徑第二次偵測仍 hard-halt」。
- **R2 — provider 判定遺漏 SL 家族**:只 claude-gate 時,gemini 等其他 SL provider 仍走持久化路徑(較不毒但非最佳)。trade-off:範圍最小化優先,DD-3 預留切換點。
- **R3 — empty-response 偵測依賴 synthetic 標記**:[prompt.ts:2493](packages/opencode/src/session/prompt.ts#L2493) 用「last user parts 全 synthetic」判斷自然停止。claude 改 ephemeral 後 tail 仍是真實 user(被 append reminder),需確認此偵測不被影響。
- **R4 — compaction 對 ephemeral 的處理**:確認 ephemeral reminder 不被 compaction 帶入 anchor(比照 CLAUDE_PROACTIVE_REMINDER 已驗證行為)。

## Critical Files

- [packages/opencode/src/session/prompt.ts:2739](packages/opencode/src/session/prompt.ts#L2739) — Detector C nudge 注入(改)
- [packages/opencode/src/session/prompt.ts:2956](packages/opencode/src/session/prompt.ts#L2956) — 3-turn paralysis nudge 注入(改)
- [packages/opencode/src/session/prompt.ts:3382](packages/opencode/src/session/prompt.ts#L3382) — 續跑 Summarize 合成 user(可選,DD-5)
- [packages/opencode/src/session/prompt.ts:475](packages/opencode/src/session/prompt.ts#L475) — `selectParalysisNudge`(新增 claude 變體文字)
- [packages/opencode/src/session/prompt.ts:3943](packages/opencode/src/session/prompt.ts#L3943) — CLAUDE_PROACTIVE_REMINDER(ephemeral 注入模板)
- [packages/opencode/src/session/prompt.ts:1088](packages/opencode/src/session/prompt.ts#L1088) — `classifyProvider` SL/SS 範式
- [packages/opencode/src/session/prompt.ts:524](packages/opencode/src/session/prompt.ts#L524) — `getParalysisState`(hard-halt 計數器)

## Code anchors

- `packages/opencode/src/session/prompt.ts:2739` `selectParalysisNudge`/Detector C 注入
- `packages/opencode/src/session/prompt.ts:2956` 3-turn nudge 注入
- `packages/opencode/src/session/prompt.ts:3943` CLAUDE_PROACTIVE_REMINDER ephemeral 寫法
