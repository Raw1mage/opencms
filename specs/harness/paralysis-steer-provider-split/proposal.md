# Proposal: harness_paralysis-steer-provider-split

## Why

- Paralysis 防卡死 guard 在偵測到重複行為時,把第二人稱中文責備("你連續 3 輪…停下來…換一個動作")以 `role:"user"` + `synthetic:true` **持久化**寫進 session,之後每輪被當成真實使用者輪送進模型。
- 這個機制當初是為了矯正 **codex (SS / stateful-chain) 的「跳針」**(原封不動重複同一 tool call)而設計,對 codex 有效:codex 沒有「被糾正就認錯」的反射,把那句話當成新指令重算即可。
- 同一招對 **claude (SL / stateless full-resend)** 是種毒:claude 被 RLHF 成「使用者糾正 = 地面真相」,反射性認錯("你說得對 / 你提醒得對")、放棄正確路徑、自我 few-shot 放大,且偵測器偽陽性會醫源性地製造出它想防的卡死狀態。
- repo 已知 codex/claude 對 steering 反應不同,並已為 CLAUDE_PROACTIVE_REMINDER 做對分流(ephemeral `<system-reminder>`、第三人稱、不落地、claude-gated)。paralysis nudge 只是沒跟上這次 claude-aware 重構。
- 來源:[issues/issue_20260622_paralysis_nudge_persisted_user_poisons_claude.md](issues/issue_20260622_paralysis_nudge_persisted_user_poisons_claude.md)

## Original Requirement Wording (Baseline)

- "我懷疑注入 nudge 這件事對 claude 而言是在種毒"
- "當初是為了矯正 codex 的跳針行為。不是針對 claude"
- "開 issue,再開 plan 做"

## Requirement Revision History

- 2026-06-22: initial draft created via plan-init.ts
- 2026-06-22: 依 RCA issue 填入有效需求(provider-class 分流)

## Effective Requirement Description

1. Paralysis steering 依 provider class 分流注入策略,共用單一注入 helper。
2. **claude (SL)**:走 ephemeral `<system-reminder>`、第三人稱、非糾正語氣、**不落地**(只掛 `sessionMessages` clone tail),不污染歷史、不進 compaction。
3. **codex (SS) / 其他既有路徑**:維持現有持久化 role:user nudge,行為 byte-identical(不回歸 codex 解藥)。
4. Paralysis recoveryCount / hard-halt 階梯在 claude ephemeral 路徑下仍須可靠觸發(ephemeral nudge 不在歷史,計數器為 session-scoped Map,須驗證不受影響)。

## Scope

### IN
- `packages/opencode/src/session/prompt.ts` 三處 paralysis nudge 注入點:Detector C(:2739)、3-turn(:2956)、續跑「Summarize…」(:3382)。
- 新增單一 helper(暫名 `emitParalysisSteer`)封裝「依 provider class 決定 ephemeral system-reminder vs 持久化 user」。
- provider-class 判定沿用既有 `resolvePolicy(...).kind === "claude"` / `classifyProvider` / `isSupportedProviderKey`。
- 單元測試:claude 路徑不落地、codex 路徑落地且文字不變、hard-halt 階梯不破。

### OUT
- 不調整 paralysis 偵測器本身的敏感度 / 偽陽性率(另案)。
- 不改 CLAUDE_PROACTIVE_REMINDER(已正確,作為對照模板)。
- 不改 codex nudge 的文字內容。

## Non-Goals

- 不做完整的 sycophancy 抑制(那是模型層面,非本案範圍)。
- 不重寫 paralysis recovery 階梯邏輯,只改「注入載體」。

## Constraints

- INV-0:codex / 非 claude 路徑必須 byte-identical(僅 claude 分支改變載體)。
- ephemeral 注入須與 CLAUDE_PROACTIVE_REMINDER 同 pattern(掛 clone、不持久化、不被 compaction 帶入)。
- Daemon lifecycle:測試/重啟僅能透過 `system-manager:restart_self`(AGENTS.md)。
- 變更須留痕 `docs/events/`(或 spec_record_event)。

## What Changes

- 三處 `role:"user"` + `Session.updateMessage`/`updatePart` 的 nudge 注入,改為呼叫 `emitParalysisSteer(providerClass, …)`。
- claude 分支:組裝 `<system-reminder>` 文字,push 到 clone tail(類似 CLAUDE_PROACTIVE_REMINDER),不寫 store。
- 非 claude 分支:維持原持久化路徑。

## Capabilities

### New Capabilities
- `emitParalysisSteer`: 單一注入點,依 provider class 決定 steering 載體(ephemeral vs persisted)與語氣。

### Modified Capabilities
- Paralysis recovery 注入:claude 下不再污染歷史;codex 下行為不變。

## Impact

- 影響:claude provider + autorun + 觸發 paralysis 的所有 session(行為品質、語氣、compaction 純淨度)。
- 程式:`packages/opencode/src/session/prompt.ts`(注入點 + helper)。
- 測試:`packages/opencode/test/session/` 新增 provider-class 分流測試。
- 文件:`docs/events/` 留痕;close issue 時補 RCA。
