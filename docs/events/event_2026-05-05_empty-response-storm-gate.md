# 2026-05-05 Empty-Response Compaction — Storm Prevention Gate

## 需求

- 使用者回報「compaction 風暴」：每說一句話就 compact 一次，使用率還很低也照樣壓縮。
- 必須定位觸發路徑、量化發生頻率、修補根因；不可只壓符號（例如拉長 cooldown）。

## 範圍 (IN/OUT)

- IN: [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts) empty-round 自療路徑加 context-usage 閘門；[packages/opencode/src/config/tweaks.ts](../../packages/opencode/src/config/tweaks.ts) 新增 `compaction_empty_response_floor` tweak。
- IN: 抽純函式 `evaluateEmptyResponseGate` 至 [prompt.ts](../../packages/opencode/src/session/prompt.ts) 並建立 [prompt.empty-response-gate.test.ts](../../packages/opencode/src/session/prompt.empty-response-gate.test.ts)。
- OUT: 不變更 `SessionCompaction.run` chain logic；不變更 `deriveObservedCondition` 判定；不變更 nudge 路徑；不修改其他 trigger（cache-aware / overflow / continuation-invalidated / stall-recovery）。

## RCA — 量化證據

| 指標 | 數值 | 來源 |
|---|---|---|
| 風暴 session 樣本 | `ses_20f43620fffevvUrOO7mL06l57` | 使用者目前接手中的 session |
| 總訊息數 | 2051 | `SELECT count(*) FROM messages` |
| `mode='compaction'` 訊息數 | 29 | 同上 |
| `finish IN ('unknown','other') AND tokens=0` 訊息數 | **24** | empty-round 觸發符 |
| 來自 empty-response 路徑的 compaction 比例（推估） | **~83%** (24/29) | 24 個 empty round → 24 次 self-heal compaction |

- 觸發點：[prompt.ts:1279](../../packages/opencode/src/session/prompt.ts#L1279)（修補前）`if (emptyRoundCount === 1 && !session.parentID)` 無條件呼叫 `SessionCompaction.run({observed: "empty-response"})`。
- 原 hotfix 設計（2026-04-29）出處：codex 在 context ~80-85% 時會吐空封包，當時的解法是「empty round → 強制 compact」當作 self-heal。註解明確寫 *"empirical data shows the dominant cause of an empty packet from codex is silent server-side context overflow — the dialog hits ~80-85% of nominal context"*。
- 缺陷：predicate 沒有 context-usage 閘門。任何造成 `finish=unknown/other` + 0 tokens 的瞬時故障（SSE 斷線、網路 5xx、provider stream 異常、stale OAuth）都會觸發破壞性 compact，即使當下使用率僅個位數百分比。
- 2026-05-05 早些時候的另一個 hotfix [prompt.ts:1284-1357](../../packages/opencode/src/session/prompt.ts#L1284-L1357)（user-message replay after anchor）只解了「壓縮後 user 提問被吞」的下游問題，沒處理觸發頻率。

## Decisions

- **閘門門檻 = 0.8**：對齊原 hotfix 註解的 80-85% 經驗值，覆蓋 codex silent overflow 的真實觸發窗口；低於此值的 empty round 走 nudge 路徑而非 compact。
- **抽純函式**：`evaluateEmptyResponseGate({used, window, floor})` 為純算術；可以單元測試覆蓋邊界（5% / 79.5% / 80% / 90%）與 bad input（window=0 / NaN / 負）。
- **使用 `contextBudgetSource` 為使用率來源**：empty round 的 `lastFinished` 自身 tokens 為 0，無法判斷使用率；改用 `findContextBudgetSource` 倒序找最近一個 `tokens.input > 0` 的 assistant turn 作為使用率快照來源。
- **新增 tweak 而非 hardcode**：依 [feedback_tweaks_cfg.md](../../../.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_tweaks_cfg.md) 規範，門檻寫進 `/etc/opencode/tweaks.cfg` 可不重啟動態調整。預設 0.8。
- **保留原 self-heal 完整路徑**：閘門通過時仍走 SessionCompaction.run + replay-user-message，不刪除 2026-05-05 早些時候已驗證的修補。
- **保留 nudge fallback**：閘門擋下 compaction 時，控制流自然 fall through 到 [prompt.ts:1359](../../packages/opencode/src/session/prompt.ts#L1359) 的 `"?"` + budget nudge（既有 path），不需新增 branch。
- **subagent 不受影響**：DD-12 規則「parent owns context management」維持；subagent empty round 永遠走 nudge，不進 compaction 閘門。

## XDG Backup

- 重啟 daemon 已套用本修補。XDG 白名單快照不額外建立（純 code-only 變更，不動 state/data layer）。

## Verification

- 新增測試 [prompt.empty-response-gate.test.ts](../../packages/opencode/src/session/prompt.empty-response-gate.test.ts) 7 case 全綠：
  - 5% / 79.5% / 80% (邊界) / 90% 各 1 條
  - bad input (window=0 / NaN / -1) 安全回 false
  - floor override (0.5 / 0.9) 行為正確
- 既有 `compaction.test.ts` / `prompt.observed-condition.test.ts` / `tweaks.test.ts` 共 54 條全綠；3 條 pre-existing fail（rebind / identity-drift）在 HEAD 上即為 fail，與本修補無關。
- Daemon restart 後（pid 3398162）`bun` 直接跑 TypeScript，閘門已生效。觀察 worker log 應出現 `"self-heal: empty round usage probe"` 行，欄位包含 `ratio` / `floor` / `overflowSuspected`。

## Behavior Diff

| 情境 | 修補前 | 修補後 |
|---|---|---|
| empty round @ ratio < 80% | compact + replay | nudge `"?"` |
| empty round @ ratio ≥ 80% | compact + replay | compact + replay（不變）|
| subagent empty round | nudge | nudge（不變）|
| empty round 2+ | 自然 stop | 自然 stop（不變）|

對 `ses_20f43620fffevvUrOO7mL06l57` 的歷史資料投影：83% 的 compaction（24/29）將被閘門擋下走 nudge。

## Commit

- `d7c6e3855 fix(session): gate empty-response self-heal compaction at 80% context floor`

## Follow-up Notes

- 觀察 24 小時：tail `worker-*.log` 過濾 `"empty round usage probe"`，統計 `overflowSuspected=true/false` 比例；若仍出現高頻 storm，回頭看 trigger 路徑（cache-aware / continuation-invalidated 是次嫌疑）。
- 若 8 條 pre-existing OPENCODE_SERVER_PASSWORD dead-branch 測試需要清理，另起 commit；本修補不擴大 scope。
- 若需動態調整門檻：`echo "compaction_empty_response_floor=0.85" >> /etc/opencode/tweaks.cfg`（hot-reload，不需重啟）。
