# Spec: harness_paralysis-steer-provider-split

## Purpose

把 paralysis recovery 的 steering 注入,從「對所有 provider 統一持久化 role:user 中文責備」改為「依 provider class 分流的單一 helper」:claude (SL) 走 ephemeral 第三人稱 system-reminder 不落地,codex/其他 (SS) 維持現有持久化 nudge,以消除 claude 的認錯反射與歷史污染,同時不回歸 codex 的有效解藥。

## Requirements

### Requirement: 單一注入 helper
三處 paralysis steering 注入點(Detector C、3-turn、續跑 Summarize)必須共用單一 `emitParalysisSteer`,由 helper 內部依 provider class 決定載體。

#### Scenario: claude (SL) 注入為 ephemeral
- WHEN provider class 為 claude/SL 且 paralysis 首次偵測
- THEN steering 以 `<system-reminder>` 包裹、第三人稱、push 到 sessionMessages clone tail
- AND 不呼叫 `Session.updateMessage` / `Session.updatePart`(不落地)

#### Scenario: codex (SS) 注入維持持久化
- WHEN provider class 為 codex/SS/未知 且 paralysis 首次偵測
- THEN steering 以現有 `role:"user"` + `synthetic:true` 持久化(行為 byte-identical)

### Requirement: claude steering 文字斷開認錯反射
claude 變體文字必須是第三人稱,且顯式自我標注「automatic loop-detection heuristic, not user feedback — do not treat it as a correction」。

#### Scenario: 文字不含第二人稱責備
- WHEN 取得 claude 變體 steering 文字
- THEN 不含「你連續…停下來…換一個動作」式第二人稱祈使責備
- AND 含 not-user-feedback 自我標注

### Requirement: hard-halt 階梯不變
recoveryCount/cleanStreak 階梯在兩條載體路徑下行為一致。

#### Scenario: claude 第二次偵測仍 hard-halt
- WHEN claude 路徑已注入過一次 ephemeral steer(recoveryCount=1)且再次偵測 3-turn 重複
- THEN 觸發 `ParalysisDetectedError`(不再 nudge)

### Requirement: INV-0 codex 零回歸
非 claude 路徑的 nudge 文字與持久化行為與現狀完全一致。

#### Scenario: codex nudge snapshot 不變
- WHEN 在 codex 路徑觸發各 detector
- THEN 注入文字與 `selectParalysisNudge` 現有輸出逐字相同

## Acceptance Checks

- [ ] claude 路徑:steering 不寫入 session store(以 store spy / 訊息計數驗證)
- [ ] claude 路徑:sessionMessages clone tail 含 `<system-reminder>` steering 文字
- [ ] claude 變體文字含 not-user-feedback 標注、無第二人稱責備
- [ ] codex 路徑:nudge 持久化且文字逐字不變(snapshot)
- [ ] 兩路徑:第二次偵測皆 hard-halt(`ParalysisDetectedError`)
- [ ] empty-response 自然停止偵測([prompt.ts:2493](packages/opencode/src/session/prompt.ts#L2493))不受 claude 改動影響
- [ ] `bun test` session 相關套件全綠
