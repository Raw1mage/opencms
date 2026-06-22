# Handoff: harness_paralysis-steer-provider-split

把 paralysis steering 注入依 provider class 分流:claude (SL) ephemeral 第三人稱 system-reminder 不落地、codex (SS) 維持持久化 nudge,共用單一 `emitParalysisSteer`。

## Execution Contract

- 範圍:`packages/opencode/src/session/prompt.ts` 三處注入點 + 一個 helper + claude 文字變體 + 測試。
- INV-0:codex/非 claude 路徑 byte-identical(DD-6);SS 分支直接搬移現有程式碼,不重寫。
- 只 claude-gate(`resolvePolicy(providerId).kind === "claude" ? "SL" : "SS"`,DD-3);其餘維持持久化。
- Daemon lifecycle:rebuild 僅透過 `system-manager:restart_self`,禁止自行 spawn/kill/restart。
- 進實作前備份 `~/.config/opencode/` 關鍵設定(CLAUDE.md XDG 規範)。
- 變更留痕 `docs/events/` 或 `spec_record_event`。

## Required Reads

1. [prompt.ts:2956](packages/opencode/src/session/prompt.ts#L2956)(3-turn nudge)、[:2739](packages/opencode/src/session/prompt.ts#L2739)(Detector C)、[:475](packages/opencode/src/session/prompt.ts#L475)(`selectParalysisNudge`)
2. [prompt.ts:3943](packages/opencode/src/session/prompt.ts#L3943)(CLAUDE_PROACTIVE_REMINDER — ephemeral 載體模板,直接照抄)
3. [prompt.ts:524](packages/opencode/src/session/prompt.ts#L524)(`getParalysisState` — 確認 hard-halt 不依賴落地,R1)
4. [prompt.ts:2493](packages/opencode/src/session/prompt.ts#L2493)(empty-response 自然停止偵測 — 確認不被 claude 改動影響,R3)
5. RCA:[issues/issue_20260622_paralysis_nudge_persisted_user_poisons_claude.md](issues/issue_20260622_paralysis_nudge_persisted_user_poisons_claude.md)

## Stop Gates In Force

- 實作完成 + 測試全綠 + `restart_self` 驗證 → 推進 verified。
- close RCA issue 須補 RCA 段並移至 `issues/closed/`。
- **graduate 由使用者觸發,勿自行 `plan_graduate`。**
- 任何 INV-0 回歸(codex nudge 文字/落地行為變動)= 硬停。

## Execution-Ready Checklist

- [ ] 已讀 Required Reads 全部
- [ ] 已備份 XDG 設定
- [ ] 確認 `resolvePolicy(...).kind` 對 claude 回傳 "claude"
- [ ] 確認 `getParalysisState` 為 session Map(與落地無關)
- [ ] test-vectors.json 的 TV-1..TV-5 已對映到 M4 測試
